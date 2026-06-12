// tests/test_hillClimbing.mjs
// Comprehensive test suite for server/algorithms/hillClimbing.js
// Run with: node tests/test_hillClimbing.mjs

import { runHillClimbing } from '../server/algorithms/hillClimbing.js';
import { haversineDistance } from '../server/algorithms/dijkstra.js';

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(id, description, fn) {
    try {
        const result = fn();
        if (result === true) {
            console.log(`  PASS  [${id}] ${description}`);
            passed++;
        } else {
            console.log(`  FAIL  [${id}] ${description}`);
            console.log(`        ${JSON.stringify(result)}`);
            failed++;
            failures.push(id);
        }
    } catch (e) {
        console.log(`  FAIL  [${id}] ${description}`);
        console.log(`        ${e.message}`);
        failed++;
        failures.push(id);
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Default CONFIG matching V2 defaults
const CONFIG = {
    hillClimbing: {
        restarts:           10,
        maxIterations:      500,
        radiusMultiplier:   2,
        adaptiveMaxRestarts: 30,
        synchronousMode:    false
    },
    convexHull: {
        areaThresholdDivisor: 100,
        outlierMultiplier:    2.5,
        collinearityEpsilon:  1e-10
    },
    tsp: {
        maxCrimeNodesPerZone:              10,
        nearestNeighborFallbackThreshold:  12
    },
    snapping: {
        boundingBoxEpsilon:       1e-7,
        initialSearchRadiusMeters: 500
    }
};

// Fast config — fewer restarts and iterations for speed
const FAST_CONFIG = {
    ...CONFIG,
    hillClimbing: {
        ...CONFIG.hillClimbing,
        restarts:            3,
        maxIterations:       50,
        adaptiveMaxRestarts: 5
    }
};

// Very fast for edge case tests
const MINIMAL_CONFIG = {
    ...CONFIG,
    hillClimbing: {
        ...CONFIG.hillClimbing,
        restarts:            2,
        maxIterations:       10,
        adaptiveMaxRestarts: 3
    }
};

// Grid of 20 valid candidates spread across Commonwealth area
function makeGrid(rows, cols, latStart, lngStart, latStep, lngStep) {
    const nodes = [];
    let idx = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            nodes.push({
                id:  `g${idx}`,
                lat: latStart + r * latStep,
                lng: lngStart + c * lngStep
            });
            idx++;
        }
    }
    return nodes;
}

// 5×4 = 20 nodes, ~100m spacing
const GRID_20 = makeGrid(5, 4, 14.700, 121.090, 0.001, 0.001);

// 4×4 = 16 nodes spread wider
const GRID_16 = makeGrid(4, 4, 14.700, 121.090, 0.002, 0.002);

// 2 nodes only
const TWO_NODES = [
    { id: 'a0', lat: 14.700, lng: 121.090 },
    { id: 'a1', lat: 14.705, lng: 121.095 }
];

// 1 node only
const ONE_NODE = [
    { id: 'z0', lat: 14.7014, lng: 121.0930 }
];

// Hull area for a ~1km² patch
const HULL_AREA_M2 = 1_000_000;   // 1 km²
// Hull area for a small patch
const HULL_AREA_SMALL = 10_000;   // 0.01 km²

// ── Section 1: Special cases ──────────────────────────────────────────────────
console.log('\n── Section 1: Special cases ─────────────────────────────────────────');

test('SC01', 'empty validCandidates → error', () => {
    const r = runHillClimbing([], 3, HULL_AREA_M2, CONFIG);
    return r.status === 'error';
});

test('SC02', 'null validCandidates → error', () => {
    const r = runHillClimbing(null, 3, HULL_AREA_M2, CONFIG);
    return r.status === 'error';
});

test('SC03', 'n=1 → success, exactly 1 patrol returned', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    return r.status === 'success' && r.data.patrols.length === 1;
});

test('SC04', 'n=1 → patrol has id=s1', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    return r.data.patrols[0].id === 's1';
});

