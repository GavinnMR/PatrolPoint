// server/services/pipeline.js
// Pipeline orchestrator — runs all 4 algorithm stages sequentially.
// Sends WebSocket messages for every stage event (start, progress, complete, warning, error,
// pipeline_complete). Called by pipelineSocket.js.
//
// All algorithm stages are pure functions — this file coordinates them and handles state.

import { runConvexHull } from '../algorithms/convexHull.js';
import { runHillClimbing } from '../algorithms/hillClimbing.js';
import { runZoneAssignment } from '../algorithms/zoneAssignment.js';
import { runTSP } from '../algorithms/tsp.js';
import { verifyAll } from '../algorithms/verifier.js';
import { buildRoadDistMatrix } from '../algorithms/dijkstra.js';

// Derive deterministic 32-bit seed from incident coordinates.
// Incidents are sorted before hashing so add-order does not affect the seed.
// Same incident set → same seed → Hill Climbing produces identical results every run.
function deriveHCSeed(incidents) {
    const sorted = incidents.slice().sort((a, b) => a.lat - b.lat || a.lng - b.lng);
    let h = 2166136261; // FNV-1a offset basis
    for (const p of sorted) {
        const latInt = Math.round(p.lat * 1e6);
        const lngInt = Math.round(p.lng * 1e6);
        h = (Math.imul(h ^ latInt, 16777619)) >>> 0;
        h = (Math.imul(h ^ lngInt, 16777619)) >>> 0;
    }
    return h;
}

// Patrol color palette — identical to V1 and hillClimbing.js
const PATROL_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'
];

// ── DEFAULT_CONFIG ────────────────────────────────────────────────────────────
// All pipeline constants. Every algorithm reads from the merged config — never hardcoded.
export const DEFAULT_CONFIG = {
    hillClimbing: {
        restarts: 100,
        maxIterations: 1000,
        radiusMultiplier: 2,
        synchronousMode: false
    },
    convexHull: {
        areaThresholdDivisor: 100,
        outlierMultiplier: 2.5,
        collinearityEpsilon: 1e-10,
        includeOutliers: true
    },
    tsp: {
        maxCrimeNodesPerZone: 12,
        nearestNeighborFallbackThreshold: 12,
        hullExteriorPenalty: 1
    },
    zoneAssignment: {
        strongRebalancing: false
    },
    snapping: {
        boundingBoxEpsilon: 1e-7,
        initialSearchRadiusMeters: 500
    }
};

// Deep-merge user config into DEFAULT_CONFIG — user values override defaults per key.
function mergeConfig(userConfig) {
    return {
        hillClimbing:   { ...DEFAULT_CONFIG.hillClimbing,   ...(userConfig?.hillClimbing   || {}) },
        convexHull:     { ...DEFAULT_CONFIG.convexHull,     ...(userConfig?.convexHull     || {}) },
        tsp:            { ...DEFAULT_CONFIG.tsp,            ...(userConfig?.tsp            || {}) },
        zoneAssignment: { ...DEFAULT_CONFIG.zoneAssignment, ...(userConfig?.zoneAssignment || {}) },
        snapping:       { ...DEFAULT_CONFIG.snapping,       ...(userConfig?.snapping       || {}) },
        candidateNodes: userConfig?.candidateNodes ?? 'all'
    };
}

// Compute barangay bounding-box area in m² — used for the hull area threshold check.
// Uses dynamic longitude scale factor at bbox centroid latitude.
function computeBarangayAreaM2(bbox) {
    const centroidLat = (bbox.south + bbox.north) / 2;
    const lngScale    = 111000 * Math.cos(centroidLat * Math.PI / 180);
    return (bbox.north - bbox.south) * (bbox.east - bbox.west) * 111000 * lngScale;
}

