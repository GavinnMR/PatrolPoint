// server/algorithms/tsp.js
// Stage 4: Backtracking TSP with Dijkstra road-network distances — V2 backend.
// Pure ESM module — no browser dependencies, no side effects.
//
// V2 changes over V1:
//   • Distance matrix built from road network Dijkstra distances (not Euclidean Haversine).
//   • Nearest neighbor heuristic fallback when k > nearestNeighborFallbackThreshold (default 12).
//   • Returns pathSegments (full road-following coordinates per leg) for map rendering.
//   • dijkstraCache shared from Stage 3 — many pairs already cached on entry.
//   • Single-node zones handled here to produce road-accurate Dijkstra paths.
//
// haversineDistance, runDijkstra, reconstructPath, normalizedCacheKey imported from dijkstra.js.

import { runDijkstra, reconstructPath, normalizedCacheKey } from './dijkstra.js';

// ── Nearest neighbor heuristic ────────────────────────────────────────────────
// O(k²) greedy fallback. Always visits the nearest unvisited crime node from current.
// D[fromId][toId] — road network distance in meters.
function nearestNeighborTSP(startId, crimeNodeIds, D) {
    const unvisited = new Set(crimeNodeIds);
    const sequence  = [];
    let current     = startId;
    let totalDist   = 0;

    while (unvisited.size > 0) {
        let nearest     = null;
        let nearestDist = Infinity;
        for (const id of unvisited) {
            const d = D[current]?.[id] ?? Infinity;
            if (d < nearestDist) { nearestDist = d; nearest = id; }
        }
        if (!nearest) break; // remaining nodes unreachable — should not occur post-exclusion
        unvisited.delete(nearest);
        sequence.push(nearest);
        totalDist += nearestDist;
        current = nearest;
    }

    totalDist += D[current]?.[startId] ?? Infinity; // return leg
    return { sequence, totalDist };
}

// ── Backtracking TSP ──────────────────────────────────────────────────────────
// Exact solution — O(k!) worst case, tractable for k ≤ nearestNeighborFallbackThreshold.
// Pruning: discard any branch where accumulated >= bestCircuit.
function backtrackingTSP(startId, crimeNodeIds, D) {
    const k             = crimeNodeIds.length;
    let bestCircuit     = Infinity;
    let optimalSequence = [];

    function backtrack(currentId, accumulated, visited, route) {
        if (accumulated >= bestCircuit) return; // prune — cannot improve

        if (visited.size === k) {
            const returnDist   = D[currentId]?.[startId] ?? Infinity;
            const total        = accumulated + returnDist;
            if (total < bestCircuit) {
                bestCircuit     = total;
                optimalSequence = route.slice();
            }
            return;
        }

        for (const nodeId of crimeNodeIds) {
            if (visited.has(nodeId)) continue;
            const step = D[currentId]?.[nodeId] ?? Infinity;
            if (step === Infinity) continue; // unreachable — skip branch
            visited.add(nodeId);
            route.push(nodeId);
            backtrack(nodeId, accumulated + step, visited, route);
            route.pop();
            visited.delete(nodeId);
        }
    }

    backtrack(startId, 0, new Set(), []);
    return { sequence: optimalSequence, totalDist: bestCircuit };
}