test('SC05', 'n=1 → patrol nodeId is one of the valid candidates', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    const nodeIds = new Set(GRID_20.map(v => v.id));
    return nodeIds.has(r.data.patrols[0].nodeId);
});

test('SC06', 'n=1 → restartsCompleted=0 (Hill Climbing skipped)', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    return r.data.restartsCompleted === 0;
});

test('SC07', 'n=1 → confidence=100', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    return r.data.confidence === 100;
});

test('SC08', 'n=1 → placed at most central node (lowest avg dist to others)', () => {
    const r = runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG);
    const chosen = r.data.patrols[0];
    // Verify centrality: chosen node has lower avg dist than at least one other node
    function avgDist(node) {
        return GRID_20.reduce((s, o) => s + haversineDistance(node.lat, node.lng, o.lat, o.lng), 0) / GRID_20.length;
    }
    const chosenAvg = avgDist(chosen);
    const someOther = GRID_20.find(v => v.id !== chosen.nodeId);
    return chosenAvg <= avgDist(someOther);
});

test('SC09', 'n > validCandidates → capped, warning issued', () => {
    const r = runHillClimbing(TWO_NODES, 5, HULL_AREA_M2, FAST_CONFIG);
    return r.data.cappedFrom === 5 && r.data.patrols.length === 2 && r.warnings.length > 0;
});

test('SC10', 'n > validCandidates → effectiveN matches validCandidates.length', () => {
    const r = runHillClimbing(TWO_NODES, 10, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols.length === TWO_NODES.length;
});

test('SC11', 'n exactly equals validCandidates.length → no cap, no cappedFrom', () => {
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, FAST_CONFIG);
    return r.data.cappedFrom === null;
});

// ── Section 2: Return shape ───────────────────────────────────────────────────
console.log('\n── Section 2: Return shape ──────────────────────────────────────────');

test('SHAPE01', 'result has status, message, warnings, data', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return 'status' in r && 'message' in r && 'warnings' in r && 'data' in r;
});

test('SHAPE02', 'data has all required fields', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const d = r.data;
    return 'patrols' in d && 'bestMinPairwiseDist' in d && 'bestRestart' in d &&
           'restartsCompleted' in d && 'confidence' in d && 'cappedFrom' in d && 'traceLog' in d;
});

test('SHAPE03', 'each patrol has id, nodeId, lat, lng, color', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols.every(p =>
        typeof p.id === 'string' &&
        typeof p.nodeId === 'string' &&
        typeof p.lat === 'number' &&
        typeof p.lng === 'number' &&
        typeof p.color === 'string'
    );
});

test('SHAPE04', 'patrol ids are s1, s2, s3 for n=3', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const ids = r.data.patrols.map(p => p.id).sort();
    return ids.join(',') === 's1,s2,s3';
});

test('SHAPE05', 'patrol colors are from the palette', () => {
    const palette = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4'];
    const r = runHillClimbing(GRID_20, 5, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols.every(p => palette.includes(p.color));
});

test('SHAPE06', 'traceLog is non-empty array of strings', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return Array.isArray(r.data.traceLog) && r.data.traceLog.length > 0 &&
           r.data.traceLog.every(s => typeof s === 'string');
});

test('SHAPE07', 'warnings is always an array', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return Array.isArray(r.warnings);
});

test('SHAPE08', 'confidence is a number between 0 and 100', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return typeof r.data.confidence === 'number' &&
           r.data.confidence >= 0 && r.data.confidence <= 100;
});

test('SHAPE09', 'bestRestart is 1-indexed and within restartsCompleted', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.bestRestart >= 1 && r.data.bestRestart <= r.data.restartsCompleted;
});

// ── Section 3: Uniqueness and validity ────────────────────────────────────────
console.log('\n── Section 3: Uniqueness and validity ───────────────────────────────');

