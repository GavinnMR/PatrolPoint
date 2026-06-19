// test_tsp.js — comprehensive tests for server/algorithms/tsp.js
// Run: node test_tsp.js

import { runTSP } from './server/algorithms/tsp.js';
import { runDijkstra, normalizedCacheKey } from './server/algorithms/dijkstra.js';

const CFG = { tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12 } };

let pass = 0, fail = 0;
function ok(label, cond, got, want) {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else       { console.log(`  FAIL  ${label}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); fail++; }
}

// ── Shared fixtures ────────────────────────────────────────────────────────────

// Linear chain: n0─100─n1─100─n2─...
// All edges bidirectional, uniform weight 100.
function makeChain(length) {
    const nm = {}, adj = {};
    for (let i = 0; i < length; i++) {
        nm[`n${i}`]  = { id: `n${i}`, lat: 14.700 + i * 0.001, lng: 121.090 };
        adj[`n${i}`] = [];
        if (i > 0)          adj[`n${i}`].push({ neighborId: `n${i - 1}`, weight: 100 });
        if (i < length - 1) adj[`n${i}`].push({ neighborId: `n${i + 1}`, weight: 100 });
    }
    return { nm, adj };
}

// Diamond graph — n0(patrol) ─50─ n1 ─50─ n3 ─50─ n2, n0─500─n2 (costly direct edge)
// Road dist n0→n2 = 150 (via n1→n3); direct edge = 500; Euclidean ≈ 214 at lat 14.7.
// Optimal 3-crime circuit = 300m.
const diamondNM = {
    n0: { id: 'n0', lat: 14.700, lng: 121.090  },
    n1: { id: 'n1', lat: 14.700, lng: 121.0905 },
    n2: { id: 'n2', lat: 14.700, lng: 121.092  },
    n3: { id: 'n3', lat: 14.700, lng: 121.091  },
};
const diamondAdj = {
    n0: [{ neighborId: 'n1', weight:  50 }, { neighborId: 'n2', weight: 500 }],
    n1: [{ neighborId: 'n0', weight:  50 }, { neighborId: 'n3', weight:  50 }],
    n2: [{ neighborId: 'n3', weight:  50 }, { neighborId: 'n0', weight: 500 }],
    n3: [{ neighborId: 'n1', weight:  50 }, { neighborId: 'n2', weight:  50 }],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Distance matrix uses road network distances — not Euclidean
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 1] Distance matrix uses road network distances, not Euclidean');
{
    // n0→n2 road = 150m (n0→n1→n3→n2).
    // Direct edge n0-n2 = 500m. Euclidean ≈ 214m. TSP must produce 150m.
    const patrol = [{ id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: 14.700, snappedLng: 121.0905 },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: 14.700, snappedLng: 121.092  },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: 14.700, snappedLng: 121.091  },
    ];
    const cache  = {};
    const result = runTSP([[...crimes]], patrol, [0], [], diamondNM, diamondAdj, cache, CFG);

    const d_n0_n2 = cache['n0']?.distances?.['n2'];
    const d_n0_n1 = cache['n0']?.distances?.['n1'];
    const d_n0_n3 = cache['n0']?.distances?.['n3'];

    ok('D[n0][n2] = 150 (road via n1→n3, not 500 direct or ~214 Euclidean)',
       d_n0_n2 === 150, d_n0_n2, 150);
    ok('D[n0][n1] = 50 (direct edge weight)',
       d_n0_n1 === 50, d_n0_n1, 50);
    ok('D[n0][n3] = 100 (via n1)',
       d_n0_n3 === 100, d_n0_n3, 100);

    const route = result.data.routes[0];
    ok('circuitDistanceM = 300 (only achievable with road distances)',
       route?.circuitDistanceM === 300, route?.circuitDistanceM, 300);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Single-source optimization — exactly k+1 Dijkstra calls on cold cache
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 2] Single-source optimization: k+1 Dijkstra calls on cold cache');
{
    // k=3 crimes + 1 patrol start = 4 unique sources → exactly 4 Dijkstra calls.
    const { nm, adj } = makeChain(4);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const cache  = {};
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, cache, CFG);

    ok('totalDijkstraCalls === 4 (k+1 on cold cache)',
       result.data.totalDijkstraCalls === 4, result.data.totalDijkstraCalls, 4);
    ok('totalCacheHits === 0 (cold cache — no hits)',
       result.data.totalCacheHits === 0, result.data.totalCacheHits, 0);
    ok('cache has 4 entries after run (one per unique source)',
       Object.keys(cache).length === 4, Object.keys(cache).length, 4);
}

// ── Test 2b: Cache hits on pre-populated cache ────────────────────────────────
console.log('\n[Test 2b] Cache hits: 0 Dijkstra calls when cache fully pre-populated');
{
    const { nm, adj } = makeChain(4);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const cache = {};
    // Pre-warm all 4 sources
    ['n0', 'n1', 'n2', 'n3'].forEach(id => runDijkstra(id, adj, cache));

    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, cache, CFG);

    ok('totalDijkstraCalls === 0 (fully warm cache)',
       result.data.totalDijkstraCalls === 0, result.data.totalDijkstraCalls, 0);
    ok('totalCacheHits === 4 (all 4 sources cached)',
       result.data.totalCacheHits === 4, result.data.totalCacheHits, 4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Backtracking finds known optimal sequence
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 3] Backtracking finds known optimal sequence on hand-crafted graph');
{
    // Chain: n0─10─n1─20─n2─30─n3
    // D[n0][n1]=10, D[n0][n2]=30, D[n0][n3]=60
    // D[n1][n2]=20, D[n1][n3]=50, D[n2][n3]=30
    // All 6 permutations:
    //   n0→n1→n2→n3→n0 = 10+20+30+60 = 120  ← optimal (multiple sequences tie)
    //   n0→n2→n1→n3→n0 = 30+20+50+60 = 160
    //   n0→n3→n1→n2→n0 = 60+50+20+30 = 160
    //   n0→n1→n3→n2→n0 = 10+50+30+30 = 120
    //   n0→n2→n3→n1→n0 = 30+30+50+10 = 120
    //   n0→n3→n2→n1→n0 = 60+30+20+10 = 120
    // Optimal = 120m. Backtracking must NOT return 160m.
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
        n3: { id: 'n3', lat: 14.700, lng: 121.093 },
    };
    const adj = {
        n0: [{ neighborId: 'n1', weight: 10 }],
        n1: [{ neighborId: 'n0', weight: 10 }, { neighborId: 'n2', weight: 20 }],
        n2: [{ neighborId: 'n1', weight: 20 }, { neighborId: 'n3', weight: 30 }],
        n3: [{ neighborId: 'n2', weight: 30 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('status success', result.status === 'success', result.status, 'success');
    ok('approximate === false (exact backtracking)', route?.approximate === false, route?.approximate, false);
    ok('circuitDistanceM === 120 (optimal, not 160)', route?.circuitDistanceM === 120, route?.circuitDistanceM, 120);

    const seqIds = route?.sequence?.map(s => s.nodeId) ?? [];
    ok('sequence length === 5 (start + 3 crimes + return)', seqIds.length === 5, seqIds.length, 5);
    ok('sequence starts at patrol n0', seqIds[0] === 'n0', seqIds[0], 'n0');
    ok('sequence ends at patrol n0', seqIds[seqIds.length - 1] === 'n0', seqIds[seqIds.length - 1], 'n0');
    ok('n1 in sequence', seqIds.includes('n1'), seqIds, 'includes n1');
    ok('n2 in sequence', seqIds.includes('n2'), seqIds, 'includes n2');
    ok('n3 in sequence', seqIds.includes('n3'), seqIds, 'includes n3');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: Nearest neighbor fallback activates when k > threshold
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 4] Nearest neighbor fallback for k > nearestNeighborFallbackThreshold');
{
    // k=13 crime nodes > threshold=12 → NN fallback, approximate=true.
    // Linear chain n0(patrol), n1..n13 (crimes).
    const nm = {}, adj = {};
    for (let i = 0; i <= 13; i++) {
        nm[`n${i}`]  = { id: `n${i}`, lat: 14.700, lng: 121.090 + i * 0.001 };
        adj[`n${i}`] = [];
        if (i > 0)  adj[`n${i}`].push({ neighborId: `n${i - 1}`, weight: 100 });
        if (i < 13) adj[`n${i}`].push({ neighborId: `n${i + 1}`, weight: 100 });
    }
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = Array.from({ length: 13 }, (_, i) => ({
        crimeId: `C${i + 1}`, snappedNodeId: `n${i + 1}`,
        snappedLat: nm[`n${i + 1}`].lat, snappedLng: nm[`n${i + 1}`].lng,
    }));
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('approximate === true (NN fallback activated)', route?.approximate === true, route?.approximate, true);
    ok('status === warning (NN is non-exact)',
       result.status === 'warning', result.status, 'warning');
    ok('warning mentions "nearest neighbor"',
       result.warnings.some(w => w.toLowerCase().includes('nearest neighbor')),
       result.warnings.length, '>0');
    ok('warning mentions "approximate"',
       result.warnings.some(w => w.toLowerCase().includes('approximate')),
       result.warnings.length, '>0');

    // NN must produce a valid closed-loop circuit visiting all 13 nodes exactly once
    const seqIds   = route?.sequence?.map(s => s.nodeId) ?? [];
    const midIds   = seqIds.slice(1, -1);
    const uniqueMid = new Set(midIds);
    ok('sequence: patrol + 13 crimes + patrol = 15 entries', seqIds.length === 15, seqIds.length, 15);
    ok('sequence starts at patrol n0', seqIds[0] === 'n0', seqIds[0], 'n0');
    ok('sequence ends at patrol n0', seqIds[seqIds.length - 1] === 'n0', seqIds[seqIds.length - 1], 'n0');
    ok('all 13 crime nodes appear exactly once (no duplicates, none missing)',
       uniqueMid.size === 13, uniqueMid.size, 13);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: Return leg present in pathSegments — multi-node zone
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 5] Return leg in pathSegments (multi-node, k=2)');
{
    // Chain n0─100─n1─100─n2. k=2 crimes at n1,n2.
    // fullCircuit = [n0,n1,n2,n0] → 3 segments; segment[2] is the return leg n2→n0.
    const { nm, adj } = makeChain(3);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('pathSegments.length === 3 (n0→n1, n1→n2, n2→n0)',
       route?.pathSegments?.length === 3, route?.pathSegments?.length, 3);

    const returnSeg = route?.pathSegments?.[2];
    const firstRet  = returnSeg?.[0];
    const lastRet   = returnSeg?.[returnSeg.length - 1];

    ok('return leg starts at last crime (n2)',
       firstRet?.lat === nm.n2.lat && firstRet?.lng === nm.n2.lng,
       `${firstRet?.lat},${firstRet?.lng}`, `${nm.n2.lat},${nm.n2.lng}`);
    ok('return leg ends at patrol position (n0)',
       lastRet?.lat === nm.n0.lat && lastRet?.lng === nm.n0.lng,
       `${lastRet?.lat},${lastRet?.lng}`, `${nm.n0.lat},${nm.n0.lng}`);
}

// ── Test 5b: Return leg — single-node zone ────────────────────────────────────
console.log('\n[Test 5b] Return leg in pathSegments (single-node zone)');
{
    // Chain n0─100─n1─100─n2. Crime at n2 only (single-node zone).
    // pathSegments[0] = outbound n0→n2; pathSegments[1] = return n2→n0.
    const { nm, adj } = makeChain(3);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crime   = [{ crimeId: 'C1', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng }];
    const result  = runTSP([[...crime]], patrol, [], [0], nm, adj, {}, CFG);
    const route   = result.data.routes[0];

    ok('isSingleNode === true', route?.isSingleNode === true, route?.isSingleNode, true);
    ok('pathSegments.length === 2 (outbound + return)',
       route?.pathSegments?.length === 2, route?.pathSegments?.length, 2);

    const returnSeg = route?.pathSegments?.[1];
    const lastRet   = returnSeg?.[returnSeg.length - 1];
    ok('return leg ends at patrol position (n0)',
       lastRet?.lat === nm.n0.lat && lastRet?.lng === nm.n0.lng,
       `${lastRet?.lat},${lastRet?.lng}`, `${nm.n0.lat},${nm.n0.lng}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: pathSegments follow actual road edges (no straight-line shortcuts)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 6] pathSegments follow actual road edges (no shortcuts through buildings)');
{
    // Diamond graph. Optimal circuit [n0,n1,n2,n3,n0].
    // Leg n1→n2 must go via n3 (3 nodes: n1,n3,n2) — there is no direct n1-n2 edge.
    // All consecutive coord pairs in all segments must be actual adjacencyList edges.
    const patrol = [{ id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: 14.700, snappedLng: 121.0905 },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: 14.700, snappedLng: 121.092  },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: 14.700, snappedLng: 121.091  },
    ];
    const cache  = {};
    const result = runTSP([[...crimes]], patrol, [0], [], diamondNM, diamondAdj, cache, CFG);
    const route  = result.data.routes[0];

    // Build coord→nodeId reverse map and edge set for verification
    const coordKey   = n => `${n.lat},${n.lng}`;
    const coordToId  = Object.fromEntries(Object.entries(diamondNM).map(([id, n]) => [coordKey(n), id]));
    const edgeSet    = new Set();
    for (const [from, nbrs] of Object.entries(diamondAdj)) {
        for (const { neighborId } of nbrs) edgeSet.add(normalizedCacheKey(from, neighborId));
    }

    let allEdgesValid = true, badPair = null;
    for (const seg of route?.pathSegments ?? []) {
        for (let i = 0; i + 1 < seg.length; i++) {
            const aId = coordToId[coordKey(seg[i])];
            const bId = coordToId[coordKey(seg[i + 1])];
            if (!aId || !bId) {
                allEdgesValid = false; badPair = `unmapped coord ${coordKey(seg[i])} or ${coordKey(seg[i+1])}`; break;
            }
            if (!edgeSet.has(normalizedCacheKey(aId, bId))) {
                allEdgesValid = false; badPair = `${aId}→${bId} not in adjacencyList`; break;
            }
        }
        if (!allEdgesValid) break;
    }
    ok('every consecutive coord pair in every pathSegment is a real adjacencyList edge',
       allEdgesValid, badPair, 'all edges valid');

    // Find the n1→n2 leg and verify it has 3 nodes (n1→n3→n2), not 2 (direct shortcut).
    // There is no direct n1-n2 edge, so Dijkstra must route via n3.
    const n1key = coordKey(diamondNM.n1), n2key = coordKey(diamondNM.n2);
    const n1ton2 = route?.pathSegments?.find(seg =>
        coordKey(seg[0]) === n1key && coordKey(seg[seg.length - 1]) === n2key
    );
    if (n1ton2) {
        ok('n1→n2 leg has 3 nodes (follows n1→n3→n2 road, not straight line)',
           n1ton2.length === 3, n1ton2.length, 3);
    } else {
        ok('n1→n2 leg present in circuit', false, 'segment not found in pathSegments', 'n1→n2 segment');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: Unreachable crime node excluded from zone
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 7] Unreachable crime node excluded, remaining route valid');
{
    // Graph: n0─100─n1─100─n2. n3 isolated (no edges → unreachable from n0).
    // Crimes: C1 at n2 (reachable), C2 at n3 (unreachable → must be excluded).
    // After exclusion: only C1 remains → backtracking with k=1.
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
        n3: { id: 'n3', lat: 14.700, lng: 121.093 }, // isolated
    };
    const adj = {
        n0: [{ neighborId: 'n1', weight: 100 }],
        n1: [{ neighborId: 'n0', weight: 100 }, { neighborId: 'n2', weight: 100 }],
        n2: [{ neighborId: 'n1', weight: 100 }],
        n3: [],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C2', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('status warning (unreachable node warning emitted)',
       result.status === 'warning', result.status, 'warning');
    ok('warning mentions "unreachable"',
       result.warnings.some(w => w.toLowerCase().includes('unreachable')), result.warnings, 'contains unreachable');
    ok('route not empty (C1 still reachable)', route?.isEmpty === false, route?.isEmpty, false);

    const seqIds = route?.sequence?.map(s => s.nodeId) ?? [];
    ok('n3 (unreachable C2) absent from sequence', !seqIds.includes('n3'), seqIds, 'no n3');
    ok('n2 (reachable C1) present in sequence',  seqIds.includes('n2'), seqIds, 'includes n2');
}

