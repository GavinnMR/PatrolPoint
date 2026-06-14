// server/algorithms/zoneAssignment.js
// Stage 3: Zone Assignment — V2 backend implementation.
// Pure ESM module — no browser globals, no side effects.
//
// V2 additions over V1:
//   • Road network distances via Dijkstra for zone assignment (instead of Euclidean Haversine).
//   • Zone rebalancing: iteratively reassigns boundary crime nodes to reduce size imbalance.
//   • dijkstraCache shared with Stage 4 — mutated in-place via runDijkstra.
//
// haversineDistance and runDijkstra are imported from dijkstra.js — never reimplemented inline.

import { haversineDistance, runDijkstra } from './dijkstra.js';

// ── Hull diameter ─────────────────────────────────────────────────────────────
// Maximum Haversine distance between any two hull vertices — O(|hull|²).
// Hull typically has 3–20 vertices so this is negligible cost.
// Used as the hard cap for snapping search radius expansion.
function computeHullDiameter(hull) {
    let maxDist = 0;
    for (let i = 0; i < hull.length; i++) {
        for (let j = i + 1; j < hull.length; j++) {
            const d = haversineDistance(hull[i].lat, hull[i].lng, hull[j].lat, hull[j].lng);
            if (d > maxDist) maxDist = d;
        }
    }
    return maxDist;
}

// ── Silent snapping ───────────────────────────────────────────────────────────
// Snap a single crime node to the nearest valid candidate (intersection node inside hull).
// Bounding box pre-filter (expanded by eps) eliminates far candidates before Haversine.
// Search radius starts at config.snapping.initialSearchRadiusMeters (500m), expands by 50%
// each miss, capped at hullDiameterM.
// Returns { node, distanceM } or null if no candidate found within hull diameter.
function snapToNearestCandidate(crimeNode, validCandidates, hullDiameterM, config) {
    const eps = config.snapping.boundingBoxEpsilon;
    let searchRadiusM = config.snapping.initialSearchRadiusMeters;

    while (true) {
        const dLat = searchRadiusM / 111000;
        const dLng = searchRadiusM / (111000 * Math.cos(crimeNode.lat * Math.PI / 180));

        let bestNode = null;
        let bestDist = Infinity;

        for (const candidate of validCandidates) {
            if (candidate.lat < crimeNode.lat - dLat - eps || candidate.lat > crimeNode.lat + dLat + eps) continue;
            if (candidate.lng < crimeNode.lng - dLng - eps || candidate.lng > crimeNode.lng + dLng + eps) continue;
            const d = haversineDistance(crimeNode.lat, crimeNode.lng, candidate.lat, candidate.lng);
            if (d <= searchRadiusM && d < bestDist) {
                bestDist = d;
                bestNode = candidate;
            }
        }

        if (bestNode) return { node: bestNode, distanceM: bestDist };
        if (searchRadiusM >= hullDiameterM) return null;
        searchRadiusM = Math.min(searchRadiusM * 1.5, hullDiameterM);
    }
}

// ── Light rebalancing ─────────────────────────────────────────────────────────
// Default mode. Only fires on extreme imbalance: largest zone > 2× mean AND
// smallest < 0.5× mean. Moves only boundary nodes (within 10% equidistant
// between the two patrols). Max 10 iterations.
// Mutates zones array in-place.
function lightRebalanceZones(zones, distanceMatrix, log) {
    let iterations = 0;
    const MAX_ITER = 10;

    while (iterations < MAX_ITER) {
        const nonEmpty = zones
            .map((z, i) => ({ zone: z, idx: i }))
            .filter(({ zone }) => zone.length > 0);

        if (nonEmpty.length < 2) break;

        const total = nonEmpty.reduce((s, { zone }) => s + zone.length, 0);
        const mean  = total / nonEmpty.length;

        const largest  = nonEmpty.reduce((a, b) => b.zone.length > a.zone.length ? b : a);
        const smallest = nonEmpty.reduce((a, b) => b.zone.length < a.zone.length ? b : a);

        if (largest.zone.length <= 2 * mean || smallest.zone.length >= 0.5 * mean) break;

        let bestNode    = null;
        let bestNodeIdx = -1;
        let bestDist    = Infinity;

        for (let ni = 0; ni < largest.zone.length; ni++) {
            const node = largest.zone[ni];
            const dm   = distanceMatrix[node.snappedNodeId];
            if (!dm) continue;
            const dToLargest  = dm[largest.idx]  ?? Infinity;
            const dToSmallest = dm[smallest.idx] ?? Infinity;
            if (dToLargest === Infinity || dToSmallest === Infinity) continue;
            const maxD = Math.max(dToLargest, dToSmallest);
            if (maxD > 0 && Math.abs(dToLargest - dToSmallest) / maxD < 0.10) {
                if (dToSmallest < bestDist) {
                    bestDist    = dToSmallest;
                    bestNode    = node;
                    bestNodeIdx = ni;
                }
            }
        }

        if (!bestNode) break;

        largest.zone.splice(bestNodeIdx, 1);
        bestNode.roadDistToPatrol = bestDist;
        smallest.zone.push(bestNode);
        log.push(`Light rebalance iter ${iterations + 1}: reassigned ${bestNode.crimeId} from patrol ${largest.idx + 1} to patrol ${smallest.idx + 1}`);
        iterations++;

        const allSizes   = zones.map(z => z.length).filter(s => s > 0);
        const newMean    = allSizes.reduce((s, l) => s + l, 0) / allSizes.length;
        const newLargest = Math.max(...allSizes);
        if (newLargest <= 1.5 * newMean) break;
    }

    return iterations;
}