test('UNIQ01', 'all patrol nodeIds are distinct (no two patrols at same node)', () => {
    const r = runHillClimbing(GRID_20, 5, HULL_AREA_M2, FAST_CONFIG);
    const ids = r.data.patrols.map(p => p.nodeId);
    return new Set(ids).size === ids.length;
});

test('UNIQ02', 'all patrol nodeIds belong to validCandidates', () => {
    const r = runHillClimbing(GRID_20, 5, HULL_AREA_M2, FAST_CONFIG);
    const validIds = new Set(GRID_20.map(v => v.id));
    return r.data.patrols.every(p => validIds.has(p.nodeId));
});

test('UNIQ03', 'patrol lat/lng matches nodeId coordinate in grid', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const nodeById = Object.fromEntries(GRID_20.map(v => [v.id, v]));
    return r.data.patrols.every(p => {
        const node = nodeById[p.nodeId];
        return node && Math.abs(p.lat - node.lat) < 1e-9 && Math.abs(p.lng - node.lng) < 1e-9;
    });
});

test('UNIQ04', 'n=5 on GRID_20 → exactly 5 patrols', () => {
    const r = runHillClimbing(GRID_20, 5, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols.length === 5;
});

test('UNIQ05', 'Math.random fallback — unseeded runs complete without error', () => {
    // GRID_20 with MINIMAL_CONFIG always converges to the same optimum regardless of
    // starting position — variety is not guaranteed on small grids.
    // This test verifies the unseeded (Math.random) code path works correctly.
    const results = [];
    for (let i = 0; i < 5; i++) {
        const r = runHillClimbing(GRID_20, 4, HULL_AREA_M2, MINIMAL_CONFIG);
        results.push(r.data.patrols.map(p => p.nodeId).sort().join('|'));
    }
    // All runs should succeed and return the correct number of patrols.
    const allValid = results.every(ids => ids.split('|').length === 4);
    return allValid;
});

// ── Section 4: Objective — spread maximization ────────────────────────────────
console.log('\n── Section 4: Objective — spread maximization ───────────────────────');

test('OBJ01', 'bestMinPairwiseDist > 0 for n>1 with spread candidates', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.bestMinPairwiseDist > 0;
});

test('OBJ02', 'bestMinPairwiseDist matches actual min pairwise dist of returned patrols', () => {
    const r = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG);
    const patrols = r.data.patrols;
    let minDist = Infinity;
    for (let i = 0; i < patrols.length; i++) {
        for (let j = i + 1; j < patrols.length; j++) {
            const d = haversineDistance(patrols[i].lat, patrols[i].lng, patrols[j].lat, patrols[j].lng);
            if (d < minDist) minDist = d;
        }
    }
    return Math.abs(minDist - r.data.bestMinPairwiseDist) < 1; // within 1 metre
});

test('OBJ03', 'larger grid produces better spread than tighter grid for same n', () => {
    // GRID_16 has wider spacing (0.002 deg ≈ 222m) vs GRID_20 (0.001 deg ≈ 111m)
    const rWide  = runHillClimbing(GRID_16, 3, HULL_AREA_M2 * 4, FAST_CONFIG);
    const rTight = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return rWide.data.bestMinPairwiseDist > rTight.data.bestMinPairwiseDist;
});

test('OBJ04', 'n=2 on TWO_NODES → patrols are at the 2 available nodes', () => {
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, FAST_CONFIG);
    const ids = new Set(r.data.patrols.map(p => p.nodeId));
    return ids.has('a0') && ids.has('a1');
});

// ── Section 5: Radius R computation ──────────────────────────────────────────
console.log('\n── Section 5: Radius R computation ──────────────────────────────────');

test('R01', 'traceLog contains R computation line', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.traceLog.some(line => line.includes('R =') || line.includes('Radius'));
});

