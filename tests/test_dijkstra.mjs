/**
 * PatrolPoint V2 — dijkstra.js comprehensive test suite
 * Run: node tests/test_dijkstra.mjs
 *
 * Covers: haversineDistance, normalizedCacheKey, reconstructPath,
 *         runDijkstra (heap correctness, path optimality, cache, edge cases),
 *         and full real-world road_network.json tests.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
    haversineDistance,
    reconstructPath,
    normalizedCacheKey,
    runDijkstra
} from '../server/algorithms/dijkstra.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(id, description, fn) {
    try {
        const result = fn();
        if (result === true || result === undefined) {
            console.log(`  PASS  [${id}] ${description}`);
            passed++;
        } else {
            console.log(`  FAIL  [${id}] ${description}`);
            console.log(`        Expected true, got: ${JSON.stringify(result)}`);
            failed++;
            failures.push(id);
        }
    } catch (err) {
        console.log(`  FAIL  [${id}] ${description}`);
        console.log(`        Threw: ${err.message}`);
        failed++;
        failures.push(id);
    }
}

function near(a, b, tol = 0.01) { return Math.abs(a - b) <= tol; }

// ── Section 1: haversineDistance ─────────────────────────────────────────────

console.log('\n── Section 1: haversineDistance ──────────────────────────────────────');

test('H01', 'same point returns 0', () => {
    return haversineDistance(14.7001, 121.089, 14.7001, 121.089) === 0;
});

test('H02', 'symmetric — A→B equals B→A', () => {
    const ab = haversineDistance(14.7001, 121.089, 14.710, 121.095);
    const ba = haversineDistance(14.710, 121.095, 14.7001, 121.089);
    return near(ab, ba, 0.0001);
});

test('H03', 'always non-negative', () => {
    const d1 = haversineDistance(14.700, 121.090, 14.695, 121.085);
    const d2 = haversineDistance(0, 0, 0, 0);
    return d1 >= 0 && d2 >= 0;
});

test('H04', 'matches known n0→n1 edge weight from road_network.json (12.8241m)', () => {
    // n0: 14.7001238, 121.0889791  n1: 14.7001539, 121.0890942
    const d = haversineDistance(14.7001238, 121.0889791, 14.7001539, 121.0890942);
    return near(d, 12.8241, 0.001);
});

test('H05', 'north-south 1 degree ≈ 111,000m', () => {
    const d = haversineDistance(14.0, 121.0, 15.0, 121.0);
    return near(d, 111000, 500);
});

test('H06', 'east-west 1 degree scaled by cos(lat)', () => {
    const d = haversineDistance(14.7, 121.0, 14.7, 122.0);
    const expected = 111000 * Math.cos(14.7 * Math.PI / 180);
    return near(d, expected, 500);
});

test('H07', 'east-west same distance is shorter at higher lat', () => {
    const atEquator  = haversineDistance(0,   0, 0,   1);
    const atPhilippines = haversineDistance(14.7, 0, 14.7, 1);
    return atPhilippines < atEquator;
});

test('H08', 'parameter order: lat always before lng', () => {
    // Swapping lat and lng gives a different (wrong) result
    const correct = haversineDistance(14.7001, 121.089, 14.710, 121.095);
    const swapped = haversineDistance(121.089, 14.7001, 121.095, 14.710);
    return correct !== swapped;
});

test('H09', 'short distance within Commonwealth ~300m', () => {
    // Two points ~300m apart inside Commonwealth
    const d = haversineDistance(14.700, 121.089, 14.703, 121.089);
    return near(d, 333, 10);
});

test('H10', 'returns a number (not NaN, not undefined)', () => {
    const d = haversineDistance(14.700, 121.090, 14.702, 121.092);
    return typeof d === 'number' && !isNaN(d);
});

// ── Section 2: normalizedCacheKey ─────────────────────────────────────────────

console.log('\n── Section 2: normalizedCacheKey ─────────────────────────────────────');

test('K01', 'produces same key regardless of argument order', () => {
    return normalizedCacheKey('n89', 'n234') === normalizedCacheKey('n234', 'n89');
});

test('K02', 'spec example — n89 and n234 → "n89|n234"', () => {
    return normalizedCacheKey('n89', 'n234') === 'n89|n234';
});

test('K03', 'lower numeric ID always first', () => {
    const key = normalizedCacheKey('n500', 'n1');
    return key === 'n1|n500';
});

test('K04', 'extreme ends — n0 and n3612', () => {
    return normalizedCacheKey('n3612', 'n0') === 'n0|n3612';
});

test('K05', 'same node both sides', () => {
    return normalizedCacheKey('n5', 'n5') === 'n5|n5';
});

test('K06', 'numeric comparison, not lexicographic — n9 < n10 numerically', () => {
    // Lexicographically "n9" > "n10", but numerically 9 < 10
    return normalizedCacheKey('n9', 'n10') === 'n9|n10';
});

test('K07', 'returns a string', () => {
    return typeof normalizedCacheKey('n1', 'n2') === 'string';
});

test('K08', 'pipe separator present in output', () => {
    return normalizedCacheKey('n1', 'n2').includes('|');
});

// ── Section 3: reconstructPath ───────────────────────────────────────────────

console.log('\n── Section 3: reconstructPath ────────────────────────────────────────');

// Build a simple parents map manually
const simpleParents = { n0: null, n1: 'n0', n2: 'n1', n3: 'n2', n4: 'n3', n5: null };

test('P01', 'source → source returns [source]', () => {
    const p = reconstructPath('n0', 'n0', simpleParents);
    return Array.isArray(p) && p.length === 1 && p[0] === 'n0';
});

test('P02', 'direct neighbor returns [src, dst]', () => {
    const p = reconstructPath('n0', 'n1', simpleParents);
    return JSON.stringify(p) === JSON.stringify(['n0', 'n1']);
});

test('P03', 'multi-hop path correct sequence', () => {
    const p = reconstructPath('n0', 'n4', simpleParents);
    return JSON.stringify(p) === JSON.stringify(['n0', 'n1', 'n2', 'n3', 'n4']);
});

test('P04', 'unreachable node (null parent, not source) → null', () => {
    return reconstructPath('n0', 'n5', simpleParents) === null;
});

test('P05', 'node not in parents map at all → null', () => {
    return reconstructPath('n0', 'n999', simpleParents) === null;
});

test('P06', 'path first element is always source', () => {
    const p = reconstructPath('n0', 'n3', simpleParents);
    return p !== null && p[0] === 'n0';
});

test('P07', 'path last element is always destination', () => {
    const p = reconstructPath('n0', 'n3', simpleParents);
    return p !== null && p[p.length - 1] === 'n3';
});

test('P08', 'path contains no duplicate node IDs', () => {
    const p = reconstructPath('n0', 'n4', simpleParents);
    return p !== null && new Set(p).size === p.length;
});

test('P09', 'path length matches hop count + 1', () => {
    const p = reconstructPath('n0', 'n4', simpleParents);
    return p !== null && p.length === 5; // 4 hops + 1
});

test('P10', 'broken chain (null mid-path) → null', () => {
    const brokenParents = { n0: null, n1: 'n0', n2: null, n3: 'n2' };
    // n3's chain: n3 → n2 → null (broken before reaching n0)
    return reconstructPath('n0', 'n3', brokenParents) === null;
});

// ── Section 4: runDijkstra — synthetic graphs ─────────────────────────────────

console.log('\n── Section 4: runDijkstra — synthetic graphs ─────────────────────────');

// Graph helpers
function makeAdj(edgeList) {
    const adj = {};
    for (const [a, b, w] of edgeList) {
        if (!adj[a]) adj[a] = [];
        if (!adj[b]) adj[b] = [];
        adj[a].push({ neighborId: b, weight: w });
        adj[b].push({ neighborId: a, weight: w });
    }
    return adj;
}

// S01: single node, no edges
test('S01', 'single isolated node: distance to self = 0', () => {
    const adj = { n0: [] };
    const cache = {};
    const { distances } = runDijkstra('n0', adj, cache);
    return distances['n0'] === 0;
});

// S02: two connected nodes
test('S02', 'two-node graph: correct distance and path', () => {
    const adj = makeAdj([['n0','n1',10]]);
    const cache = {};
    const { distances, parents } = runDijkstra('n0', adj, cache);
    const path = reconstructPath('n0', 'n1', parents);
    return distances['n1'] === 10 && JSON.stringify(path) === '["n0","n1"]';
});

// S03: decreaseKey — triangle where indirect is shorter
// A-B=10, B-C=5, A-C=20. Shortest A→C must be via B (15), not direct (20)
test('S03', 'decreaseKey correctness — indirect shorter path wins', () => {
    const adj = makeAdj([['A','B',10],['B','C',5],['A','C',20]]);
    const cache = {};
    const { distances, parents } = runDijkstra('A', adj, cache);
    const path = reconstructPath('A', 'C', parents);
    return distances['C'] === 15 && JSON.stringify(path) === '["A","B","C"]';
});

// S04: linear chain — additive distances
test('S04', 'linear chain: distances accumulate correctly', () => {
    const adj = makeAdj([['n0','n1',10],['n1','n2',20],['n2','n3',30]]);
    const cache = {};
    const { distances } = runDijkstra('n0', adj, cache);
    return distances['n0'] === 0 &&
           distances['n1'] === 10 &&
           distances['n2'] === 30 &&
           distances['n3'] === 60;
});

// S05: disconnected node
test('S05', 'disconnected node has Infinity distance', () => {
    const adj = makeAdj([['n0','n1',5]]);
    adj['n2'] = []; // island
    const cache = {};
    const { distances } = runDijkstra('n0', adj, cache);
    return distances['n2'] === Infinity;
});

// S06: reconstructPath on disconnected node returns null
test('S06', 'reconstructPath on Infinity-distance node returns null', () => {
    const adj = makeAdj([['n0','n1',5]]);
    adj['n2'] = [];
    const cache = {};
    const { parents } = runDijkstra('n0', adj, cache);
    return reconstructPath('n0', 'n2', parents) === null;
});

// S07: source distance always 0
test('S07', 'source node always has distance 0', () => {
    const adj = makeAdj([['n0','n1',99],['n1','n2',99]]);
    const cache = {};
    const { distances } = runDijkstra('n0', adj, cache);
    return distances['n0'] === 0;
});

// S08: source = destination path is [src]
test('S08', 'path from source to itself is [source]', () => {
    const adj = makeAdj([['n0','n1',5]]);
    const cache = {};
    const { parents } = runDijkstra('n0', adj, cache);
    const path = reconstructPath('n0', 'n0', parents);
    return JSON.stringify(path) === '["n0"]';
});

// S09: multiple paths — picks the globally shortest
// A-B=1, B-C=1, A-D=2, D-C=1 → A→C via A-B-C=2 or A-D-C=3. Must pick 2.
test('S09', 'multiple paths — globally shortest selected', () => {
    const adj = makeAdj([['A','B',1],['B','C',1],['A','D',2],['D','C',1]]);
    const cache = {};
    const { distances, parents } = runDijkstra('A', adj, cache);
    const path = reconstructPath('A', 'C', parents);
    return distances['C'] === 2 && path[path.length-1] === 'C' && path[0] === 'A';
});

// S10: symmetry — distance A→B equals distance B→A on undirected graph
test('S10', 'undirected graph symmetry: dist(A,B) === dist(B,A)', () => {
    const adj = makeAdj([['A','B',7],['B','C',3],['A','C',15]]);
    const c1 = {}, c2 = {};
    const { distances: dA } = runDijkstra('A', adj, c1);
    const { distances: dB } = runDijkstra('B', adj, c2);
    // dist(A→B) must equal dist(B→A) on an undirected graph
    // dist(A→C) via B = 7+3=10, which beats direct A→C=15
    return near(dA['B'], dB['A'], 0.001) &&   // dist(A→B) == dist(B→A) == 7
           near(dA['C'], 10, 0.001);           // shortest A→C is via B
});

// S11: triangle inequality holds on all pairs
test('S11', 'triangle inequality: dist(A,C) ≤ dist(A,B) + dist(B,C)', () => {
    const adj = makeAdj([['A','B',5],['B','C',8],['A','C',20]]);
    const cache = {};
    const { distances } = runDijkstra('A', adj, cache);
    return distances['C'] <= distances['B'] + 8;
});

// S12: intermediate nodes included in path (not just endpoints)
test('S12', 'path includes all intermediate nodes', () => {
    const adj = makeAdj([['n0','n1',1],['n1','n2',1],['n2','n3',1]]);
    const cache = {};
    const { parents } = runDijkstra('n0', adj, cache);
    const path = reconstructPath('n0', 'n3', parents);
    return JSON.stringify(path) === '["n0","n1","n2","n3"]';
});

// S13: all consecutive nodes in path are actual neighbors
test('S13', 'all consecutive path nodes are actual neighbors in graph', () => {
    const adj = makeAdj([['A','B',3],['B','C',4],['C','D',2],['A','D',20]]);
    const cache = {};
    const { parents } = runDijkstra('A', adj, cache);
    const path = reconstructPath('A', 'D', parents);
    if (!path) return false;
    for (let i = 0; i < path.length - 1; i++) {
        const from = path[i], to = path[i+1];
        const neighbors = adj[from] || [];
        if (!neighbors.some(nb => nb.neighborId === to)) return false;
    }
    return true;
});

// S14: graph with equal-weight edges — any valid shortest path acceptable
test('S14', 'equal-weight edges: correct total distance', () => {
    const adj = makeAdj([['A','B',5],['A','C',5],['B','D',5],['C','D',5]]);
    const cache = {};
    const { distances } = runDijkstra('A', adj, cache);
    return distances['D'] === 10;
});

// S15: source not in adjacencyList — graceful handling
test('S15', 'source absent from adjacencyList — distances[source] = 0', () => {
    const adj = { n0: [{ neighborId: 'n1', weight: 5 }], n1: [{ neighborId: 'n0', weight: 5 }] };
    const cache = {};
    const { distances } = runDijkstra('n99', adj, cache);
    return distances['n99'] === 0;
});

// ── Section 5: Cache behavior ─────────────────────────────────────────────────

console.log('\n── Section 5: Cache behavior ─────────────────────────────────────────');

test('C01', 'cache miss: result stored under sourceId key', () => {
    const adj = makeAdj([['n0','n1',10]]);
    const cache = {};
    runDijkstra('n0', adj, cache);
    return cache['n0'] !== undefined;
});

test('C02', 'cache hit: returns exact same object reference', () => {
    const adj = makeAdj([['n0','n1',10]]);
    const cache = {};
    const r1 = runDijkstra('n0', adj, cache);
    const r2 = runDijkstra('n0', adj, cache);
    return r1 === r2;
});

test('C03', 'cache stores distances and parents', () => {
    const adj = makeAdj([['n0','n1',10]]);
    const cache = {};
    runDijkstra('n0', adj, cache);
    return cache['n0'].distances !== undefined && cache['n0'].parents !== undefined;
});

test('C04', 'multiple sources cached independently', () => {
    const adj = makeAdj([['n0','n1',10],['n1','n2',20]]);
    const cache = {};
    runDijkstra('n0', adj, cache);
    runDijkstra('n1', adj, cache);
    return cache['n0'] !== undefined && cache['n1'] !== undefined && cache['n0'] !== cache['n1'];
});

test('C05', 'second call returns cached result — adjacencyList change has no effect', () => {
    const adj = makeAdj([['n0','n1',10]]);
    const cache = {};
    const r1 = runDijkstra('n0', adj, cache);
    // Mutate adj — cached result must not change
    adj['n0'].push({ neighborId: 'n2', weight: 1 });
    adj['n2'] = [{ neighborId: 'n0', weight: 1 }];
    const r2 = runDijkstra('n0', adj, cache);
    return r1 === r2 && r2.distances['n2'] === undefined;
});

test('C06', 'empty cache object accepted without error', () => {
    const adj = makeAdj([['n0','n1',5]]);
    const cache = {};
    const { distances } = runDijkstra('n0', adj, cache);
    return distances['n0'] === 0;
});

// ── Section 6: Real-world road_network.json ───────────────────────────────────

console.log('\n── Section 6: Real-world road_network.json ───────────────────────────');

// Build road network structures from V1 data file
const rn = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'road_network.json'), 'utf8'));
const rnNodeMap = {};
for (const n of rn.nodes) rnNodeMap[n.id] = n;

const rnAdj = {};
for (const n of rn.nodes) rnAdj[n.id] = [];
for (const e of rn.edges) {
    rnAdj[e.from].push({ neighborId: e.to,   weight: e.weight });
    rnAdj[e.to  ].push({ neighborId: e.from, weight: e.weight });
}

// Known unreachable nodes from BFS analysis (11 disconnected nodes)
// n2098 confirmed unreachable from n0
const KNOWN_UNREACHABLE = 'n2098';
const REACHABLE_COUNT   = 3602;
const TOTAL_NODES       = 3613;
const UNREACHABLE_COUNT = 11;

test('R01', 'road_network.json loaded: correct node and edge counts', () => {
    return rn.nodes.length === 3613 && rn.edges.length === 3971;
});

test('R02', 'n0 → n0 distance is exactly 0', () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    return distances['n0'] === 0;
});

test('R03', 'n0 → n1 distance matches known edge weight 12.8241m', () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    return near(distances['n1'], 12.8241, 0.001);
});

test('R04', `known disconnected node ${KNOWN_UNREACHABLE} has Infinity distance from n0`, () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    return distances[KNOWN_UNREACHABLE] === Infinity;
});

test('R05', `reconstructPath to ${KNOWN_UNREACHABLE} returns null`, () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    return reconstructPath('n0', KNOWN_UNREACHABLE, parents) === null;
});

test('R06', `exactly ${REACHABLE_COUNT} nodes are reachable from n0`, () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    const reachable = Object.values(distances).filter(d => d !== Infinity).length;
    return reachable === REACHABLE_COUNT;
});

test('R07', `exactly ${UNREACHABLE_COUNT} nodes are unreachable from n0`, () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    const unreachable = Object.values(distances).filter(d => d === Infinity).length;
    return unreachable === UNREACHABLE_COUNT;
});

test('R08', 'direct neighbor path n0→n1 is exactly ["n0","n1"]', () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n1', parents);
    return JSON.stringify(path) === '["n0","n1"]';
});

test('R09', 'path n0→n8 (intersection node) is valid — all consecutive nodes are neighbors', () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n8', parents);
    if (!path || path.length < 2) return false;
    for (let i = 0; i < path.length - 1; i++) {
        const nbrs = rnAdj[path[i]] || [];
        if (!nbrs.some(nb => nb.neighborId === path[i+1])) return false;
    }
    return true;
});

test('R10', 'path endpoints match source and destination', () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n8', parents);
    return path !== null && path[0] === 'n0' && path[path.length - 1] === 'n8';
});

test('R11', 'path distance matches sum of edge weights along path', () => {
    const cache = {};
    const { distances, parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n8', parents);
    if (!path) return false;
    let sum = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const edge = rnAdj[path[i]].find(nb => nb.neighborId === path[i+1]);
        if (!edge) return false;
        sum += edge.weight;
    }
    return near(sum, distances['n8'], 0.01);
});

test('R12', 'triangle inequality on real graph: dist(n0,n13) ≤ dist(n0,n11) + dist(n11,n13)', () => {
    const cache = {};
    const { distances: d0 } = runDijkstra('n0',  rnAdj, cache);
    const { distances: d11 } = runDijkstra('n11', rnAdj, cache);
    return d0['n13'] <= d0['n11'] + d11['n13'] + 0.001;
});

test('R13', 'symmetry: dist(n0→n11) ≈ dist(n11→n0)', () => {
    const c1 = {}, c2 = {};
    const { distances: d0  } = runDijkstra('n0',  rnAdj, c1);
    const { distances: d11 } = runDijkstra('n11', rnAdj, c2);
    return near(d0['n11'], d11['n0'], 0.001);
});

test('R14', 'path contains no duplicate node IDs (no cycles)', () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n11', parents);
    return path !== null && new Set(path).size === path.length;
});

test('R15', 'distant intersection n0→n3606: path exists and is valid', () => {
    const cache = {};
    const { distances, parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n3606', parents);
    if (!path || distances['n3606'] === Infinity) return false;
    // Verify first and last
    if (path[0] !== 'n0' || path[path.length-1] !== 'n3606') return false;
    // Spot-check: first step is a neighbor
    return rnAdj['n0'].some(nb => nb.neighborId === path[1]);
});

test('R16', 'Dijkstra road distance ≥ Haversine straight-line (triangle inequality lower bound)', () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    const nodeA = rnNodeMap['n0'];
    const nodeB = rnNodeMap['n11'];
    const straightLine = haversineDistance(nodeA.lat, nodeA.lng, nodeB.lat, nodeB.lng);
    return distances['n11'] >= straightLine - 0.001;
});

test('R17', 'all path node IDs exist in road network', () => {
    const cache = {};
    const { parents } = runDijkstra('n0', rnAdj, cache);
    const path = reconstructPath('n0', 'n13', parents);
    if (!path) return false;
    return path.every(id => rnNodeMap[id] !== undefined);
});

test('R18', 'cache hit on second call returns same reference', () => {
    const cache = {};
    const r1 = runDijkstra('n0', rnAdj, cache);
    const r2 = runDijkstra('n0', rnAdj, cache);
    return r1 === r2;
});

// ── Section 7: Performance ────────────────────────────────────────────────────

console.log('\n── Section 7: Performance ────────────────────────────────────────────');

test('PERF01', 'full Dijkstra on 3613-node graph completes in < 500ms', () => {
    const cache = {};
    const t0 = performance.now();
    runDijkstra('n0', rnAdj, cache);
    const elapsed = performance.now() - t0;
    console.log(`         (actual: ${elapsed.toFixed(1)}ms)`);
    return elapsed < 500;
});

test('PERF02', 'cache hit returns in < 1ms', () => {
    const cache = {};
    runDijkstra('n0', rnAdj, cache); // warm cache
    const t0 = performance.now();
    runDijkstra('n0', rnAdj, cache);
    const elapsed = performance.now() - t0;
    console.log(`         (actual: ${elapsed.toFixed(3)}ms)`);
    return elapsed < 1;
});

test('PERF03', 'Dijkstra from distant intersection n3606 on full graph < 500ms', () => {
    const cache = {};
    const t0 = performance.now();
    runDijkstra('n3606', rnAdj, cache);
    const elapsed = performance.now() - t0;
    console.log(`         (actual: ${elapsed.toFixed(1)}ms)`);
    return elapsed < 500;
});

test('PERF04', 'distances map covers all 3613 nodes', () => {
    const cache = {};
    const { distances } = runDijkstra('n0', rnAdj, cache);
    return Object.keys(distances).length === TOTAL_NODES;
});

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + '═'.repeat(60));
console.log(`  TOTAL: ${total}  |  PASSED: ${passed}  |  FAILED: ${failed}`);
if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(id => console.log(`    • ${id}`));
}
console.log('═'.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