// ── Strong rebalancing ────────────────────────────────────────────────────────
// Opt-in mode. Iteratively moves nodes from overloaded zones to underloaded ones
// until all non-empty zones are within [floor(target), ceil(target)] nodes.
// Empty zones are excluded from the calculation and never filled.
// At each step picks the node in any overloaded zone with minimum road distance
// to any underloaded patrol — least-cost move. Mutates zones array in-place.
function strongRebalanceZones(zones, distanceMatrix, log) {
    const nonEmptyIndices = zones
        .map((_, i) => i)
        .filter(i => zones[i].length > 0);

    if (nonEmptyIndices.length < 2) return 0;

    const total      = nonEmptyIndices.reduce((s, i) => s + zones[i].length, 0);
    const target     = total / nonEmptyIndices.length;
    const ceilTarget = Math.ceil(target);
    const floorTarget = Math.floor(target);

    let iterations = 0;
    const MAX_ITER = total; // safety cap — can't need more moves than there are nodes

    while (iterations < MAX_ITER) {
        const overloaded  = nonEmptyIndices.filter(i => zones[i].length > ceilTarget);
        const underloaded = nonEmptyIndices.filter(i => zones[i].length < floorTarget);

        if (overloaded.length === 0 || underloaded.length === 0) break;

        // Find least-cost move: node in any overloaded zone closest to any underloaded patrol
        let bestNode    = null;
        let bestNodeIdx = -1;
        let bestFromIdx = -1;
        let bestToIdx   = -1;
        let bestDist    = Infinity;

        for (const fromIdx of overloaded) {
            for (let ni = 0; ni < zones[fromIdx].length; ni++) {
                const node = zones[fromIdx][ni];
                const dm   = distanceMatrix[node.snappedNodeId];
                if (!dm) continue;
                for (const toIdx of underloaded) {
                    const d = dm[toIdx] ?? Infinity;
                    if (d < bestDist) {
                        bestDist    = d;
                        bestNode    = node;
                        bestNodeIdx = ni;
                        bestFromIdx = fromIdx;
                        bestToIdx   = toIdx;
                    }
                }
            }
        }

        if (!bestNode) break;

        zones[bestFromIdx].splice(bestNodeIdx, 1);
        bestNode.roadDistToPatrol = bestDist;
        zones[bestToIdx].push(bestNode);
        log.push(`Strong rebalance iter ${iterations + 1}: reassigned ${bestNode.crimeId} from patrol ${bestFromIdx + 1} to patrol ${bestToIdx + 1} (road dist: ${Math.round(bestDist)}m)`);
        iterations++;
    }

    return iterations;
}