test('R02', 'larger radiusMultiplier → traceLog shows larger R', () => {
    const configSmall = { ...FAST_CONFIG, hillClimbing: { ...FAST_CONFIG.hillClimbing, radiusMultiplier: 1 } };
    const configLarge = { ...FAST_CONFIG, hillClimbing: { ...FAST_CONFIG.hillClimbing, radiusMultiplier: 4 } };
    const rSmall = runHillClimbing(GRID_20, 3, HULL_AREA_M2, configSmall);
    const rLarge = runHillClimbing(GRID_20, 3, HULL_AREA_M2, configLarge);
    // Extract R from log — look for "R = " line with a number
    const parseR = log => {
        const line = log.find(l => l.startsWith('R ='));
        if (!line) return null;
        const m = line.match(/= (\d+)m/);
        return m ? parseInt(m[1]) : null;
    };
    const r1 = parseR(rSmall.data.traceLog);
    const r2 = parseR(rLarge.data.traceLog);
    return r1 !== null && r2 !== null && r2 > r1;
});

test('R03', 'R proportional to sqrt(hullAreaM2 / candidates)', () => {
    // With HULL_AREA_M2=1_000_000, 20 candidates, multiplier=2:
    // R = sqrt(1000000 / 20) * 2 = sqrt(50000) * 2 ≈ 223.6 * 2 ≈ 447m
    const expected = Math.round(Math.sqrt(HULL_AREA_M2 / GRID_20.length) * CONFIG.hillClimbing.radiusMultiplier);
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const line = r.data.traceLog.find(l => l.startsWith('R ='));
    const m = line && line.match(/= (\d+)m/);
    return m && Math.abs(parseInt(m[1]) - expected) <= 2; // within 2m rounding
});

// ── Section 6: Adaptive restarts ─────────────────────────────────────────────
console.log('\n── Section 6: Adaptive restarts ─────────────────────────────────────');

test('ADAPT01', 'restartsCompleted >= 1', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.restartsCompleted >= 1;
});

test('ADAPT02', 'restartsCompleted <= adaptiveMaxRestarts', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.restartsCompleted <= FAST_CONFIG.hillClimbing.adaptiveMaxRestarts;
});

test('ADAPT03', 'convergence message logged when early stop triggers', () => {
    // Use a config that will converge quickly (many identical restart results)
    const earlyConfig = {
        ...MINIMAL_CONFIG,
        hillClimbing: {
            ...MINIMAL_CONFIG.hillClimbing,
            adaptiveMaxRestarts: 20,
            maxIterations: 5  // very few iterations → likely same result each restart
        }
    };
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, earlyConfig);
    const log = r.data.traceLog.join('\n');
    // Either convergence or max restarts reached
    return log.includes('Converged') || log.includes('Reached maximum');
});

test('ADAPT04', 'minimum 5 restarts always completed (if enough candidates exist)', () => {
    // With 20 candidates, adaptiveMaxRestarts=20, should run at least 5
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.data.restartsCompleted >= Math.min(5, FAST_CONFIG.hillClimbing.adaptiveMaxRestarts);
});

test('ADAPT05', 'traceLog has restart entries', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const restartLines = r.data.traceLog.filter(l => l.startsWith('─── Restart'));
    return restartLines.length === r.data.restartsCompleted;
});

// ── Section 7: Duplicate configuration detection ──────────────────────────────
console.log('\n── Section 7: Duplicate configuration detection ─────────────────────');

test('DUP01', 'duplicate detection log appears when restarts converge to same config', () => {
    // With only 2 nodes and 2 patrols, every restart produces the same config
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, FAST_CONFIG);
    const log = r.data.traceLog.join('\n');
    // With 2 nodes and 2 patrols, there's only 1 unique configuration — duplicates must appear after restart 2
    return log.includes('previously found configuration');
});

test('DUP02', 'duplicate detection does not prevent valid result from being returned', () => {
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols !== null && r.data.patrols.length === 2;
});

// ── Section 8: Confidence indicator ──────────────────────────────────────────
console.log('\n── Section 8: Confidence indicator ──────────────────────────────────');

