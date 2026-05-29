/* ============================================================
   Stage 4 — Backtracking TSP
   ============================================================ */

// computeTSP — find optimal closed-loop circuit for one patrol zone
//
// patrolIdx : 0-based patrol index (for log messages)
// si        : patrol position node { id, lat, lng }
// zone      : array of snapped crime nodes { id, lat, lng }
// nodeMap, adjacencyList : road network structures
// dijkstraCache : shared { [normalizedKey]: { distance, path } } — mutated in-place
// config    : CONFIG object
//
// Returns result object { status, message, warnings, data }
function computeTSP(patrolIdx, si, zone, nodeMap, adjacencyList, dijkstraCache, config) {
    const log = [];
    const warnings = [];
    const k = zone.length;

    if (k === 0) {
        return {
            status: 'success',
            message: `Patrol ${patrolIdx + 1}: empty zone — stationary.`,
            warnings,
            data: { emptyZone: true, dijkstraCalls: 0, cacheHits: 0, traceLog: log }
        };
    }

    if (k === 2) {
        log.push(`2 crime nodes in zone — both visiting sequences are equivalent. First sequence selected.`);
    }

    // nodes[0] = patrol si, nodes[1..k] = zone crime nodes
    const nodes = [si, ...zone];
    const sz = nodes.length; // k + 1

    // D[i][j]          = road distance from nodes[i] to nodes[j]
    // pathMatrix[i][j] = ordered node-ID array from nodes[i] to nodes[j]
    const D = Array.from({ length: sz }, () => new Array(sz).fill(Infinity));
    const pathMatrix = Array.from({ length: sz }, () => new Array(sz).fill(null));
    for (let i = 0; i < sz; i++) D[i][i] = 0;

    let dijkstraCalls = 0;
    let cacheHits = 0;

    // Single-source optimization: run Dijkstra once per source node
    for (let i = 0; i < sz; i++) {
        const src = nodes[i];

        // Collect j > i pairs not yet in cache
        const needsCompute = [];
        for (let j = i + 1; j < sz; j++) {
            const key = normalizeEdgeKey(src.id, nodes[j].id);
            if (dijkstraCache[key] !== undefined) {
                cacheHits++;
            } else {
                needsCompute.push(j);
            }
        }

        if (needsCompute.length > 0) {
            dijkstraCalls++;
            const { distances, parents } = runDijkstra(src.id, adjacencyList, nodeMap);

            for (const j of needsCompute) {
                const dest = nodes[j];
                const key = normalizeEdgeKey(src.id, dest.id);
                const path = reconstructPath(src.id, dest.id, parents);

                if (path && distances.get(dest.id) < Infinity) {
                    // Store path in smaller-numeric-ID → larger-numeric-ID direction
                    const srcNum = parseInt(src.id.slice(1), 10);
                    const destNum = parseInt(dest.id.slice(1), 10);
                    dijkstraCache[key] = {
                        distance: distances.get(dest.id),
                        path: srcNum < destNum ? path : [...path].reverse()
                    };
                } else {
                    dijkstraCache[key] = { distance: Infinity, path: null };
                }
            }
        }

        // Fill D and pathMatrix from cache for all (i, j) pairs
        for (let j = i + 1; j < sz; j++) {
            const key = normalizeEdgeKey(src.id, nodes[j].id);
            const entry = dijkstraCache[key];
            if (!entry) continue;

            D[i][j] = D[j][i] = entry.distance;

            if (entry.path) {
                const srcNum = parseInt(src.id.slice(1), 10);
                const destNum = parseInt(nodes[j].id.slice(1), 10);
                // Derive directional path from the stored smaller→larger path
                const pathItoJ = srcNum < destNum ? entry.path : [...entry.path].reverse();
                pathMatrix[i][j] = pathItoJ;
                pathMatrix[j][i] = [...pathItoJ].reverse();
            }
        }
    }

    // Identify unreachable crime nodes (D[0][i] === Infinity for i > 0)
    const reachable = [0]; // index 0 (si) always included
    for (let i = 1; i < sz; i++) {
        if (D[0][i] < Infinity) {
            reachable.push(i);
        } else {
            warnings.push(`Crime node unreachable from patrol position via road network — excluded from route.`);
            log.push(`Crime node ${nodes[i].id} (${nodes[i].lat.toFixed(4)}, ${nodes[i].lng.toFixed(4)}) unreachable from patrol ${patrolIdx + 1} — excluded.`);
        }
    }

    const reachableK = reachable.length - 1; // crime nodes only

    if (reachableK === 0) {
        return {
            status: 'warning',
            message: `Patrol ${patrolIdx + 1}: all crime nodes unreachable via road network.`,
            warnings,
            data: { emptyZone: true, dijkstraCalls, cacheHits, traceLog: log }
        };
    }

    // Compact D and pathMatrix over reachable indices
    const rSz = reachable.length;
    const Dr = Array.from({ length: rSz }, (_, ri) =>
        Array.from({ length: rSz }, (_, rj) => D[reachable[ri]][reachable[rj]])
    );
    const Pr = Array.from({ length: rSz }, (_, ri) =>
        Array.from({ length: rSz }, (_, rj) => pathMatrix[reachable[ri]][reachable[rj]])
    );
    const rNodes = reachable.map(i => nodes[i]);

    // Backtracking TSP: find permutation of crime node r-indices (1..reachableK)
    // minimizing total closed-loop circuit distance
    let bestCircuit = Infinity;
    let optimalPerm = [];

    function backtrack(currRIdx, accumulated, visited, route) {
        if (accumulated >= bestCircuit) return; // prune

        if (visited.size === reachableK) {
            const total = accumulated + Dr[currRIdx][0]; // return leg to si
            if (total < bestCircuit) {
                bestCircuit = total;
                optimalPerm = [...route];
            }
            return;
        }

        for (let c = 1; c <= reachableK; c++) {
            if (!visited.has(c)) {
                visited.add(c);
                route.push(c);
                backtrack(c, accumulated + Dr[currRIdx][c], visited, route);
                route.pop();
                visited.delete(c);
            }
        }
    }

    backtrack(0, 0, new Set(), []);

    // Build circuit: [0 (si), opt[0], opt[1], ..., opt[k-1]] as r-indices
    // legPaths[i] is path from circuitRIdxs[i] → circuitRIdxs[(i+1) % length],
    // with the final leg being the return from last crime node back to si
    const circuitRIdxs = [0, ...optimalPerm];
    const circuitNodes = circuitRIdxs.map(ri => rNodes[ri]);
    const legPaths = circuitRIdxs.map((ri, i) => {
        const nextRi = circuitRIdxs[(i + 1) % circuitRIdxs.length];
        return Pr[ri][nextRi];
    });

    // Trace log entry (spec format: nA (lat,lng) → nB (lat,lng) → ... → nA (lat,lng))
    const circuitStr = [...circuitNodes, rNodes[0]]
        .map(n => `${n.id} (${n.lat.toFixed(4)}, ${n.lng.toFixed(4)})`)
        .join(' → ');
    log.push(`Patrol ${patrolIdx + 1} optimal circuit: ${circuitStr}. Total: ${Math.round(bestCircuit)}m`);

    return {
        status: 'success',
        message: `Patrol ${patrolIdx + 1}: circuit computed. Distance: ${Math.round(bestCircuit)}m`,
        warnings,
        data: {
            circuitNodes, // [si, c_opt1, ..., c_optk] — node objects
            legPaths,     // parallel array; legPaths[i] is the road path for leg i (includes return leg)
            totalDistance: bestCircuit,
            dijkstraCalls,
            cacheHits,
            traceLog: log
        }
    };
}
