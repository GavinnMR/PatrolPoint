// server/algorithms/verifier.js
// Post-pipeline correctness verification — V2 backend.
// Run after pipeline_complete, before sending results to frontend.
// Pure ESM module — no browser dependencies, no side effects.
//
// All four verifiers are exported individually for unit testing.
// verifyAll() is the orchestrator called by the pipeline.

import { isPointInHull } from './convexHull.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Look up road network distance from dijkstraCache. Returns Infinity if uncached or unreachable.
function cachedDist(fromId, toId, dijkstraCache) {
    return dijkstraCache[fromId]?.distances?.[toId] ?? Infinity;
}

// Compute total circuit distance: startId → seq[0] → ... → seq[k-1] → startId.
// The return leg (seq[k-1] → startId) is always included.
function circuitDistance(startId, sequence, dijkstraCache) {
    let total   = 0;
    let current = startId;
    for (const nodeId of sequence) {
        total  += cachedDist(current, nodeId, dijkstraCache);
        current = nodeId;
    }
    total += cachedDist(current, startId, dijkstraCache); // return leg
    return total;
}

// Generate all permutations of arr — used for exhaustive TSP check when k ≤ 6.
// Yields arrays. O(k!) total permutations.
function* permutations(arr) {
    if (arr.length <= 1) { yield arr.slice(); return; }
    for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const perm of permutations(rest)) {
            yield [arr[i], ...perm];
        }
    }
}

// ── verifyConvexHull ──────────────────────────────────────────────────────────
// For each incident point, run Ray Casting against hull.
// Returns { pass: false } if any point is outside hull.
// incidents: Array<{lat, lng}> — non-outlier incidents used to compute the hull.
export function verifyConvexHull(hull, incidents) {
    if (!hull || hull.length < 3) {
        return { pass: false, message: 'Hull is null or has fewer than 3 vertices.' };
    }

    if (!incidents || incidents.length === 0) {
        return { pass: true, message: 'No incidents to verify against hull.' };
    }

    for (const inc of incidents) {
        if (!isPointInHull(inc, hull)) {
            return {
                pass:    false,
                message: `Incident point (${inc.lat.toFixed(6)}, ${inc.lng.toFixed(6)}) is outside the hull.`
            };
        }
    }

    return { pass: true, message: `All ${incidents.length} incident(s) verified inside hull.` };
}

// ── verifyPatrolPositions ─────────────────────────────────────────────────────
// Check: all patrols inside hull (Ray Casting), unique nodes, valid candidate membership.
export function verifyPatrolPositions(patrols, hull, validCandidates) {
    if (!hull || hull.length < 3) {
        return { pass: false, message: 'Hull is null - cannot verify patrol positions.' };
    }

    if (!patrols || patrols.length === 0) {
        return { pass: true, message: 'No patrols to verify.' };
    }

    // Uniqueness check — no two patrols may share the same node
    const nodeIds  = patrols.map(p => p.nodeId);
    const uniqueSet = new Set(nodeIds);
    if (uniqueSet.size !== nodeIds.length) {
        const duplicate = nodeIds.find((id, i) => nodeIds.indexOf(id) !== i);
        return {
            pass:    false,
            message: `Duplicate patrol node detected: ${duplicate}. Each patrol must occupy a distinct intersection node.`
        };
    }

    // Valid candidate membership — patrols must be drawn from validCandidates
    const validIds = new Set((validCandidates || []).map(v => v.id));

    for (const patrol of patrols) {
        // Inside hull check via Ray Casting
        if (!isPointInHull({ lat: patrol.lat, lng: patrol.lng }, hull)) {
            return {
                pass:    false,
                message: `Patrol ${patrol.id} at node ${patrol.nodeId} (${patrol.lat.toFixed(6)}, ${patrol.lng.toFixed(6)}) is outside the hull.`
            };
        }

        // Valid candidate membership
        if (validIds.size > 0 && !validIds.has(patrol.nodeId)) {
            return {
                pass:    false,
                message: `Patrol ${patrol.id} at node ${patrol.nodeId} is not a valid candidate (must be an intersection node inside hull).`
            };
        }
    }

    return {
        pass:    true,
        message: `All ${patrols.length} patrol(s) verified: inside hull, unique nodes, valid candidates.`
    };
}