// ── Main export ───────────────────────────────────────────────────────────────
// incidents:        Array<{crimeId?, lat, lng}> — current incident coordinates
// patrols:          Array<{id, nodeId, lat, lng, color}> — Stage 2 output (S_star)
// validCandidates:  Array<{id, lat, lng}> — intersection nodes inside hull from Stage 1
// hull:             Array<{lat, lng}> — hull polygon vertices from Stage 1
// adjacencyList:    road network adjacency list — passed to Dijkstra
// dijkstraCache:    { [sourceId]: { distances, parents } } — shared with Stage 4, mutated in-place
// config:           CONFIG object — reads tsp.maxCrimeNodesPerZone, snapping.*
// options:          { bestRestartIndex?: number, removedNodes?: Set<string> } — Hill Climbing restart number for trace log
//
// Return shape:
// {
//   status: 'success' | 'warning' | 'error',
//   message: string,
//   warnings: string[],
//   data: {
//     zones:               Array<Array<crimeNodeObj>>,  // zones[pi] = crime nodes for patrols[pi]
//     emptyZones:          number[],  // 0-based patrol indices with empty zones
//     singleNodeZones:     number[],  // 0-based patrol indices with single-node zones
//     multiNodeZones:      number[],  // 0-based patrol indices proceeding to TSP
//     excludedCrimeNodes:  Array<crimeNodeObj & {excluded, reason}>,
//     avgSnappingDist:     number,    // meters, rounded to 1dp
//     maxSnappingDist:     number,    // meters, rounded to 1dp
//     snappedCount:        number,    // crime nodes successfully snapped (before dedup)
//     mergedCount:         number,    // crime nodes discarded by deduplication
//     euclideanFallbacks:  number,    // crime nodes assigned via Haversine fallback (road graph disconnected)
//     zeroDistWaypoints:   number,
//     cappedZonesCount:    number,
//     rebalanceIterations: number,
//     distanceMatrix:      { [snappedNodeId]: { [patrolIndex]: distanceMeters } },
//     traceLog:            string[]
//   }
// }
export function runZoneAssignment(
    incidents, patrols, validCandidates, hull,
    adjacencyList, dijkstraCache, config, options = {}
) {
    const { bestRestartIndex = null, removedNodes = null, snapCandidates = null } = options;
    const effectiveSnapCandidates = snapCandidates || validCandidates;
    const log      = [];
    const warnings = [];

    // ── Defensive check ───────────────────────────────────────────────────────
    if (!validCandidates || validCandidates.length === 0) {
        return {
            status:  'error',
            message: 'No valid patrol positions available. Please recalculate.',
            warnings,
            data: {
                zones: null, emptyZones: [], singleNodeZones: [], multiNodeZones: [],
                excludedCrimeNodes: [], avgSnappingDist: 0, maxSnappingDist: 0,
                snappedCount: 0, mergedCount: 0, zeroDistWaypoints: 0,
                cappedZonesCount: 0, rebalanceIterations: 0, distanceMatrix: {},
                traceLog: log
            }
        };
    }

    const n = patrols.length;
    log.push(`Zone assignment: ${n} patrol(s), ${incidents.length} incident(s)`);
    if (bestRestartIndex !== null) {
        log.push(`Zone assignment using final optimized patrol positions from Hill Climbing restart ${bestRestartIndex}`);
    }

    // ── Hull diameter ─────────────────────────────────────────────────────────
    const hullDiameterM = computeHullDiameter(hull);
    log.push(`Hull diameter: ${Math.round(hullDiameterM)}m (snapping search cap)`);

    // ── Normalize incident IDs ────────────────────────────────────────────────
    // Ensure every incident has a crimeId — assign sequential IDs if the frontend omits them.
    const numberedIncidents = incidents.map((inc, i) => ({
        crimeId: inc.crimeId || `CRIME-${String(i + 1).padStart(3, '0')}`,
        lat:     inc.lat,
        lng:     inc.lng
    }));

    // ── Silent snapping ───────────────────────────────────────────────────────
    // Visual marker stays at original clicked position — snapping is never shown to user.
    const snappedNodes       = [];   // all successfully snapped nodes (before dedup)
    const excludedCrimeNodes = [];   // crime nodes with no intersection within hull diameter
    let totalSnappingDist    = 0;
    let maxSnappingDist      = 0;

    log.push('--- Snapping ---');
    for (const inc of numberedIncidents) {
        const result = snapToNearestCandidate(inc, effectiveSnapCandidates, hullDiameterM, config);
        if (!result) {
            const msg = `Crime node ${inc.crimeId} at (${inc.lat.toFixed(6)}, ${inc.lng.toFixed(6)}) has no reachable road intersection inside the danger zone. Point excluded.`;
            log.push(msg);
            warnings.push(`Crime node at (${inc.lat.toFixed(6)}, ${inc.lng.toFixed(6)}) has no reachable road intersection inside the danger zone. Point excluded.`);
            excludedCrimeNodes.push({ ...inc, excluded: true, reason: 'no_reachable_intersection' });
            continue;
        }
        snappedNodes.push({
            crimeId:       inc.crimeId,
            lat:           inc.lat,
            lng:           inc.lng,
            snappedNodeId: result.node.id,
            snappedLat:    result.node.lat,
            snappedLng:    result.node.lng,
            snappingDist:  result.distanceM
        });
        totalSnappingDist += result.distanceM;
        if (result.distanceM > maxSnappingDist) maxSnappingDist = result.distanceM;
    }
    log.push(`Snapping: ${snappedNodes.length} snapped, ${excludedCrimeNodes.length} excluded (no nearby intersection)`);

    // ── Duplicate snapping deduplication ─────────────────────────────────────
    // Two crime nodes that snap to the same valid candidate are merged — keep first, discard rest.
    // Both visual markers remain on the map (frontend handles styling).
    log.push('--- Deduplication ---');
    const seenSnappedIds    = new Map(); // snappedNodeId → first crime node
    const deduplicatedNodes = [];
    let mergedCount         = 0;

    for (const node of snappedNodes) {
        if (seenSnappedIds.has(node.snappedNodeId)) {
            mergedCount++;
            log.push(`Crime node ${node.crimeId} merged with nearby incident at node ${node.snappedNodeId} - duplicate snapped position.`);
            warnings.push(`Crime node ${node.crimeId} merged with nearby incident at node ${node.snappedNodeId}.`);
        } else {
            seenSnappedIds.set(node.snappedNodeId, node);
            deduplicatedNodes.push(node);
        }
    }
    if (mergedCount > 0) {
        log.push(`Duplicate snapping: ${mergedCount} crime node(s) merged`);
    }

    let zeroDistWaypoints = 0;

    // ── Dijkstra pre-computation (V2) ─────────────────────────────────────────
    // Run Dijkstra once per unique snapped node ID — single-source gives distances to ALL nodes
    // including all patrol positions. Builds distanceMatrix[snappedNodeId][patrolIndex].
    // dijkstraCache is mutated in-place so Stage 4 benefits from these computed paths.
    log.push('--- Road Distance Pre-computation ---');
    const distanceMatrix   = {}; // snappedNodeId → { [patrolIndex]: distanceMeters }
    let dijkstraCacheHits  = 0;
    let dijkstraCacheMisses = 0;

    for (const node of deduplicatedNodes) {
        if (distanceMatrix[node.snappedNodeId]) continue; // already built for this source

        const wasCached = !removedNodes && !!dijkstraCache[node.snappedNodeId];
        wasCached ? dijkstraCacheHits++ : dijkstraCacheMisses++;

        const { distances } = runDijkstra(node.snappedNodeId, adjacencyList, dijkstraCache, null, null, 1, removedNodes);
        distanceMatrix[node.snappedNodeId] = {};
        for (let pi = 0; pi < n; pi++) {
            distanceMatrix[node.snappedNodeId][pi] = distances[patrols[pi].nodeId] ?? Infinity;
        }
    }
    log.push(`Dijkstra: ${deduplicatedNodes.length} source(s), ${dijkstraCacheHits} hit(s), ${dijkstraCacheMisses} miss(es)`);

    // ── Initial zone assignment ───────────────────────────────────────────────
    // Assign each crime node to patrol with minimum road network distance.
    // Euclidean Haversine fallback if all Dijkstra distances are Infinity (disconnected graph).
    // Strict < in comparison ensures lower patrol index wins on equal distance (tiebreaker).
    log.push('--- Initial Zone Assignment ---');
    const zones = Array.from({ length: n }, () => []);
    let euclideanFallbacks = 0;

    for (const node of deduplicatedNodes) {
        const dm        = distanceMatrix[node.snappedNodeId] || {};
        let minDist     = Infinity;
        let assignedIdx = -1;
        let allInfinity = true;

        for (let pi = 0; pi < n; pi++) {
            const d = dm[pi] ?? Infinity;
            if (d < Infinity) allInfinity = false;
            if (d < minDist) {
                minDist     = d;
                assignedIdx = pi;
            }
        }

        if (allInfinity) {
            // Haversine fallback — road network disconnected from all patrol positions
            euclideanFallbacks++;
            let haverMin = Infinity;
            assignedIdx  = 0;
            for (let pi = 0; pi < n; pi++) {
                const d = haversineDistance(node.snappedLat, node.snappedLng, patrols[pi].lat, patrols[pi].lng);
                if (d < haverMin) {
                    haverMin    = d;
                    assignedIdx = pi;
                }
            }
            log.push(`Crime node ${node.crimeId} (${node.lat.toFixed(6)}, ${node.lng.toFixed(6)}): all road network distances Infinity - Euclidean Haversine fallback → patrol ${patrols[assignedIdx].id} (straight-line dist: ${Math.round(haverMin)}m)`);
            warnings.push(`Crime node ${node.crimeId}: road network disconnected from all patrols - using straight-line distance for assignment.`);
            zones[assignedIdx].push({ ...node, roadDistToPatrol: haverMin, haversineFallback: true });
        } else {
            log.push(`Crime node ${node.crimeId} (${node.lat.toFixed(6)}, ${node.lng.toFixed(6)}) → patrol ${patrols[assignedIdx].id} (road dist: ${Math.round(minDist)}m)`);
            zones[assignedIdx].push({ ...node, roadDistToPatrol: minDist });
        }
    }

    log.push('Zone sizes after initial assignment: [' + zones.map(z => z.length).join(', ') + ']');

    // ── Zero distance waypoint detection (post-assignment) ────────────────────
    // Checked after assignment so "zero distance" is accurate: only fires when the crime node
    // snapped to its own assigned patrol's node, not any patrol's node.
    for (let pi = 0; pi < n; pi++) {
        for (const node of zones[pi]) {
            if (node.snappedNodeId === patrols[pi].nodeId) {
                zeroDistWaypoints++;
                log.push(`Crime node ${node.crimeId} already at patrol ${patrols[pi].id} position (${patrols[pi].nodeId}) - zero distance waypoint.`);
            }
        }
    }

    // ── Zone rebalancing ──────────────────────────────────────────────────────
    const useStrong = config.zoneAssignment?.strongRebalancing === true;
    log.push(`--- Rebalancing (${useStrong ? 'Strong' : 'Light'}) ---`);
    log.push('Zone sizes before rebalancing: [' + zones.map(z => z.length).join(', ') + ']');
    const rebalanceIterations = useStrong
        ? strongRebalanceZones(zones, distanceMatrix, log)
        : lightRebalanceZones(zones, distanceMatrix, log);
    if (rebalanceIterations > 0) {
        log.push(`${useStrong ? 'Strong' : 'Light'} rebalancing: ${rebalanceIterations} iteration(s) completed`);
    }
    log.push('Zone sizes after rebalancing: [' + zones.map(z => z.length).join(', ') + ']');

    // ── Zone cap enforcement ──────────────────────────────────────────────────
    // Hard limit of CONFIG.tsp.maxCrimeNodesPerZone per zone.
    // Keep the nearest nodes by road network distance; grey-flag the rest.
    log.push('--- Zone Cap ---');
    const maxNodes = config.tsp.maxCrimeNodesPerZone;
    let cappedZonesCount = 0;

    for (let pi = 0; pi < n; pi++) {
        if (zones[pi].length <= maxNodes) continue;

        // Sort ascending by road network distance to this patrol — keep nearest
        zones[pi].sort((a, b) => {
            const da = distanceMatrix[a.snappedNodeId]?.[pi] ?? Infinity;
            const db = distanceMatrix[b.snappedNodeId]?.[pi] ?? Infinity;
            return da - db;
        });

        const excluded = zones[pi].splice(maxNodes);
        cappedZonesCount++;

        for (const ex of excluded) {
            excludedCrimeNodes.push({ ...ex, excluded: true, reason: 'zone_cap', assignedPatrolIdx: pi });
        }
        const msg = `Zone for patrol ${patrols[pi].id} capped at ${maxNodes} nodes. ${excluded.length} node(s) excluded. Consider adding more patrols.`;
        log.push(msg);
        warnings.push(msg);
    }

    log.push('Zone sizes after cap: [' + zones.map(z => z.length).join(', ') + ']');

    // ── Zone classification ───────────────────────────────────────────────────
    log.push('--- Zone Classification ---');
    const emptyZones      = [];
    const singleNodeZones = [];
    const multiNodeZones  = [];

    for (let pi = 0; pi < n; pi++) {
        const size = zones[pi].length;
        if (size === 0) {
            emptyZones.push(pi);
            log.push(`Patrol ${patrols[pi].id}: empty zone - stationary deployment`);
        } else if (size === 1) {
            const crimeNode = zones[pi][0];
            const roadDist = distanceMatrix[crimeNode.snappedNodeId]?.[pi] ?? Infinity;
            const directDistM = roadDist < Infinity
                ? 2 * roadDist
                : 2 * haversineDistance(patrols[pi].lat, patrols[pi].lng, crimeNode.snappedLat, crimeNode.snappedLng);
            singleNodeZones.push(pi);
            log.push(`Patrol ${patrols[pi].id}: single node zone - direct visit route. Distance: ${Math.round(directDistM)}m`);
        } else {
            multiNodeZones.push(pi);
            log.push(`Patrol ${patrols[pi].id}: ${size} nodes - proceeding to TSP`);
        }
    }

    if (emptyZones.length > 0) {
        warnings.push(`${emptyZones.length} patrol(s) have no assigned crime nodes and will remain stationary.`);
    }

    // ── Aggregate snapping statistics ─────────────────────────────────────────
    // Computed over all successfully snapped nodes before deduplication — each represents a
    // real crime node regardless of whether it was merged.
    const snappedCountBeforeDedup = snappedNodes.length;
    const avgSnappingDist = snappedCountBeforeDedup > 0
        ? totalSnappingDist / snappedCountBeforeDedup
        : 0;

    // ── Trace summary block ───────────────────────────────────────────────────
    log.push('--- Stage 3 Summary ---');
    log.push(`Crime nodes processed: ${incidents.length}`);
    log.push(`Crime nodes excluded (no nearby intersection): ${excludedCrimeNodes.filter(e => e.reason === 'no_reachable_intersection').length}`);
    log.push(`Duplicate snapped nodes merged: ${mergedCount}`);
    log.push(`Zero distance waypoints: ${zeroDistWaypoints}`);
    log.push(`Average snapping distance: ${Math.round(avgSnappingDist)}m`);
    log.push(`Maximum snapping distance: ${Math.round(maxSnappingDist)}m`);
    for (let pi = 0; pi < n; pi++) {
        log.push(`Patrol ${patrols[pi].id}: ${zones[pi].length} node(s)`);
    }
    log.push(`Empty zones: ${emptyZones.length} patrol(s) stationary`);
    log.push(`Single node zones: ${singleNodeZones.length} patrol(s) direct visit`);
    log.push(`Multiple node zones: ${multiNodeZones.length} patrol(s) proceeding to TSP`);
    log.push(`Zones capped: ${cappedZonesCount} zone(s) reduced to ${maxNodes} nodes`);

    // ── Status determination ──────────────────────────────────────────────────
    let status = 'success';
    if (maxSnappingDist > 200) {
        warnings.push(`Maximum snapping distance (${Math.round(maxSnappingDist)}m) exceeds 200m. Some crime nodes are far from road intersections.`);
        status = 'warning';
    }
    if (
        emptyZones.length > 0 ||
        cappedZonesCount > 0 ||
        euclideanFallbacks > 0 ||
        mergedCount > 0 ||
        excludedCrimeNodes.some(e => e.reason === 'no_reachable_intersection')
    ) {
        if (status === 'success') status = 'warning';
    }

    log.push(`Stage 3 complete - status: ${status}`);

    return {
        status,
        message: status === 'error'
            ? 'Zone assignment failed.'
            : status === 'warning'
                ? 'Zone assignment complete with warnings.'
                : 'Zone assignment complete.',
        warnings,
        data: {
            zones,
            emptyZones,
            singleNodeZones,
            multiNodeZones,
            excludedCrimeNodes,
            avgSnappingDist:    Math.round(avgSnappingDist * 10) / 10,
            maxSnappingDist:    Math.round(maxSnappingDist * 10) / 10,
            snappedCount:       snappedCountBeforeDedup,
            mergedCount,
            euclideanFallbacks,
            zeroDistWaypoints,
            cappedZonesCount,
            rebalanceIterations,
            distanceMatrix,
            traceLog:           log
        }
    };
}