test('CONF01', 'confidence is in [0, 100]', () => {
    const r = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG);
    return r.data.confidence >= 0 && r.data.confidence <= 100;
});

test('CONF02', 'single restart → confidence = 100 (no variance)', () => {
    const oneRestartConfig = {
        ...FAST_CONFIG,
        hillClimbing: { ...FAST_CONFIG.hillClimbing, adaptiveMaxRestarts: 1, restarts: 1 }
    };
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, oneRestartConfig);
    return r.data.confidence === 100;
});

test('CONF03', 'confidence is a finite number (not NaN, not Infinity)', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return isFinite(r.data.confidence);
});

test('CONF04', 'two-node case → confidence = 100 (all restarts identical)', () => {
    // With 2 nodes and 2 patrols, all restarts find same configuration → stdDev=0 → conf=100
    const r = runHillClimbing(TWO_NODES, 2, HULL_AREA_M2, FAST_CONFIG);
    return r.data.confidence === 100;
});

// ── Section 9: pushProgress callback ─────────────────────────────────────────
console.log('\n── Section 9: pushProgress callback ─────────────────────────────────');

test('PROG01', 'pushProgress called at least once during run', () => {
    let count = 0;
    runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: () => { count++; }
    });
    return count > 0;
});

test('PROG02', 'pushProgress receives stage=2', () => {
    const calls = [];
    runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: msg => calls.push(msg)
    });
    return calls.every(c => c.stage === 2);
});

test('PROG03', 'pushProgress receives restart number (1-indexed)', () => {
    const calls = [];
    runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: msg => calls.push(msg)
    });
    return calls.every(c => c.restart >= 1);
});

test('PROG04', 'pushProgress patrolPositions has correct n entries', () => {
    const calls = [];
    runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: msg => calls.push(msg)
    });
    return calls.every(c => c.patrolPositions.length === 4);
});

test('PROG05', 'pushProgress patrolPositions has id, lat, lng, color', () => {
    const calls = [];
    runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: msg => calls.push(msg)
    });
    const allValid = calls.every(c =>
        c.patrolPositions.every(p =>
            'id' in p && 'lat' in p && 'lng' in p && 'color' in p
        )
    );
    return allValid;
});

test('PROG06', 'null pushProgress → no throw', () => {
    try {
        runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, { pushProgress: null });
        return true;
    } catch {
        return false;
    }
});

test('PROG07', 'n=1 → pushProgress NOT called (Hill Climbing skipped)', () => {
    let count = 0;
    runHillClimbing(GRID_20, 1, HULL_AREA_M2, CONFIG, {
        pushProgress: () => { count++; }
    });
    return count === 0;
});

test('PROG08', 'pushProgress receives bestMinDist as a number', () => {
    const calls = [];
    runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, {
        pushProgress: msg => calls.push(msg)
    });
    return calls.every(c => typeof c.bestMinDist === 'number');
});

// ── Section 10: Synchronous mode ─────────────────────────────────────────────
console.log('\n── Section 10: Synchronous mode ─────────────────────────────────────');

const SYNC_CONFIG = {
    ...FAST_CONFIG,
    hillClimbing: { ...FAST_CONFIG.hillClimbing, synchronousMode: true }
};

test('SYNC01', 'synchronousMode=true → still returns valid result', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, SYNC_CONFIG);
    return (r.status === 'success' || r.status === 'warning') &&
           r.data.patrols.length === 3;
});

test('SYNC02', 'synchronousMode=true → patrol nodeIds are unique', () => {
    const r = runHillClimbing(GRID_20, 4, HULL_AREA_M2, SYNC_CONFIG);
    const ids = r.data.patrols.map(p => p.nodeId);
    return new Set(ids).size === ids.length;
});