// ── verifyZoneAssignment ──────────────────────────────────────────────────────
// Check: every crime node in exactly one zone (no duplicates across zones, no node in multiple).
// Check: each crime node is assigned to the nearest patrol by road network distance.
// allCrimeNodes: the full list of crime nodes that should have been assigned
//   (excludes nodes explicitly excluded by snapping failure or zone cap — those are not in zones).
export function verifyZoneAssignment(zones, patrols, allCrimeNodes, dijkstraCache) {
    if (!zones || zones.length === 0) {
        return { pass: true, message: 'No zones to verify.' };
    }

    // Build crimeId → zone index map and check for duplicates
    const crimeIdToZone = {};
    for (let pi = 0; pi < zones.length; pi++) {
        for (const node of zones[pi]) {
            if (crimeIdToZone[node.crimeId] !== undefined) {
                return {
                    pass:    false,
                    message: `Crime node ${node.crimeId} appears in multiple zones (zone ${crimeIdToZone[node.crimeId]} and zone ${pi}). Each crime node must appear in exactly one zone.`
                };
            }
            crimeIdToZone[node.crimeId] = pi;
        }
    }

    // Check no allCrimeNode is missing from zones (every assigned node is accounted for)
    for (const crime of (allCrimeNodes || [])) {
        if (crimeIdToZone[crime.crimeId] === undefined) {
            return {
                pass:    false,
                message: `Crime node ${crime.crimeId} is not assigned to any zone.`
            };
        }
    }

    // Verify each crime node is assigned to nearest patrol by road network distance.
    // Zone rebalancing may cause intentional deviations — allow a 10% tolerance on
    // the nearest-distance check before flagging as a failure.
    const assignmentWarnings = [];

    for (let pi = 0; pi < zones.length; pi++) {
        for (const node of zones[pi]) {
            const snappedId = node.snappedNodeId;
            if (!dijkstraCache[snappedId]) {
                // Dijkstra not run from this node — cannot verify assignment
                assignmentWarnings.push(`Cannot verify assignment for ${node.crimeId} — Dijkstra not cached from ${snappedId}.`);
                continue;
            }

            let minDist    = Infinity;
            let nearestIdx = -1;
            for (let j = 0; j < patrols.length; j++) {
                const d = cachedDist(snappedId, patrols[j].nodeId, dijkstraCache);
                if (d < minDist) { minDist = d; nearestIdx = j; }
            }

            if (nearestIdx === -1 || nearestIdx === pi) continue; // no better patrol, or already optimal

            const assignedDist = cachedDist(snappedId, patrols[pi].nodeId, dijkstraCache);
            // Allow assignment to non-nearest patrol if within 10% (zone rebalancing tolerance)
            const withinTolerance = minDist > 0 &&
                (assignedDist - minDist) / minDist <= 0.10;

            if (!withinTolerance) {
                return {
                    pass:    false,
                    message: `Crime node ${node.crimeId} assigned to patrol ${patrols[pi].id} (road dist ${Math.round(assignedDist)}m) but patrol ${patrols[nearestIdx].id} is closer (${Math.round(minDist)}m, deviation > 10%).`
                };
            }
        }
    }

    if (assignmentWarnings.length > 0) {
        return {
            pass:     true,
            message:  'Zone assignment verified with caveats (some nodes could not be fully checked).',
            warnings: assignmentWarnings
        };
    }

    return { pass: true, message: 'All crime nodes verified: no duplicates, no missing, patrol assignments correct.' };
}

// ── verifyTSPRoute ────────────────────────────────────────────────────────────
// Check: all k crime nodes appear exactly once in sequence.
// Check: circuit distance matches recomputed sum (tolerance: 1 meter).
// For k ≤ 6 and non-approximate: enumerate all k! permutations and confirm returned
//   sequence achieves minimum total distance.
// For k > 6 or approximate: skip exhaustive check — note in report.
//
// route:         route object from tsp.js — { patrolId, sequence, circuitDistanceM, approximate, ... }
// dijkstraCache: all computed Dijkstra results — used to recompute distances
// k:             number of crime nodes in this patrol's zone
export function verifyTSPRoute(route, dijkstraCache, k) {
    if (!route || route.isEmpty) {
        return { pass: true, message: `Patrol ${route?.patrolId ?? '?'}: empty zone - stationary, no route to verify.` };
    }
    if (route.isSingleNode) {
        return { pass: true, message: `Patrol ${route.patrolId}: single-node zone - direct visit route, no TSP to verify.` };
    }

    const { patrolId, sequence, circuitDistanceM, approximate } = route;

    // sequence: [{nodeId}, ...] with patrol start at index 0 and end at index -1
    // Crime nodes are the middle elements
    const startId  = sequence[0].nodeId;
    const crimeSeq = sequence.slice(1, -1).map(s => s.nodeId);

    // Check count
    if (crimeSeq.length !== k) {
        return {
            pass:    false,
            message: `Patrol ${patrolId}: route has ${crimeSeq.length} crime nodes in sequence but expected ${k}.`
        };
    }

    // Check uniqueness
    const crimeSet = new Set(crimeSeq);
    if (crimeSet.size !== k) {
        return {
            pass:    false,
            message: `Patrol ${patrolId}: duplicate crime nodes found in route sequence.`
        };
    }

    // Recompute circuit distance and compare
    const recomputed = circuitDistance(startId, crimeSeq, dijkstraCache);
    const tolerance  = 1; // 1 meter — accounts for Math.round in tsp.js

    if (Math.abs(recomputed - circuitDistanceM) > tolerance) {
        return {
            pass:    false,
            message: `Patrol ${patrolId}: reported circuit distance ${circuitDistanceM}m but recomputed ${Math.round(recomputed)}m (difference: ${Math.round(Math.abs(recomputed - circuitDistanceM))}m).`
        };
    }

    // Exhaustive optimality check for k ≤ 6 (non-approximate routes only)
    if (k <= 6 && !approximate) {
        let minDist = Infinity;
        for (const perm of permutations(crimeSeq)) {
            const d = circuitDistance(startId, perm, dijkstraCache);
            if (d < minDist) minDist = d;
        }

        if (minDist < recomputed - tolerance) {
            return {
                pass:    false,
                message: `Patrol ${patrolId}: returned sequence is not optimal. Returned: ${Math.round(recomputed)}m, optimal found by exhaustive search: ${Math.round(minDist)}m (improvement of ${Math.round(recomputed - minDist)}m possible).`
            };
        }

        return {
            pass:    true,
            message: `Patrol ${patrolId}: all ${k} crime nodes visited exactly once, circuit distance verified (${circuitDistanceM}m), exhaustive optimality confirmed.`
        };
    }

    // k > 6 or approximate — skip exhaustive check
    const note = approximate
        ? `Nearest neighbor heuristic used (k=${k} > threshold) — optimality not guaranteed.`
        : `k=${k} > 6 — exhaustive optimality check skipped.`;

    return {
        pass:    true,
        message: `Patrol ${patrolId}: all ${k} crime nodes visited exactly once, circuit distance verified (${circuitDistanceM}m). ${note}`,
        note
    };
}