// Yield control back to the event loop so buffered WebSocket sends can flush before
// the next stage begins. The added delay is typically 4–16 ms — imperceptible.
function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// Point-in-polygon Ray Casting — used to filter snap candidates to nodes inside the hull.
// Hull vertices are [{lat, lng}] in CCW order.
function pointInHull(lat, lng, hull) {
    let inside = false;
    const n = hull.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = hull[i].lng, yi = hull[i].lat;
        const xj = hull[j].lng, yj = hull[j].lat;
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ── Main pipeline runner ──────────────────────────────────────────────────────
//
// networkData:   full network from cache.js getOrFetchNetwork — shape:
//                { nodes (nodeMap), edges, adjacencyList, intersectionNodeIds, boundary,
//                  nodeCount, edgeCount, intersectionCount, bbox, fromCache }
//
// data:          compute message payload from the WebSocket client — shape:
//                { incidents, n, mode, config, barangay }
//
// pushMessage:   function(msgObj) — send a WebSocket message to the connected client.
//                Created by pipelineSocket.js so it already has the ws reference.
//
// isCancelled:   function() → boolean — returns true when the client disconnected or
//                sent a cancel message. Checked before every stage begins.
//
// previousState: { hull, validCandidates, incidents, hullAreaM2 } from the last pipeline
//                run on this WebSocket connection. Enables incremental hull update
//                (Stage 1 skips re-computation if all new incidents fit inside the old hull).
//
// Returns { previousState } — updated state for the next pipeline run on this connection.
export async function runPipeline(networkData, data, pushMessage, isCancelled, previousState = {}) {
    const pipelineStartMs = performance.now();
    const config          = mergeConfig(data.config);
    const { incidents, n, mode } = data;
    const removedNodes    = data.removedNodes && data.removedNodes.length > 0 ? new Set(data.removedNodes) : null;

    const {
        hull:            previousHull            = null,
        validCandidates: previousValidCandidates  = null,
        incidents:       previousIncidents        = null,
        hullAreaM2:      previousHullAreaM2       = null,
        candidateNodes:  previousCandidateNodes   = null
    } = previousState;

    // Build the networkData object that Stage 1 expects
    const barangayAreaM2       = computeBarangayAreaM2(networkData.bbox);
    const currentCandidateNodes = config?.candidateNodes ?? 'all';
    const useAllNodes           = currentCandidateNodes !== 'intersection';
    // If candidateNodes mode changed, cached validCandidates are from the wrong node set — discard them
    const effectivePrevCandidates = previousCandidateNodes !== null && previousCandidateNodes !== currentCandidateNodes
        ? null
        : previousValidCandidates;

    // All road nodes minus removed — always computed regardless of candidateNodes toggle.
    // Used for snap candidates in Stage 3 so crimes always attach to the nearest road node,
    // not just the nearest intersection node.
    const allNodesMap = removedNodes && removedNodes.size > 0
        ? Object.fromEntries(Object.entries(networkData.nodes).filter(([id]) => !removedNodes.has(id)))
        : networkData.nodes;

    // Patrol candidate nodes — controlled by candidateNodes toggle
    let filteredNodeMap;
    if (useAllNodes) {
        filteredNodeMap = allNodesMap;
    } else {
        const filteredIds = removedNodes
            ? networkData.intersectionNodeIds.filter(id => !removedNodes.has(id))
            : networkData.intersectionNodeIds;
        filteredNodeMap = Object.fromEntries(filteredIds.map(id => [id, networkData.nodes[id]]));
    }

    const networkDataForHull = {
        nodeMap:       filteredNodeMap,
        barangayAreaM2
    };

    // Track state to return for next run's incremental optimization
    let finalHull           = null;
    let finalValidCandidates = null;
    let finalHullAreaM2     = null;

    // ── Stage 1: Brute Force Convex Hull ─────────────────────────────────────
    if (isCancelled()) return { previousState };

    pushMessage({ type: 'stage_start', data: { stage: 1, name: 'Brute Force Convex Hull' } });
    const stage1StartMs = performance.now();

    let hull1Result;
    try {
        hull1Result = runConvexHull(incidents, n, config, networkDataForHull, {
            previousHull,
            previousValidCandidates: effectivePrevCandidates,
            previousIncidents,
            pushProgress: (progressData) => pushMessage({ type: 'stage_progress', data: progressData })
        });
    } catch (err) {
        pushMessage({ type: 'error', data: { stage: 1, message: `Stage 1 error: ${err.message}`, fatal: true } });
        return { previousState };
    }

    const stage1RuntimeMs = performance.now() - stage1StartMs;
    const s1Data          = hull1Result.data;

    // Forward all Stage 1 warnings to the client
    for (const w of (hull1Result.warnings || [])) {
        pushMessage({ type: 'warning', data: { stage: 1, message: w } });
    }

    // Send stage_complete regardless of status so the frontend can update the trace panel
    pushMessage({
        type: 'stage_complete',
        data: {
            stage: 1,
            result: {
                hull:                   s1Data.hull,
                hullArea:               s1Data.hullAreaM2,
                validCandidateCount:    s1Data.validCandidates ? s1Data.validCandidates.length : 0,
                outlierCount:           s1Data.outlierCount,
                filteredCount:          s1Data.filteredCount,
                outlierIndices:         s1Data.outlierIndices,
                validEdgesCount:        s1Data.validEdgesCount ?? null,
                linearHandlerTriggered: s1Data.linearHandler?.triggered ?? false,
                linearHandlerReason:    s1Data.linearHandler?.reason ?? null,
                windingReversed:        s1Data.windingReversed ?? null,
                rayCastStats:           s1Data.rayCastStats ?? null,
                skipped:                s1Data.skipped
            },
            trace:     { log: s1Data.traceLog },
            runtimeMs: stage1RuntimeMs
        }
    });

    await yieldToEventLoop();

    // ── Linear handler: pipeline stops after Stage 1 ──────────────────────────
    if (s1Data.linearHandler?.triggered) {
        const linearPositions = (s1Data.linearHandler.patrolPositions || []).map((pos, i) => ({
            id:     `s${i + 1}`,
            nodeId: null,  // linear handler places patrols geometrically — no road node
            lat:    pos.lat,
            lng:    pos.lng,
            color:  PATROL_COLORS[i % PATROL_COLORS.length]
        }));

        pushMessage({
            type: 'pipeline_complete',
            data: {
                hull:               null,
                patrols:            linearPositions,
                zones:              null,
                routes:             null,
                trace:              { linearHandler: true, message: hull1Result.message },
                totalRuntimeMs:     performance.now() - pipelineStartMs,
                verificationReport: null
            }
        });
        return { previousState };
    }

    // ── Stage 1 error (empty validCandidates or zero-area hull) ──────────────
    if (hull1Result.status === 'error') {
        pushMessage({ type: 'error', data: {
            stage: 1, message: hull1Result.message, fatal: true,
            nearestHighlights: hull1Result.data?.nearestHighlights ?? null
        }});
        return { previousState };
    }

    // Stage 1 success path — extract outputs
    const hull            = s1Data.hull;
    // When hull was skipped (incremental), hullAreaM2 is null — fall back to previousHullAreaM2
    const hullAreaM2      = s1Data.hullAreaM2 ?? previousHullAreaM2 ?? barangayAreaM2 * 0.01;
    const validCandidates = s1Data.validCandidates;

    finalHull            = hull;
    finalValidCandidates = validCandidates;
    finalHullAreaM2      = s1Data.hullAreaM2 ?? previousHullAreaM2;

    // Snap candidates: all road nodes inside the hull, independent of patrol placement toggle.
    // When toggle = 'all', validCandidates already covers all nodes — no extra work.
    // When toggle = 'intersection', filter the full node map through the hull via Ray Casting.
    const snapCandidates = useAllNodes
        ? validCandidates
        : Object.values(allNodesMap).filter(node => pointInHull(node.lat, node.lng, hull));

    // ── Road distance matrix — precomputed once, shared by Stage 2 and Stage 3 ─
    // Runs Dijkstra from each valid candidate. O(|candidates| × (V+E)logV).
    // Worst case ~914 candidates × ~90k ops ≈ 82M ops (~1-2s). Typical hull
    // covers far fewer candidates so cost is usually well under 1s.
    const matrixStartMs = performance.now();
    const roadDistMatrix = buildRoadDistMatrix(validCandidates, networkData.adjacencyList);
    const matrixMs = Math.round(performance.now() - matrixStartMs);
    console.log(`Road distance matrix: ${validCandidates.length} candidates, built in ${matrixMs}ms`);

    // ── Stage 2: Hill Climbing ────────────────────────────────────────────────
    if (isCancelled()) return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };

    pushMessage({ type: 'stage_start', data: { stage: 2, name: 'Hill Climbing' } });
    const stage2StartMs = performance.now();

    let hill2Result;
    try {
        hill2Result = runHillClimbing(validCandidates, n, hullAreaM2, config, {
            seed:            deriveHCSeed(incidents),
            pushProgress:    (progressData) => pushMessage({ type: 'stage_progress', data: progressData }),
            roadDistMatrix
        });
    } catch (err) {
        pushMessage({ type: 'error', data: { stage: 2, message: `Stage 2 error: ${err.message}`, fatal: true } });
        return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
    }

    const stage2RuntimeMs = performance.now() - stage2StartMs;
    const s2Data          = hill2Result.data;

    for (const w of (hill2Result.warnings || [])) {
        pushMessage({ type: 'warning', data: { stage: 2, message: w } });
    }

    pushMessage({
        type: 'stage_complete',
        data: {
            stage: 2,
            result: {
                patrols:              s2Data.patrols,
                bestMinPairwiseDist:  s2Data.bestMinPairwiseDist,
                bestRestart:          s2Data.bestRestart,
                restartsCompleted:    s2Data.restartsCompleted,
                confidence:           s2Data.confidence,
                cappedFrom:           s2Data.cappedFrom,
                bestSoFarCurve:       s2Data.bestSoFarCurve,
                convergenceRestart:   s2Data.convergenceRestart,
                redundancy:           s2Data.redundancy,
                matrixRuntimeMs:      matrixMs,
                matrixCandidateCount: validCandidates.length
            },
            trace:     { log: s2Data.traceLog },
            runtimeMs: stage2RuntimeMs
        }
    });

    await yieldToEventLoop();

    if (hill2Result.status === 'error') {
        pushMessage({ type: 'error', data: { stage: 2, message: hill2Result.message, fatal: true } });
        return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
    }

    const patrols = s2Data.patrols;

    // ── Stage 3: Zone Assignment ──────────────────────────────────────────────
    if (isCancelled()) return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };

    pushMessage({ type: 'stage_start', data: { stage: 3, name: 'Zone Assignment' } });
    const stage3StartMs = performance.now();

    // dijkstraCache is initialized here and shared with Stage 4 — many pairs computed
    // in Stage 3 are reused in Stage 4, avoiding redundant Dijkstra calls.
    const dijkstraCache = {};

    let zone3Result;
    try {
        zone3Result = runZoneAssignment(
            incidents, patrols, validCandidates, hull,
            networkData.adjacencyList, dijkstraCache, config,
            { bestRestartIndex: s2Data.bestRestart, removedNodes, snapCandidates }
        );
    } catch (err) {
        pushMessage({ type: 'error', data: { stage: 3, message: `Stage 3 error: ${err.message}`, fatal: true } });
        return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
    }

    const stage3RuntimeMs = performance.now() - stage3StartMs;
    const s3Data          = zone3Result.data;

    for (const w of (zone3Result.warnings || [])) {
        pushMessage({ type: 'warning', data: { stage: 3, message: w } });
    }

    pushMessage({
        type: 'stage_complete',
        data: {
            stage: 3,
            result: {
                zones:               s3Data.zones,
                patrols:             patrols,
                emptyZones:          s3Data.emptyZones,
                singleNodeZones:     s3Data.singleNodeZones,
                multiNodeZones:      s3Data.multiNodeZones,
                avgSnappingDist:     s3Data.avgSnappingDist,
                maxSnappingDist:     s3Data.maxSnappingDist,
                snappedCount:        s3Data.snappedCount,
                mergedCount:         s3Data.mergedCount,
                excludedCrimeNodes:  s3Data.excludedCrimeNodes,
                euclideanFallbacks:  s3Data.euclideanFallbacks  ?? 0,
                zeroDistWaypoints:   s3Data.zeroDistWaypoints   ?? 0,
                cappedZonesCount:    s3Data.cappedZonesCount    ?? 0,
                rebalanceIterations: s3Data.rebalanceIterations ?? 0,
                rebalanceMode:       s3Data.rebalanceMode       ?? 'light',
                dijkstraCalls:       s3Data.dijkstraCalls       ?? 0,
                dijkstraCacheHits:   s3Data.dijkstraCacheHits   ?? 0
            },
            trace:     { log: s3Data.traceLog },
            runtimeMs: stage3RuntimeMs
        }
    });

    await yieldToEventLoop();

    if (zone3Result.status === 'error') {
        pushMessage({ type: 'error', data: { stage: 3, message: zone3Result.message, fatal: true } });
        return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
    }

    const { zones, emptyZones, singleNodeZones, multiNodeZones } = s3Data;
    let routes = null;

    // ── Stage 4: Backtracking TSP — roaming mode only ─────────────────────────
    let tsp4Result;
    if (mode === 'roaming') {
        if (isCancelled()) return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };

        pushMessage({ type: 'stage_start', data: { stage: 4, name: 'Backtracking TSP' } });
        const stage4StartMs = performance.now();
        try {
            tsp4Result = runTSP(
                zones, patrols, multiNodeZones, singleNodeZones,
                networkData.nodes,         // nodeMap: { nodeId → {id, lat, lng} }
                networkData.adjacencyList, // full road network graph
                dijkstraCache,             // shared — Stage 3 cache hits benefit Stage 4
                config,
                hull,                      // CCW hull polygon — used by hull exterior penalty
                {
                    pushProgress: (progressData) => pushMessage({ type: 'stage_progress', data: progressData }),
                    removedNodes
                }
            );
        } catch (err) {
            pushMessage({ type: 'error', data: { stage: 4, message: `Stage 4 error: ${err.message}`, fatal: true } });
            return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
        }

        const stage4RuntimeMs = performance.now() - stage4StartMs;
        const s4Data          = tsp4Result.data;

        for (const w of (tsp4Result.warnings || [])) {
            pushMessage({ type: 'warning', data: { stage: 4, message: w } });
        }

        pushMessage({
            type: 'stage_complete',
            data: {
                stage: 4,
                result: {
                    routes:                    s4Data.routes,
                    overlapEdges:              s4Data.overlapEdges,
                    unreachableCrimeIds:       s4Data.unreachableCrimeIds,
                    totalDijkstraCalls:        s4Data.totalDijkstraCalls,
                    totalCacheHits:            s4Data.totalCacheHits,
                    totalSequenceAdjustments:  s4Data.totalSequenceAdjustments,
                    algorithmBreakdown:        s4Data.algorithmBreakdown
                },
                trace:     { log: s4Data.traceLog },
                runtimeMs: stage4RuntimeMs
            }
        });

        await yieldToEventLoop();

        if (tsp4Result.status === 'error') {
            pushMessage({ type: 'error', data: { stage: 4, message: tsp4Result.message, fatal: true } });
            return { previousState: { hull: finalHull, validCandidates: finalValidCandidates, incidents, hullAreaM2: finalHullAreaM2, candidateNodes: currentCandidateNodes } };
        }

        routes = s4Data.routes;
    }

    // ── Post-pipeline verification ────────────────────────────────────────────
    // Run verifyAll after all stages complete. Non-fatal if verifier itself crashes.
    // Pass only non-outlier incidents — outlier points were intentionally excluded from
    // hull computation and lie outside the hull, so verifyConvexHull would give a false
    // failure if raw incidents (which include outliers) were passed instead.
    let verificationReport = null;
    try {
        const outlierIndices = new Set(s1Data.outlierIndices || []);
        const incidentsForVerification = incidents.filter((_, i) => !outlierIndices.has(i));
        verificationReport = verifyAll({
            hull,
            incidents:          incidentsForVerification,
            patrols,
            validCandidates,
            zones,
            routes:             routes || [],
            dijkstraCache,
            tspCache:           tsp4Result?.data?.tspCache || dijkstraCache,
            excludedCrimeNodes: s3Data.excludedCrimeNodes || []
        });
    } catch (err) {
        console.error('Verifier error (non-fatal):', err.message);
    }

    // ── Pipeline complete ─────────────────────────────────────────────────────
    pushMessage({
        type: 'pipeline_complete',
        data: {
            hull,
            patrols,
            zones,
            routes,
            trace:              { stagesComplete: mode === 'roaming' ? 4 : 3 },
            totalRuntimeMs:     performance.now() - pipelineStartMs,
            verificationReport
        }
    });

    return {
        previousState: {
            hull:            finalHull,
            validCandidates: finalValidCandidates,
            incidents,
            hullAreaM2:      finalHullAreaM2,
            candidateNodes:  currentCandidateNodes
        }
    };
}