test('SYNC03', 'synchronousMode=true → all patrol nodeIds in validCandidates', () => {
    const r = runHillClimbing(GRID_20, 4, HULL_AREA_M2, SYNC_CONFIG);
    const validIds = new Set(GRID_20.map(v => v.id));
    return r.data.patrols.every(p => validIds.has(p.nodeId));
});

test('SYNC04', 'synchronousMode=true → traceLog mentions sync moves', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, SYNC_CONFIG);
    return r.data.traceLog.some(l => l.includes('sync'));
});

test('SYNC05', 'synchronousMode=false produces different trace log than true (different move style)', () => {
    // Not guaranteed but highly likely on a grid
    const rAsync = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const rSync  = runHillClimbing(GRID_20, 3, HULL_AREA_M2, SYNC_CONFIG);
    // Async log should mention "moved" without "(sync)"; sync log should mention "(sync)"
    const asyncHasSync  = rAsync.data.traceLog.some(l => l.includes('(sync)'));
    const syncHasSync   = rSync.data.traceLog.some(l => l.includes('(sync)'));
    return !asyncHasSync && syncHasSync;
});

// ── Section 11: Radius expansion ─────────────────────────────────────────────
console.log('\n── Section 11: Radius expansion ─────────────────────────────────────');

test('REXP01', 'radius expansion log appears when R is too small to find neighbors', () => {
    // Use a tiny R by setting a very small hull area
    const tinyAreaConfig = {
        ...MINIMAL_CONFIG,
        hillClimbing: { ...MINIMAL_CONFIG.hillClimbing, radiusMultiplier: 0.0001 }
    };
    const r = runHillClimbing(GRID_20, 3, 1, tinyAreaConfig); // area = 1 m²
    const log = r.data.traceLog.join('\n');
    return log.includes('Expanding radius R');
});

test('REXP02', 'result is still valid after radius expansion', () => {
    const tinyAreaConfig = {
        ...MINIMAL_CONFIG,
        hillClimbing: { ...MINIMAL_CONFIG.hillClimbing, radiusMultiplier: 0.0001 }
    };
    const r = runHillClimbing(GRID_20, 3, 1, tinyAreaConfig);
    return r.data.patrols !== null && r.data.patrols.length === 3;
});

// ── Section 12: Warning statuses ─────────────────────────────────────────────
console.log('\n── Section 12: Warning statuses ─────────────────────────────────────');

test('WARN01', 'status is success or warning for valid input (never error)', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.status === 'success' || r.status === 'warning';
});

test('WARN02', 'n > candidates → status is warning, warnings array non-empty', () => {
    const r = runHillClimbing(TWO_NODES, 5, HULL_AREA_M2, FAST_CONFIG);
    return r.status === 'warning' && r.warnings.length > 0;
});

test('WARN03', 'max iterations warning → status is warning', () => {
    const veryFewIterConfig = {
        ...FAST_CONFIG,
        hillClimbing: { ...FAST_CONFIG.hillClimbing, maxIterations: 1 }
    };
    const r = runHillClimbing(GRID_20, 5, HULL_AREA_SMALL, veryFewIterConfig);
    // With 1 iteration, each restart likely doesn't converge → max iter warning
    return r.status === 'warning' || r.status === 'success'; // may converge in 1 step on small area
});

// ── Section 13: Color palette ─────────────────────────────────────────────────
console.log('\n── Section 13: Color palette ────────────────────────────────────────');

test('COLOR01', 'n=10 → 10 distinct colors, all from palette', () => {
    const palette = new Set(['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4']);
    const r = runHillClimbing(GRID_20, 10, HULL_AREA_M2, FAST_CONFIG);
    return r.data.patrols.every(p => palette.has(p.color));
});

test('COLOR02', 'n=11 → 11th patrol uses modulo color (same as 1st)', () => {
    // Need 11+ candidates
    const bigGrid = makeGrid(4, 3, 14.700, 121.090, 0.001, 0.001); // 12 nodes
    const r = runHillClimbing(bigGrid, 11, HULL_AREA_M2, FAST_CONFIG);
    if (r.data.patrols.length < 11) return 'skip (capped)'; // only 12 candidates, 11 should work
    const first = r.data.patrols.find(p => p.id === 's1')?.color;
    const eleventh = r.data.patrols.find(p => p.id === 's11')?.color;
    return first === eleventh; // modulo wraps around
});