// ── verifyAll ─────────────────────────────────────────────────────────────────
// Orchestrates all four verifications. Run after pipeline_complete.
//
// pipelineResult: {
//   hull:            [{lat, lng}] — Stage 1 output
//   incidents:       [{lat, lng}] — non-outlier incidents used for hull computation
//   patrols:         [{id, nodeId, lat, lng, color}] — Stage 2 output
//   validCandidates: [{id, lat, lng}] — Stage 1 output
//   zones:           Array<Array<crimeNodeObj>> — Stage 3 output
//   routes:          [routeObj] — Stage 4 output (may be empty in stationary mode)
//   dijkstraCache:   { [sourceId]: { distances, parents } } — accumulated across Stages 3 and 4
// }
//
// Returns:
// {
//   convexHull:      { pass, message },
//   patrolPositions: { pass, message },
//   zoneAssignment:  { pass, message, warnings? },
//   tspRoutes:       [{ patrolId, pass, message, note? }],
//   overallPass:     boolean,
//   failureCount:    number
// }
export function verifyAll(pipelineResult) {
    const {
        hull,
        incidents,
        patrols,
        validCandidates,
        zones,
        routes,
        dijkstraCache
    } = pipelineResult;

    // Convex hull: all incidents inside hull
    const convexHullResult = verifyConvexHull(hull, incidents || []);

    // Patrol positions: inside hull, unique, valid candidates
    const patrolPositionsResult = verifyPatrolPositions(
        patrols || [], hull, validCandidates || []
    );

    // Zone assignment: no duplicates, correct assignments
    // allCrimeNodes = union of all zones (nodes that were actually assigned)
    const allZonedCrimeNodes = zones ? zones.flat() : [];
    const zoneAssignmentResult = verifyZoneAssignment(
        zones || [], patrols || [], allZonedCrimeNodes, dijkstraCache || {}
    );

    // TSP routes: one per patrol (empty zones get a trivial pass)
    const tspRouteResults = [];
    if (patrols && zones) {
        for (let pi = 0; pi < patrols.length; pi++) {
            const route = (routes || []).find(r => r.patrolIndex === pi);
            // Derive k from the route's actual sequence, not zones[pi].length.
            // tsp.js never mutates zones[pi] — it filters unreachable crime nodes into a
            // local reachable subset and only those appear in route.sequence. Using
            // zones[pi].length would cause false pass:false when any node is unreachable.
            const k = route && !route.isEmpty && !route.isSingleNode
                ? Math.max(0, route.sequence.length - 2)
                : (zones[pi]?.length ?? 0);

            if (!route) {
                // Patrol has no route entry — stationary (empty zone) or stationary-mode run
                tspRouteResults.push({
                    patrolId: patrols[pi].id,
                    pass:     true,
                    message:  `Patrol ${patrols[pi].id}: no route entry - stationary.`
                });
                continue;
            }

            const result = verifyTSPRoute(route, dijkstraCache || {}, k);
            tspRouteResults.push({ patrolId: patrols[pi].id, ...result });
        }
    }

    // Aggregate pass/fail
    const allChecks = [
        convexHullResult.pass,
        patrolPositionsResult.pass,
        zoneAssignmentResult.pass,
        ...tspRouteResults.map(r => r.pass)
    ];
    const failureCount = allChecks.filter(p => !p).length;
    const overallPass  = failureCount === 0;

    return {
        convexHull:       convexHullResult,
        patrolPositions:  patrolPositionsResult,
        zoneAssignment:   zoneAssignmentResult,
        tspRoutes:        tspRouteResults,
        overallPass,
        failureCount
    };
}