// ── Main export ───────────────────────────────────────────────────────────────
// zones:           Array<Array<crimeNodeObj>> — zones[pi] = crime nodes for patrols[pi]
// patrols:         Array<{id, nodeId, lat, lng, color}> — Stage 2 output (S_star)
// multiNodeZones:  number[] — patrol indices with |Zi| > 1 (proceed to TSP)
// singleNodeZones: number[] — patrol indices with |Zi| = 1 (direct visit, still road-following)
// nodeMap:         { nodeId → {id, lat, lng} }
// adjacencyList:   road network adjacency list (full graph — all 3,613 nodes)
// dijkstraCache:   { [sourceId]: { distances, parents } } — shared from Stage 3, mutated in-place
// config:          CONFIG object — reads tsp.nearestNeighborFallbackThreshold and tsp.hullExteriorPenalty
// hull:            [{lat, lng}] CCW hull polygon — passed to penalized Dijkstra when penalty > 1
// options:         { pushProgress?: function }
//
// Hull exterior penalty: when config.tsp.hullExteriorPenalty > 1, TSP Dijkstra calls use a
// fresh local cache (not the shared Stage 3 cache) to avoid storing penalized distances that
// would corrupt future unpenalized lookups. The penalty discourages routes from leaving the hull.
//
// Return shape:
// {
//   status: 'success' | 'warning' | 'error',
//   message: string,
//   warnings: string[],
//   data: {
//     routes: [{
//       patrolId, patrolIndex, sequence: [{nodeId,lat,lng}],
//       circuitDistanceM, pathSegments: [[{lat,lng}]],
//       approximate, isEmpty, isSingleNode
//     }],
//     overlapEdges: [{ key, count }],
//     totalDijkstraCalls: number,
//     totalCacheHits: number,
//     traceLog: string[]
//   }
// }
export function runTSP(
    zones, patrols, multiNodeZones, singleNodeZones,
    nodeMap, adjacencyList, dijkstraCache, config, hull = null, options = {}
) {
    const { pushProgress = null, removedNodes = null } = options;
    const log       = [];
    const warnings  = [];
    const routes    = [];
    const edgeUsage = new Map(); // normalized edge key → count across all patrol routes
    const fallbackThreshold = config.tsp.nearestNeighborFallbackThreshold ?? 12;
    const exteriorPenalty   = config.tsp.hullExteriorPenalty ?? 1;

    // When penalty is active, use a fresh local cache so penalized distances don't
    // overwrite the unpenalized distances stored by Stage 3 in the shared cache.
    const penaltyActive   = exteriorPenalty > 1 && hull && hull.length >= 3;
    const effectiveCache  = penaltyActive ? {} : dijkstraCache;
    const effectiveMap    = penaltyActive ? nodeMap : null;
    const effectiveHull   = penaltyActive ? hull    : null;
    const effectivePenalty = penaltyActive ? exteriorPenalty : 1;

    if (penaltyActive) {
        log.push(`Hull exterior penalty active: ×${exteriorPenalty} on edges outside danger zone.`);
    }

    // Cache hit/miss counters
    let totalDijkstraCalls = 0;
    let totalCacheHits     = 0;

    // ── Inner helpers (closures — access nodeMap, adjacencyList, effectiveCache, edgeUsage) ──

    // Run Dijkstra with hit/miss tracking. Returns { distances, parents }.
    function trackedDijkstra(sourceId) {
        if (effectiveCache[sourceId]) {
            totalCacheHits++;
        } else {
            totalDijkstraCalls++;
        }
        return runDijkstra(sourceId, adjacencyList, effectiveCache, effectiveMap, effectiveHull, effectivePenalty, removedNodes);
    }

    // Build distance matrix D[sourceId][destId] for a set of node IDs.
    // Runs Dijkstra once per unique source (k+1 total for k crime nodes + patrol start).
    function buildDistanceMatrix(nodeIds) {
        const D = {};
        for (const sourceId of nodeIds) {
            if (D[sourceId]) continue; // already computed — duplicate node in set
            const { distances } = trackedDijkstra(sourceId);
            D[sourceId] = {};
            for (const destId of nodeIds) {
                D[sourceId][destId] = distances[destId] ?? Infinity;
            }
        }
        return D;
    }

    // Get road-following path IDs from fromId to toId using cached Dijkstra parents.
    // Caller must ensure Dijkstra from fromId is already in cache (via trackedDijkstra or buildDistanceMatrix).
    // Uses effectiveCache (which equals dijkstraCache when no penalty, or the local penalty cache).
    function getPathIds(fromId, toId) {
        if (fromId === toId) return [fromId];
        const cached = effectiveCache[fromId];
        if (!cached) return null;
        return reconstructPath(fromId, toId, cached.parents);
    }

    // Convert node ID path to {lat, lng} coordinates using nodeMap.
    function pathIdsToCoords(pathIds) {
        return pathIds.map(id => {
            const node = nodeMap[id];
            return { lat: node.lat, lng: node.lng };
        });
    }

    // Process one leg of a circuit: get path IDs, convert to coords, track edge usage.
    // Returns { coords: [{lat,lng}], noPath: boolean }.
    function processLeg(fromId, toId) {
        const pathIds = getPathIds(fromId, toId);

        if (!pathIds || pathIds.length === 0) {
            // Fallback to straight line — log, but don't fail
            return {
                coords: [
                    { lat: nodeMap[fromId].lat, lng: nodeMap[fromId].lng },
                    { lat: nodeMap[toId].lat,   lng: nodeMap[toId].lng   }
                ],
                noPath: true
            };
        }

        // Track edge usage for overlap detection using normalized numeric keys
        for (let i = 0; i + 1 < pathIds.length; i++) {
            const key = normalizedCacheKey(pathIds[i], pathIds[i + 1]);
            edgeUsage.set(key, (edgeUsage.get(key) ?? 0) + 1);
        }

        return { coords: pathIdsToCoords(pathIds), noPath: false };
    }

    // ── Single-node zones ─────────────────────────────────────────────────────
    // Route: si → c1 → si. Build road-following paths using Dijkstra.
    // Return leg (c1 → si) is explicit — never omitted.
    for (const pi of singleNodeZones) {
        const patrol    = patrols[pi];
        const crimeNode = zones[pi][0];
        const sId       = patrol.nodeId;
        const cId       = crimeNode.snappedNodeId;

        // Ensure Dijkstra from both endpoints is in cache before processLeg calls
        trackedDijkstra(sId);
        trackedDijkstra(cId);

        const distStoC = effectiveCache[sId].distances[cId] ?? Infinity;
        const distCtoS = effectiveCache[cId].distances[sId] ?? Infinity;
        const circuitDistanceM = (distStoC < Infinity ? distStoC : 0) +
                                 (distCtoS < Infinity ? distCtoS : 0);

        const leg1 = processLeg(sId, cId); // si → c1 (outbound)
        const leg2 = processLeg(cId, sId); // c1 → si (return leg — explicit)

        if (leg1.noPath) log.push(`Warning: no road path found ${sId} → ${cId} — using straight line.`);
        if (leg2.noPath) log.push(`Warning: no road path found ${cId} → ${sId} — using straight line.`);

        log.push(`Patrol ${patrol.id}: single-node circuit — ${sId} → ${cId} → ${sId}, distance: ${Math.round(circuitDistanceM)}m`);

        routes.push({
            patrolId:         patrol.id,
            patrolIndex:      pi,
            sequence: [
                { nodeId: sId, lat: patrol.lat,           lng: patrol.lng },
                { nodeId: cId, lat: crimeNode.snappedLat, lng: crimeNode.snappedLng },
                { nodeId: sId, lat: patrol.lat,           lng: patrol.lng }
            ],
            circuitDistanceM: Math.round(circuitDistanceM),
            pathSegments:     [leg1.coords, leg2.coords],
            approximate:      false,
            isEmpty:          false,
            isSingleNode:     true
        });
    }

    // ── Multi-node zones ──────────────────────────────────────────────────────
    for (const pi of multiNodeZones) {
        const patrol = patrols[pi];
        const zone   = zones[pi];
        const sId    = patrol.nodeId;

        log.push(`─── Patrol ${patrol.id}: ${zone.length} crime node(s) ───`);

        // Step 1: Build full distance matrix — k+1 single-source Dijkstra calls
        const allNodeIds = [sId, ...zone.map(c => c.snappedNodeId)];
        const D          = buildDistanceMatrix(allNodeIds);

        // Step 2: Remove unreachable crime nodes — if D[si][c] = Infinity, c is unreachable
        const reachable = zone.filter(c => {
            if ((D[sId]?.[c.snappedNodeId] ?? Infinity) === Infinity) {
                log.push(`Crime node ${c.crimeId} unreachable from patrol ${patrol.id} via road network — excluded from route.`);
                warnings.push(`Crime node ${c.crimeId} unreachable from patrol ${patrol.id} via road network — excluded from route.`);
                return false;
            }
            return true;
        });

        if (reachable.length === 0) {
            log.push(`Patrol ${patrol.id}: all crime nodes unreachable — patrol remains stationary.`);
            warnings.push(`All crime nodes unreachable from patrol ${patrol.id} — patrol remains stationary.`);
            routes.push({
                patrolId: patrol.id, patrolIndex: pi,
                sequence: [], circuitDistanceM: 0,
                pathSegments: [], approximate: false,
                isEmpty: true, isSingleNode: false
            });
            continue;
        }

        const crimeIds = reachable.map(c => c.snappedNodeId);
        const actualK  = crimeIds.length;

        // Step 3: TSP or nearest neighbor heuristic
        let sequence, totalDist, approximate = false;

        if (actualK === 2) {
            // k=2 special case: both visiting sequences produce identical circuit distance
            // on an undirected graph (si→A→B→si equals si→B→A→si by symmetry).
            sequence  = crimeIds.slice();
            totalDist = (D[sId]?.[crimeIds[0]] ?? 0) +
                        (D[crimeIds[0]]?.[crimeIds[1]] ?? 0) +
                        (D[crimeIds[1]]?.[sId] ?? 0);
            log.push(`Patrol ${patrol.id}: 2 crime nodes in zone — both visiting sequences are equivalent. First sequence selected.`);

        } else if (actualK > fallbackThreshold) {
            const result = nearestNeighborTSP(sId, crimeIds, D);
            sequence     = result.sequence;
            totalDist    = result.totalDist;
            approximate  = true;
            const msg    = `Patrol ${patrol.id}: zone size k=${actualK} exceeds threshold ${fallbackThreshold}. Using nearest neighbor heuristic — result is approximate, not guaranteed optimal.`;
            log.push(msg);
            warnings.push(msg);

        } else {
            const result = backtrackingTSP(sId, crimeIds, D);
            sequence     = result.sequence;
            totalDist    = result.totalDist;
            if (sequence.length === 0 && actualK > 0) {
                // Backtracking found no complete circuit — all paths blocked by Infinity
                log.push(`Patrol ${patrol.id}: backtracking found no complete circuit. Falling back to nearest neighbor.`);
                const fallback = nearestNeighborTSP(sId, crimeIds, D);
                sequence       = fallback.sequence;
                totalDist      = fallback.totalDist;
                approximate    = true;
                warnings.push(`Patrol ${patrol.id}: backtracking TSP found no feasible circuit — nearest neighbor fallback used.`);
            }
        }

        // Step 4: Build path segments for road-following rendering
        // Full circuit: si → seq[0] → seq[1] → ... → seq[k-1] → si
        // The return leg (seq[k-1] → si) is always included — never omitted.
        const fullCircuit  = [sId, ...sequence, sId];
        const pathSegments = [];

        for (let i = 0; i + 1 < fullCircuit.length; i++) {
            const leg = processLeg(fullCircuit[i], fullCircuit[i + 1]);
            pathSegments.push(leg.coords);
            if (leg.noPath) {
                log.push(`Warning: no road path found ${fullCircuit[i]} → ${fullCircuit[i + 1]} — using straight line.`);
            }
        }

        // Build sequence output with coordinates
        const seqWithCoords = [
            { nodeId: sId, lat: patrol.lat, lng: patrol.lng },
            ...sequence.map(nodeId => {
                const n = nodeMap[nodeId];
                return { nodeId, lat: n.lat, lng: n.lng };
            }),
            { nodeId: sId, lat: patrol.lat, lng: patrol.lng }
        ];

        // Trace log: full circuit with coordinates
        const circuitStr = fullCircuit.map(nid => {
            const n = nodeMap[nid];
            return `${nid} (${n?.lat?.toFixed(4)}, ${n?.lng?.toFixed(4)})`;
        }).join(' → ');
        log.push(`Patrol ${patrol.id}: ${approximate ? 'approx.' : 'optimal'} circuit: ${circuitStr}. Total: ${Math.round(totalDist < Infinity ? totalDist : 0)}m`);

        routes.push({
            patrolId:         patrol.id,
            patrolIndex:      pi,
            sequence:         seqWithCoords,
            circuitDistanceM: Math.round(totalDist < Infinity ? totalDist : 0),
            pathSegments,
            approximate,
            isEmpty:          false,
            isSingleNode:     false
        });

        if (typeof pushProgress === 'function') {
            pushProgress({ stage: 4, patrolId: patrol.id, circuitDistanceM: Math.round(totalDist < Infinity ? totalDist : 0) });
        }
    }

    // ── Overlap edges ─────────────────────────────────────────────────────────
    const overlapEdges = [];
    for (const [key, count] of edgeUsage) {
        if (count >= 2) overlapEdges.push({ key, count });
    }
    overlapEdges.sort((a, b) => b.count - a.count);

    const twoPatrolOverlaps    = overlapEdges.filter(e => e.count === 2).length;
    const threeOrMoreOverlaps  = overlapEdges.filter(e => e.count >= 3).length;

    // ── Summary ───────────────────────────────────────────────────────────────
    log.push('--- Stage 4 Summary ---');
    log.push(`Patrols with TSP routes (multi-node): ${multiNodeZones.length}`);
    log.push(`Patrols with direct visit (single-node): ${singleNodeZones.length}`);
    log.push(`Patrols stationary due to all unreachable nodes: ${routes.filter(r => r.isEmpty).length}`);
    log.push(`Total Dijkstra calls: ${totalDijkstraCalls}`);
    log.push(`Total cache hits: ${totalCacheHits}`);
    log.push(`Route overlap: ${twoPatrolOverlaps} edge(s) with 2 patrols, ${threeOrMoreOverlaps} edge(s) with 3+ patrols`);

    const allEmpty = routes.length > 0 && routes.every(r => r.isEmpty);
    const status   = allEmpty
        ? 'error'
        : warnings.length > 0 ? 'warning' : 'success';

    return {
        status,
        message: status === 'error'
            ? 'No reachable crime nodes found for any patrol. Check road network connectivity.'
            : status === 'warning'
                ? 'Patrol routes generated with warnings.'
                : 'Optimal patrol circuits generated successfully.',
        warnings,
        data: {
            routes,
            overlapEdges,
            totalDijkstraCalls,
            totalCacheHits,
            traceLog: log
        }
    };
}