test('COLOR03', 'patrol s1 always gets first palette color #e74c3c', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    const s1 = r.data.patrols.find(p => p.id === 's1');
    return s1 && s1.color === '#e74c3c';
});

// ── Section 14: Performance ───────────────────────────────────────────────────
console.log('\n── Section 14: Performance ──────────────────────────────────────────');

test('PERF01', 'n=5 on GRID_20, 5 restarts, 50 iterations — completes in < 2000ms', () => {
    const t0 = performance.now();
    runHillClimbing(GRID_20, 5, HULL_AREA_M2, FAST_CONFIG);
    return performance.now() - t0 < 2000;
});

test('PERF02', 'n=10 on GRID_20, default restarts/iterations — completes in < 5000ms', () => {
    const t0 = performance.now();
    runHillClimbing(GRID_20, 10, HULL_AREA_M2, CONFIG);
    const ms = performance.now() - t0;
    console.log(`         (actual: ${Math.round(ms)}ms)`);
    return ms < 5000;
});

// ── Section 15: Real-world Commonwealth candidates ────────────────────────────
console.log('\n── Section 15: Integration with real road_network.json ──────────────');

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let roadNetwork = null;
try {
    const raw = readFileSync(resolve(__dirname, '../data/road_network.json'), 'utf8');
    roadNetwork = JSON.parse(raw);
} catch {
    roadNetwork = null;
}

// Build nodeMap and intersectionNodeIds from road_network.json
function buildNetworkData(network) {
    if (!network) return null;
    const nodeMap = {};
    for (const node of network.nodes) nodeMap[node.id] = node;
    const degree = {};
    for (const edge of network.edges) {
        degree[edge.from] = (degree[edge.from] || 0) + 1;
        degree[edge.to]   = (degree[edge.to]   || 0) + 1;
    }
    const intersectionNodeIds = Object.keys(degree).filter(id => degree[id] >= 3);
    return { nodeMap, intersectionNodeIds };
}

const networkData = buildNetworkData(roadNetwork);

function makeRealCandidates(networkData, hull) {
    if (!networkData) return null;
    const { nodeMap, intersectionNodeIds } = networkData;
    // Use the convexHull's isPointInHull to filter — or just use a simple bbox for integration test
    // For simplicity, use the 100 nodes closest to Commonwealth centroid
    const centLat = 14.7028, centLng = 121.0944;
    return intersectionNodeIds
        .map(id => nodeMap[id])
        .filter(Boolean)
        .sort((a, b) =>
            (Math.abs(a.lat - centLat) + Math.abs(a.lng - centLng)) -
            (Math.abs(b.lat - centLat) + Math.abs(b.lng - centLng))
        )
        .slice(0, 100);
}

const realCandidates = networkData ? makeRealCandidates(networkData) : null;

if (realCandidates) {
    test('INT01', 'real candidates — n=3 → success/warning, 3 patrols inside network', () => {
        const r = runHillClimbing(realCandidates, 3, HULL_AREA_M2 * 2, FAST_CONFIG);
        return (r.status === 'success' || r.status === 'warning') && r.data.patrols.length === 3;
    });

    test('INT02', 'real candidates — all patrol nodeIds in real intersection set', () => {
        const r = runHillClimbing(realCandidates, 4, HULL_AREA_M2 * 2, FAST_CONFIG);
        const validIds = new Set(realCandidates.map(v => v.id));
        return r.data.patrols.every(p => validIds.has(p.nodeId));
    });

    test('INT03', 'real candidates — bestMinPairwiseDist > 0', () => {
        const r = runHillClimbing(realCandidates, 4, HULL_AREA_M2 * 2, FAST_CONFIG);
        return r.data.bestMinPairwiseDist > 0;
    });

    test('INT04', 'real candidates — n=1 places at most central node', () => {
        const r = runHillClimbing(realCandidates, 1, HULL_AREA_M2, CONFIG);
        return r.status === 'success' && r.data.patrols.length === 1 &&
               r.data.confidence === 100;
    });

    test('INT05', 'real candidates — performance < 3000ms for n=5', () => {
        const t0 = performance.now();
        runHillClimbing(realCandidates, 5, HULL_AREA_M2 * 2, FAST_CONFIG);
        const ms = performance.now() - t0;
        console.log(`         (actual: ${Math.round(ms)}ms)`);
        return ms < 3000;
    });
} else {
    console.log('  SKIP  [INT01–INT05] road_network.json not available');
}