// ── Test 7b: All crime nodes unreachable → isEmpty + error status ─────────────
console.log('\n[Test 7b] All crime nodes unreachable → isEmpty route and error status');
{
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
    };
    const adj = { n0: [], n1: [], n2: [] }; // all isolated
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('isEmpty === true when all nodes unreachable', route?.isEmpty === true, route?.isEmpty, true);
    ok('status === error when all routes empty', result.status === 'error', result.status, 'error');
    ok('error message mentions no reachable crime nodes',
       result.message.toLowerCase().includes('no reachable crime nodes'),
       result.message, 'contains "no reachable crime nodes"');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: k=2 special case — correct circuit, correct log message
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 8] k=2 special case: circuit distance, log message, sequence validity');
{
    // Chain n0─50─n1─50─n2.
    // D[n0][n1]=50, D[n1][n2]=50, D[n2][n0]=100.
    // Circuit n0→n1→n2→n0 = 50+50+100 = 200m.
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
    };
    const adj = {
        n0: [{ neighborId: 'n1', weight: 50 }],
        n1: [{ neighborId: 'n0', weight: 50 }, { neighborId: 'n2', weight: 50 }],
        n2: [{ neighborId: 'n1', weight: 50 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('status success (k=2 not a warning condition)', result.status === 'success', result.status, 'success');
    ok('approximate === false (k=2 not heuristic)', route?.approximate === false, route?.approximate, false);
    ok('circuitDistanceM === 200', route?.circuitDistanceM === 200, route?.circuitDistanceM, 200);
    ok('pathSegments.length === 3 (n0→n1, n1→n2, n2→n0)',
       route?.pathSegments?.length === 3, route?.pathSegments?.length, 3);

    const log = result.data.traceLog.join('\n');
    ok('log: "2 crime nodes in zone"',
       log.includes('2 crime nodes in zone'), log.includes('2 crime nodes in zone'), true);
    ok('log: "both visiting sequences are equivalent"',
       log.includes('both visiting sequences are equivalent'),
       log.includes('both visiting sequences are equivalent'), true);
    ok('log: "First sequence selected"',
       log.includes('First sequence selected'), log.includes('First sequence selected'), true);

    const seqIds = route?.sequence?.map(s => s.nodeId) ?? [];
    ok('sequence starts at n0', seqIds[0] === 'n0', seqIds[0], 'n0');
    ok('sequence ends at n0',   seqIds[seqIds.length - 1] === 'n0', seqIds[seqIds.length - 1], 'n0');
    ok('n1 in sequence', seqIds.includes('n1'), seqIds, 'includes n1');
    ok('n2 in sequence', seqIds.includes('n2'), seqIds, 'includes n2');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: Overlap tracking — two patrols sharing an edge produce count >= 2
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 9] Overlap tracking: shared edge produces correct count');
{
    // Star hub at n4:  n0─100─n4─100─n1   n2─100─n4
    // Patrol0 at n0, single crime at n1 → route uses n0-n4-n1-n4-n0 (n4-n1 edge used twice).
    // Patrol1 at n2, single crime at n1 → route uses n2-n4-n1-n4-n2 (n4-n1 edge used twice more).
    // Total n1|n4 edge count = 4 (overlapEdges must include it).
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n4: { id: 'n4', lat: 14.700, lng: 121.091 },
        n1: { id: 'n1', lat: 14.700, lng: 121.092 },
        n2: { id: 'n2', lat: 14.700, lng: 121.093 },
    };
    const adj = {
        n0: [{ neighborId: 'n4', weight: 100 }],
        n4: [{ neighborId: 'n0', weight: 100 }, { neighborId: 'n1', weight: 100 }, { neighborId: 'n2', weight: 100 }],
        n1: [{ neighborId: 'n4', weight: 100 }],
        n2: [{ neighborId: 'n4', weight: 100 }],
    };
    const patrols = [
        { id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' },
        { id: 's2', nodeId: 'n2', lat: nm.n2.lat, lng: nm.n2.lng, color: '#3498db' },
    ];
    const zones = [
        [{ crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng }],
        [{ crimeId: 'C2', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng }],
    ];
    const result = runTSP(zones, patrols, [], [0, 1], nm, adj, {}, CFG);

    const bridgeKey   = normalizedCacheKey('n1', 'n4'); // must be 'n1|n4'
    const overlapEntry = result.data.overlapEdges.find(e => e.key === bridgeKey);

    ok(`normalizedCacheKey('n1','n4') = 'n1|n4'`, bridgeKey === 'n1|n4', bridgeKey, 'n1|n4');
    ok('overlapEdges is non-empty (shared edge detected)',
       result.data.overlapEdges.length > 0, result.data.overlapEdges.length, '>0');
    ok(`n1|n4 edge appears in overlapEdges`, overlapEntry !== undefined, overlapEntry, '{key,count}');
    ok('n1|n4 edge count >= 2 (both patrols traverse it)',
       (overlapEntry?.count ?? 0) >= 2, overlapEntry?.count, '>=2');
    ok('n1|n4 edge count === 4 (each patrol uses it twice — out and back)',
       overlapEntry?.count === 4, overlapEntry?.count, 4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10: dijkstraCache populated after first run, reused on second run
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 10] dijkstraCache: first run populates cache, second run hits it');
{
    const { nm, adj } = makeChain(4);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const cache = {};

    const r1 = runTSP([[...crimes]], patrol, [0], [], nm, adj, cache, CFG);
    ok('run 1: totalDijkstraCalls === 4 (cold cache)',
       r1.data.totalDijkstraCalls === 4, r1.data.totalDijkstraCalls, 4);
    ok('run 1: totalCacheHits === 0',
       r1.data.totalCacheHits === 0, r1.data.totalCacheHits, 0);
    ok('cache has 4 entries after run 1',
       Object.keys(cache).length === 4, Object.keys(cache).length, 4);

    const r2 = runTSP([[...crimes]], patrol, [0], [], nm, adj, cache, CFG);
    ok('run 2: totalDijkstraCalls === 0 (warm cache)',
       r2.data.totalDijkstraCalls === 0, r2.data.totalDijkstraCalls, 0);
    ok('run 2: totalCacheHits === 4 (all sources already cached)',
       r2.data.totalCacheHits === 4, r2.data.totalCacheHits, 4);
    ok('run 1 and run 2 produce same circuit distance (cache yields correct results)',
       r1.data.routes[0]?.circuitDistanceM === r2.data.routes[0]?.circuitDistanceM,
       `r1=${r1.data.routes[0]?.circuitDistanceM} r2=${r2.data.routes[0]?.circuitDistanceM}`, 'equal');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 11: pushProgress callback invoked for multi-node zones
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 11] pushProgress callback invoked with correct shape');
{
    const { nm, adj } = makeChain(4);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const events = [];
    runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG,
        { pushProgress: e => events.push(e) });

    ok('pushProgress called at least once', events.length >= 1, events.length, '>=1');
    ok('event.stage === 4', events[0]?.stage === 4, events[0]?.stage, 4);
    ok('event.patrolId === "s1"', events[0]?.patrolId === 's1', events[0]?.patrolId, 's1');
    ok('event.circuitDistanceM is a number',
       typeof events[0]?.circuitDistanceM === 'number', typeof events[0]?.circuitDistanceM, 'number');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 12: Backtracking pruning — prune on accumulated >= bestCircuit
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 12] Backtracking pruning: optimal found despite costly detours');
{
    // n0─1─n1─100─n2─1─n3. Road distances force near-linear circuit.
    // D[n0][n1]=1, D[n1][n2]=100, D[n2][n3]=1
    // D[n0][n2]=101, D[n0][n3]=102, D[n1][n3]=101
    // All optimal circuits = 204m. Detour circuits = 404m — must be pruned.
    const nm = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
        n3: { id: 'n3', lat: 14.700, lng: 121.093 },
    };
    const adj = {
        n0: [{ neighborId: 'n1', weight:   1 }],
        n1: [{ neighborId: 'n0', weight:   1 }, { neighborId: 'n2', weight: 100 }],
        n2: [{ neighborId: 'n1', weight: 100 }, { neighborId: 'n3', weight:   1 }],
        n3: [{ neighborId: 'n2', weight:   1 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('status success', result.status === 'success', result.status, 'success');
    ok('approximate === false', route?.approximate === false, route?.approximate, false);
    ok('circuitDistanceM === 204 (optimal; 404m detours pruned)',
       route?.circuitDistanceM === 204, route?.circuitDistanceM, 204);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 13: pathSegments count equals k+1 legs for multi-node zone
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 13] pathSegments.length === k+1 legs (return leg always counted)');
{
    // k=4 crimes → 5 legs: s→c1, c1→c2, c2→c3, c3→c4, c4→s
    const { nm, adj } = makeChain(5);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crimes  = [
        { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
        { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
        { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
        { crimeId: 'C4', snappedNodeId: 'n4', snappedLat: nm.n4.lat, snappedLng: nm.n4.lng },
    ];
    const result = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route  = result.data.routes[0];

    ok('pathSegments.length === 5 (k=4 crimes → 5 legs including return)',
       route?.pathSegments?.length === 5, route?.pathSegments?.length, 5);
    ok('sequence.length === 6 (start + 4 crimes + return)',
       route?.sequence?.length === 6, route?.sequence?.length, 6);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 14: normalizedCacheKey produces correct normalized edge keys
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 14] normalizedCacheKey: numeric sort, pipe separator, symmetric');
{
    const k1  = normalizedCacheKey('n89',   'n234');
    const k1r = normalizedCacheKey('n234',  'n89');   // reversed
    const k2  = normalizedCacheKey('n1',    'n1000');
    const k2r = normalizedCacheKey('n1000', 'n1');    // reversed
    const k3  = normalizedCacheKey('n0',    'n0');    // same node

    ok('n89|n234: smaller numeric (89) first', k1 === 'n89|n234', k1, 'n89|n234');
    ok('reversed n234|n89 produces same key',  k1r === k1,        k1r, k1);
    ok('n1|n1000: numeric 1 < 1000 (not lexicographic)',  k2 === 'n1|n1000', k2, 'n1|n1000');
    ok('reversed n1000|n1 produces same key',  k2r === k2,        k2r, k2);
    ok('key uses pipe separator', k1.includes('|'), k1, 'contains |');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 15: Trace log summary counts match actual routes
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 15] Trace log summary matches actual route counts');
{
    // Patrol0: multi-node (3 crimes). Patrol1: single-node (1 crime).
    const { nm, adj } = makeChain(5);
    const patrols = [
        { id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' },
        { id: 's2', nodeId: 'n4', lat: nm.n4.lat, lng: nm.n4.lng, color: '#3498db' },
    ];
    const zones = [
        [
            { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: nm.n1.lat, snappedLng: nm.n1.lng },
            { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng },
            { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng },
        ],
        [{ crimeId: 'C4', snappedNodeId: 'n3', snappedLat: nm.n3.lat, snappedLng: nm.n3.lng }],
    ];
    const result = runTSP(zones, patrols, [0], [1], nm, adj, {}, CFG);
    const log    = result.data.traceLog.join('\n');

    ok('2 routes in result.data.routes',
       result.data.routes.length === 2, result.data.routes.length, 2);
    ok('summary: "Patrols with TSP routes (multi-node): 1"',
       log.includes('Patrols with TSP routes (multi-node): 1'),
       log.includes('Patrols with TSP routes (multi-node): 1'), true);
    ok('summary: "Patrols with direct visit (single-node): 1"',
       log.includes('Patrols with direct visit (single-node): 1'),
       log.includes('Patrols with direct visit (single-node): 1'), true);
    ok('summary line present: "--- Stage 4 Summary ---"',
       log.includes('--- Stage 4 Summary ---'), log.includes('--- Stage 4 Summary ---'), true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 16: Single-node zone pathSegments contain intermediate road nodes
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[Test 16] Single-node pathSegments include intermediate road nodes');
{
    // Chain n0─100─n1─100─n2. Crime at n2 (single-node).
    // Outbound n0→n2 must include n1 as intermediate: [n0,n1,n2] (3 coords, not 2).
    const { nm, adj } = makeChain(3);
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nm.n0.lat, lng: nm.n0.lng, color: '#e74c3c' }];
    const crime   = [{ crimeId: 'C1', snappedNodeId: 'n2', snappedLat: nm.n2.lat, snappedLng: nm.n2.lng }];
    const result  = runTSP([[...crime]], patrol, [], [0], nm, adj, {}, CFG);
    const route   = result.data.routes[0];

    const outboundSeg = route?.pathSegments?.[0]; // n0→n2 via n1
    ok('outbound segment has 3 coords (n0, n1, n2 — not just endpoints)',
       outboundSeg?.length === 3, outboundSeg?.length, 3);

    const returnSeg = route?.pathSegments?.[1]; // n2→n0 via n1
    ok('return segment has 3 coords (n2, n1, n0 — not just endpoints)',
       returnSeg?.length === 3, returnSeg?.length, 3);
}

// ── Final summary ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`Total: ${pass + fail} tests — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