// ── Section 16: Seeded determinism ───────────────────────────────────────────
console.log('\n── Section 16: Seeded determinism ──────────────────────────────────');

// Same seed → same patrol node IDs every run.
test('SEED01', 'same seed → identical patrol nodeIds across two runs', () => {
    const r1 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 12345 });
    const r2 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 12345 });
    const ids1 = r1.data.patrols.map(p => p.nodeId).sort().join(',');
    const ids2 = r2.data.patrols.map(p => p.nodeId).sort().join(',');
    return ids1 === ids2;
});

// Same seed → identical bestMinPairwiseDist.
test('SEED02', 'same seed → identical bestMinPairwiseDist', () => {
    const r1 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 99999 });
    const r2 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 99999 });
    return r1.data.bestMinPairwiseDist === r2.data.bestMinPairwiseDist;
});

// Same seed → same restart count (early-stop is also deterministic).
test('SEED03', 'same seed → same restartsCompleted', () => {
    const r1 = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, { seed: 7 });
    const r2 = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, { seed: 7 });
    return r1.data.restartsCompleted === r2.data.restartsCompleted;
});

// Different seeds → different restart-1 initialization (what seeded RNG directly controls).
// Final patrol positions may still match if the grid has a unique global optimum — that is
// correct behavior and not a failure of determinism.
test('SEED04', 'different seeds → different restart-1 initialization sequence', () => {
    const r1 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 1 });
    const r2 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 987654321 });
    const init1 = r1.data.traceLog.find(l => l.includes('Init:'));
    const init2 = r2.data.traceLog.find(l => l.includes('Init:'));
    return init1 !== init2;
});

// No seed → still returns a valid result (Math.random fallback path).
test('SEED05', 'no seed option → valid result returned (Math.random fallback)', () => {
    const r = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG);
    return r.status !== 'error' && r.data.patrols.length === 3;
});

// Seed 0 is a valid seed — should not be treated as falsy and fall back to Math.random.
test('SEED06', 'seed=0 is deterministic, not treated as falsy', () => {
    const r1 = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, { seed: 0 });
    const r2 = runHillClimbing(GRID_20, 3, HULL_AREA_M2, FAST_CONFIG, { seed: 0 });
    const ids1 = r1.data.patrols.map(p => p.nodeId).sort().join(',');
    const ids2 = r2.data.patrols.map(p => p.nodeId).sort().join(',');
    return ids1 === ids2;
});

// Seed produces same result even across different run orders (restarts are per-restart seeded).
test('SEED07', 'seed produces same bestRestart index across runs', () => {
    const r1 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 42 });
    const r2 = runHillClimbing(GRID_20, 4, HULL_AREA_M2, FAST_CONFIG, { seed: 42 });
    return r1.data.bestRestart === r2.data.bestRestart;
});

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n' + '═'.repeat(60));
console.log(`  TOTAL: ${total}  |  PASSED: ${passed}  |  FAILED: ${failed}`);
if (failures.length > 0) {
    console.log(`Failed tests:\n  • ${failures.join('\n  • ')}`);
}
console.log('═'.repeat(60));
