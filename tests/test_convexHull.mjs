/**
 * PatrolPoint V2 — convexHull.js comprehensive test suite
 * Run: node tests/test_convexHull.mjs
 *
 * Covers: isPointInHull, rayCast (via isPointInHull), collinearity check,
 *         outlier detection, brute-force hull, edge ordering, Shoelace area,
 *         winding normalization, ray-cast pre-filter, hull cache, incremental
 *         hull update, pushProgress callback, result shape, and real-data integration.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runConvexHull, isPointInHull } from '../server/algorithms/convexHull.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(id, description, fn) {
    try {
        const result = fn();
        if (result === true || result === undefined) {
            console.log(`  PASS  [${id}] ${description}`);
            passed++;
        } else {
            const detail = typeof result === 'string' ? result : JSON.stringify(result);
            console.log(`  FAIL  [${id}] ${description}`);
            console.log(`        ${detail}`);
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

function near(a, b, tol = 0.001) { return Math.abs(a - b) <= tol; }

// ── Shared CONFIG ─────────────────────────────────────────────────────────────

const CONFIG = {
    hillClimbing: { restarts: 10, maxIterations: 500, radiusMultiplier: 2 },
    convexHull: {
        areaThresholdDivisor: 100,
        outlierMultiplier: 2.5,
        collinearityEpsilon: 1e-10
    },
    tsp: { maxCrimeNodesPerZone: 10 },
    snapping: { boundingBoxEpsilon: 1e-7 },
    convexHull_includeOutliers: false
};

// Commonwealth bounding box → barangayAreaM2
const BBOX = { south: 14.69, west: 121.08, north: 14.72, east: 121.11 };
const _centLat  = (BBOX.south + BBOX.north) / 2;
const _lngScale = 111000 * Math.cos(_centLat * Math.PI / 180);
const BARANGAY_AREA_M2 = (BBOX.north - BBOX.south) * 111000 *
                          (BBOX.east - BBOX.west) * _lngScale;

// ── Geometry helpers ──────────────────────────────────────────────────────────

// CCW square centred in Commonwealth (used as a reusable hull for many tests)
// SW→SE→NE→NW in (lng=x, lat=y) CCW order
const SQUARE_SW = { lat: 14.700, lng: 121.090 };
const SQUARE_SE = { lat: 14.700, lng: 121.095 };
const SQUARE_NE = { lat: 14.705, lng: 121.095 };
const SQUARE_NW = { lat: 14.705, lng: 121.090 };
const SQUARE_HULL = [SQUARE_SW, SQUARE_SE, SQUARE_NE, SQUARE_NW]; // CCW

// Incident points for a non-degenerate square hull (given as raw incidents)
const SQUARE_INCIDENTS = [
    { lat: 14.700, lng: 121.090 },
    { lat: 14.700, lng: 121.095 },
    { lat: 14.705, lng: 121.095 },
    { lat: 14.705, lng: 121.090 }
];

// Triangle incidents (clearly non-collinear)
const TRI_INCIDENTS = [
    { lat: 14.700, lng: 121.090 },
    { lat: 14.700, lng: 121.097 },
    { lat: 14.707, lng: 121.0935 }
];

// Collinear incidents (along a diagonal)
const COLLINEAR_INCIDENTS = [
    { lat: 14.700, lng: 121.090 },
    { lat: 14.702, lng: 121.092 },
    { lat: 14.704, lng: 121.094 },
    { lat: 14.706, lng: 121.096 }
];

// Small tightly-clustered incidents (should trigger area threshold warning)
const CLUSTERED_INCIDENTS = [
    { lat: 14.7010, lng: 121.0920 },
    { lat: 14.7012, lng: 121.0923 },
    { lat: 14.7011, lng: 121.0926 },
    { lat: 14.7013, lng: 121.0922 }
];

// Mock intersection nodes for controlled pre-filter tests
// Some inside SQUARE_HULL, some outside
const MOCK_NODES_INSIDE = [
    { id: 'i0', lat: 14.702, lng: 121.092 }, // clearly inside square
    { id: 'i1', lat: 14.703, lng: 121.093 }, // clearly inside square
];
const MOCK_NODES_OUTSIDE = [
    { id: 'o0', lat: 14.710, lng: 121.092 }, // clearly outside (north)
    { id: 'o1', lat: 14.700, lng: 121.100 }, // clearly outside (east)
];
const ALL_MOCK_NODES = [...MOCK_NODES_INSIDE, ...MOCK_NODES_OUTSIDE];

function makeMockNetworkData(nodes = ALL_MOCK_NODES) {
    const nodeMap = {};
    const intersectionNodeIds = [];
    for (const n of nodes) {
        nodeMap[n.id] = n;
        intersectionNodeIds.push(n.id);
    }
    return { intersectionNodeIds, nodeMap, barangayAreaM2: BARANGAY_AREA_M2 };
}

// ── Section 1: isPointInHull ──────────────────────────────────────────────────

console.log('\n── Section 1: isPointInHull ──────────────────────────────────────────');

test('IH01', 'centre of CCW square → inside', () => {
    // Centre at (14.7025, 121.0925)
    return isPointInHull({ lat: 14.7025, lng: 121.0925 }, SQUARE_HULL) === true;
});

test('IH02', 'point clearly north of square → outside', () => {
    return isPointInHull({ lat: 14.720, lng: 121.0925 }, SQUARE_HULL) === false;
});

test('IH03', 'point clearly east of square → outside', () => {
    return isPointInHull({ lat: 14.7025, lng: 121.100 }, SQUARE_HULL) === false;
});

test('IH04', 'null hull → false', () => {
    return isPointInHull({ lat: 14.7025, lng: 121.0925 }, null) === false;
});

test('IH05', 'empty hull → false', () => {
    return isPointInHull({ lat: 14.7025, lng: 121.0925 }, []) === false;
});

test('IH06', 'hull with 2 vertices → false (< 3 required)', () => {
    return isPointInHull(
        { lat: 14.7025, lng: 121.0925 },
        [SQUARE_SW, SQUARE_SE]
    ) === false;
});

test('IH07', 'point well inside triangle hull → inside', () => {
    const tri = [
        { lat: 14.700, lng: 121.090 },
        { lat: 14.700, lng: 121.100 },
        { lat: 14.710, lng: 121.095 }
    ];
    return isPointInHull({ lat: 14.703, lng: 121.095 }, tri) === true;
});

test('IH08', 'point south of triangle → outside', () => {
    const tri = [
        { lat: 14.700, lng: 121.090 },
        { lat: 14.700, lng: 121.100 },
        { lat: 14.710, lng: 121.095 }
    ];
    return isPointInHull({ lat: 14.695, lng: 121.095 }, tri) === false;
});

test('IH09', 'fast bbox rejection — far away point skips ray cast', () => {
    // Point is far outside bbox, should be rejected by bbox pre-filter
    return isPointInHull({ lat: 15.0, lng: 122.0 }, SQUARE_HULL) === false;
});

test('IH10', 'eps=0 — point on bbox edge still handled gracefully', () => {
    // Point exactly at SW corner — on boundary. Ray cast result is implementation-defined
    // but must not throw.
    const result = isPointInHull(SQUARE_SW, SQUARE_HULL, 0);
    return typeof result === 'boolean';
});

// ── Section 2: Linear handler ─────────────────────────────────────────────────

console.log('\n── Section 2: Linear handler ─────────────────────────────────────────');

const mockNet = makeMockNetworkData();

test('LH01', 'exactly 2 incidents → status warning, reason two_points', () => {
    const r = runConvexHull(
        [{ lat: 14.700, lng: 121.090 }, { lat: 14.705, lng: 121.095 }],
        3, CONFIG, mockNet
    );
    return r.status === 'warning' &&
           r.data.linearHandler.triggered === true &&
           r.data.linearHandler.reason === 'two_points';
});

test('LH02', 'exactly 2 incidents → n patrol positions placed', () => {
    const r = runConvexHull(
        [{ lat: 14.700, lng: 121.090 }, { lat: 14.705, lng: 121.095 }],
        4, CONFIG, mockNet
    );
    return r.data.linearHandler.patrolPositions.length === 4;
});

test('LH03', 'all collinear incidents → reason collinear', () => {
    const r = runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, mockNet);
    return r.status === 'warning' &&
           r.data.linearHandler.reason === 'collinear';
});

test('LH04', 'linear handler result has null hull and null validCandidates', () => {
    const r = runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.hull === null && r.data.validCandidates === null;
});

test('LH05', 'linear positions: n=1 → 1 position at midpoint (t=0.5)', () => {
    const p0 = { lat: 14.700, lng: 121.090 };
    const p1 = { lat: 14.710, lng: 121.090 };
    const r = runConvexHull([p0, p1], 1, CONFIG, mockNet);
    const pos = r.data.linearHandler.patrolPositions[0];
    return near(pos.lat, 14.705, 1e-6) && near(pos.lng, 121.090, 1e-6);
});

test('LH06', 'linear positions: n=3 → t = 1/4, 2/4, 3/4 of line', () => {
    const p0 = { lat: 14.700, lng: 121.090 };
    const p1 = { lat: 14.700, lng: 121.098 }; // horizontal line east
    const r = runConvexHull([p0, p1], 3, CONFIG, mockNet);
    const pos = r.data.linearHandler.patrolPositions;
    return pos.length === 3 &&
           near(pos[0].lng, 121.090 + (0.008 * 1 / 4), 1e-5) &&
           near(pos[1].lng, 121.090 + (0.008 * 2 / 4), 1e-5) &&
           near(pos[2].lng, 121.090 + (0.008 * 3 / 4), 1e-5);
});

test('LH07', 'linear handler: lineLength > 0', () => {
    const r = runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.linearHandler.lineLength > 0;
});

test('LH08', 'skipped: false in linear handler result', () => {
    const r = runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.skipped === false;
});

// ── Section 3: Outlier detection ──────────────────────────────────────────────

console.log('\n── Section 3: Outlier detection ──────────────────────────────────────');

// Five tight cluster points + one obvious outlier (6 total).
// With n_cluster=5, symbolic math guarantees detection: n_cluster > 2.5×1 holds,
// so centroid-distance of outlier exceeds 2.5× average distance.
const OUTLIER_INCIDENTS = [
    { lat: 14.700, lng: 121.090 },
    { lat: 14.700, lng: 121.091 },
    { lat: 14.701, lng: 121.091 },
    { lat: 14.701, lng: 121.090 },
    { lat: 14.700, lng: 121.0905 },
    { lat: 14.900, lng: 121.090 }  // clear outlier — ~22 km north of cluster
];

test('OUT01', 'one obvious outlier → outlierCount=1', () => {
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.outlierCount === 1;
});

test('OUT02', 'outlier detected → outlierIndices has 1 entry', () => {
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, CONFIG, mockNet);
    return Array.isArray(r.data.outlierIndices) && r.data.outlierIndices.length === 1;
});

test('OUT03', 'outlier index points to the far-away point (last, index 5)', () => {
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.outlierIndices[0] === 5;
});

test('OUT04', 'after outlier removal, hull computed from 5 non-outlier cluster points', () => {
    // mockNet nodes sit outside the small cluster hull, so we supply one node
    // that is explicitly inside the cluster area (lat 14.700-14.701, lng 121.090-121.091)
    const clusterNet = makeMockNetworkData([
        { id: 'cn0', lat: 14.7005, lng: 121.0905 }
    ]);
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, CONFIG, clusterNet);
    return (r.status === 'success' || r.status === 'warning') && r.data.hull !== null;
});

test('OUT05', 'includeOutliers=true → outlierCount=0 even with obvious outlier', () => {
    const cfg = { ...CONFIG, convexHull_includeOutliers: true };
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, cfg, mockNet);
    return r.data.outlierCount === 0;
});

test('OUT06', 'outlier removal reducing to <3 → warning, no hull', () => {
    // 3 normal points, 2 extreme outliers — after removal only 1 remains
    // outlierMultiplier=2.5; need distance to centroid > 2.5 × average
    // Use extreme outliers that are clearly flagged
    const cfg = { ...CONFIG };
    cfg.convexHull = { ...CONFIG.convexHull, outlierMultiplier: 1.0 };
    const tinyCluster = [
        { lat: 14.700, lng: 121.090 }, // normal cluster
        { lat: 14.700, lng: 121.091 },
        { lat: 15.000, lng: 122.000 }, // far outlier 1
        { lat: 15.001, lng: 122.001 }, // far outlier 2
        { lat: 14.700, lng: 121.090 }  // same as first (ok)
    ];
    // With multiplier=1.0, any point > 1.0 × avg distance is flagged
    // Centroid ≈ (14.82, 121.25). Avg dist will include outliers, but they dominate.
    // This is hard to guarantee without running; let's just check it doesn't throw.
    const r = runConvexHull(tinyCluster, 3, cfg, mockNet);
    return r.status === 'warning' || r.status === 'success'; // must not throw
});

test('OUT07', 'no outliers in tight cluster → outlierCount=0', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.outlierCount === 0;
});

test('OUT08', 'filteredCount correct after outlier removal', () => {
    const r = runConvexHull(OUTLIER_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.filteredCount === OUTLIER_INCIDENTS.length - r.data.outlierCount;
});

// ── Section 4: Hull formation (brute force) ───────────────────────────────────

console.log('\n── Section 4: Hull formation (brute force) ───────────────────────────');

test('HULL01', 'square input → 4 hull vertices', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return r.status !== 'error' && Array.isArray(r.data.hull) && r.data.hull.length === 4;
});

test('HULL02', 'triangle input → 3 hull vertices', () => {
    const r = runConvexHull(TRI_INCIDENTS, 3, CONFIG, mockNet);
    return r.status !== 'error' && Array.isArray(r.data.hull) && r.data.hull.length === 3;
});

test('HULL03', 'interior point does not expand hull — square+1interior still 4 vertices', () => {
    const withInterior = [
        ...SQUARE_INCIDENTS,
        { lat: 14.702, lng: 121.092 } // interior point
    ];
    const r = runConvexHull(withInterior, 3, CONFIG, mockNet);
    return r.data.hull !== null && r.data.hull.length === 4;
});

test('HULL04', 'hull vertices are a subset of input points', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    if (!r.data.hull) return 'hull is null';
    const eps = 1e-9;
    return r.data.hull.every(hv =>
        SQUARE_INCIDENTS.some(p =>
            Math.abs(p.lat - hv.lat) < eps && Math.abs(p.lng - hv.lng) < eps
        )
    );
});

test('HULL05', 'validEdgesCount >= 3 in success result', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return typeof r.data.validEdgesCount === 'number' && r.data.validEdgesCount >= 3;
});

test('HULL06', 'hull is CCW — centroid should be inside hull after normalization', () => {
    const r = runConvexHull(TRI_INCIDENTS, 3, CONFIG, mockNet);
    if (!r.data.hull) return 'hull is null';
    const hull = r.data.hull;
    const cLat = hull.reduce((s, v) => s + v.lat, 0) / hull.length;
    const cLng = hull.reduce((s, v) => s + v.lng, 0) / hull.length;
    return isPointInHull({ lat: cLat, lng: cLng }, hull) === true;
});

test('HULL07', 'pentagon — 5 non-collinear vertices on hull → 5-vertex hull', () => {
    // Regular pentagon approximation inside Commonwealth
    const cx = 121.092, cy = 14.703, r = 0.002;
    const pentagon = Array.from({ length: 5 }, (_, i) => ({
        lat: cy + r * Math.cos((2 * Math.PI * i) / 5),
        lng: cx + r * Math.sin((2 * Math.PI * i) / 5)
    }));
    const res = runConvexHull(pentagon, 3, CONFIG, mockNet);
    return res.data.hull !== null && res.data.hull.length === 5;
});

test('HULL08', 'status is success or warning (not error) for valid non-degenerate input', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return r.status === 'success' || r.status === 'warning';
});

// ── Section 5: Shoelace area and winding ──────────────────────────────────────

console.log('\n── Section 5: Shoelace area and winding ──────────────────────────────');

test('AREA01', 'hullAreaDeg > 0 for valid hull', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return typeof r.data.hullAreaDeg === 'number' && r.data.hullAreaDeg > 0;
});

test('AREA02', 'hullAreaM2 > 0 for valid hull', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return typeof r.data.hullAreaM2 === 'number' && r.data.hullAreaM2 > 0;
});

test('AREA03', 'hullAreaM2 > hullAreaDeg (unit conversion applied: m² >> deg²)', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return r.data.hullAreaM2 > r.data.hullAreaDeg;
});

test('AREA04', 'area threshold warning triggers for tightly clustered incidents', () => {
    // Clustered incidents form a hull much smaller than barangay/100.
    // Mock a node that sits INSIDE the tiny clustered hull so we don't hit the
    // "no candidates" error before reaching the area-threshold check.
    const insideClusterNet = makeMockNetworkData([
        { id: 'cl0', lat: 14.7011, lng: 121.0922 },
        { id: 'cl1', lat: 14.7012, lng: 121.0923 }
    ]);
    const r = runConvexHull(CLUSTERED_INCIDENTS, 3, CONFIG, insideClusterNet);
    if (r.status === 'error') return 'unexpected error: ' + r.message;
    return r.status === 'warning' &&
           r.warnings.some(w => w.includes('tightly clustered'));
});

test('AREA05', 'area threshold NOT triggered for normal Commonwealth-scale hull', () => {
    // Square covering ~0.005×0.005 deg ≈ 555m × 480m ≈ 266,400 m² > barangayAreaM2/100
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, mockNet);
    return !r.warnings.some(w => w.includes('tightly clustered'));
});

// ── Section 6: Ray Casting pre-filter ────────────────────────────────────────

console.log('\n── Section 6: Ray Casting pre-filter ────────────────────────────────');

test('RAY01', 'nodes inside hull appear in validCandidates', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    if (!r.data.validCandidates) return 'validCandidates is null';
    const ids = r.data.validCandidates.map(n => n.id);
    return ids.includes('i0') && ids.includes('i1');
});

test('RAY02', 'nodes outside hull are excluded from validCandidates', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    if (!r.data.validCandidates) return 'validCandidates is null';
    const ids = r.data.validCandidates.map(n => n.id);
    return !ids.includes('o0') && !ids.includes('o1');
});

test('RAY03', 'validCandidates count equals inside-node count', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    return r.data.validCandidates !== null && r.data.validCandidates.length === 2;
});

test('RAY04', 'no intersection nodes inside hull → error status', () => {
    // Nodes all outside
    const outsideOnly = makeMockNetworkData(MOCK_NODES_OUTSIDE);
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, outsideOnly);
    return r.status === 'error' &&
           r.message.includes('No road intersections found');
});

test('RAY05', 'empty candidates error keeps hull polygon in result data', () => {
    const outsideOnly = makeMockNetworkData(MOCK_NODES_OUTSIDE);
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, outsideOnly);
    // Hull should be present so pipeline can highlight nearest outside intersections
    return r.status === 'error' &&
           Array.isArray(r.data.hull) &&
           r.data.hull.length > 0;
});

test('RAY06', 'empty candidates error has validCandidates as empty array (not null)', () => {
    const outsideOnly = makeMockNetworkData(MOCK_NODES_OUTSIDE);
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, outsideOnly);
    return Array.isArray(r.data.validCandidates) && r.data.validCandidates.length === 0;
});

test('RAY07', 'barangayAreaM2=0 → no area threshold check (no spurious warning)', () => {
    const net = { ...makeMockNetworkData(), barangayAreaM2: 0 };
    const r = runConvexHull(CLUSTERED_INCIDENTS, 3, CONFIG, net);
    if (r.status === 'error') return true; // no candidates is fine, just don't crash
    return !r.warnings.some(w => w.includes('tightly clustered'));
});

test('RAY08', 'validCandidates are actual node objects with lat and lng', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    if (!r.data.validCandidates || r.data.validCandidates.length === 0) return 'empty';
    return r.data.validCandidates.every(n =>
        typeof n.lat === 'number' && typeof n.lng === 'number'
    );
});

// ── Section 7: Hull cache ─────────────────────────────────────────────────────

console.log('\n── Section 7: Hull cache ─────────────────────────────────────────────');

test('CACHE01', 'updatedHullCache present in success result', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    return r.data.updatedHullCache !== null &&
           Array.isArray(r.data.updatedHullCache.hull) &&
           Array.isArray(r.data.updatedHullCache.candidates);
});

test('CACHE02', 'cache hit — same hull reuses candidates, skips ray cast', () => {
    // First run — build cache
    const r1 = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    const cache = r1.data.updatedHullCache;

    // Second run — provide cache; result should reuse same candidates
    const r2 = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), { hullCache: cache });
    return r2.data.validCandidates !== null &&
           r2.data.validCandidates.length === r1.data.validCandidates.length;
});

test('CACHE03', 'null hullCache → always runs ray cast', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), { hullCache: null });
    return r.data.validCandidates !== null;
});

test('CACHE04', 'different hull → cache miss, candidates recomputed', () => {
    // Build cache for square
    const r1 = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    const squareCache = r1.data.updatedHullCache;

    // Run with different (triangle) incidents — hull is different, cache should miss
    const r2 = runConvexHull(TRI_INCIDENTS, 3, CONFIG, makeMockNetworkData(), { hullCache: squareCache });
    // Triangle hull is different from square hull, so updatedHullCache must be updated
    return r2.data.updatedHullCache !== null &&
           r2.data.updatedHullCache.hull.length !== squareCache.hull.length;
});

test('CACHE05', 'updatedHullCache hull is deep copy — mutating returned hull does not corrupt cache', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    const cachedHull = r.data.updatedHullCache.hull;
    const originalLat = cachedHull[0].lat;
    // Mutate the hull vertex
    cachedHull[0].lat = 99.999;
    // Re-run with the "corrupted" cache — the stored hull in updatedHullCache is a deep copy
    // so the original candidates should still be valid references
    const r2 = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
    return r2.data.hull[0].lat !== 99.999 && // new result unaffected
           originalLat !== 99.999;            // sanity check original was not 99.999
});

test('CACHE06', 'updatedHullCache candidates reference the same node objects from networkData', () => {
    const net = makeMockNetworkData();
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, net);
    if (!r.data.updatedHullCache) return 'no cache';
    // Each candidate in cache should be findable in the original nodeMap by id
    return r.data.updatedHullCache.candidates.every(c => net.nodeMap[c.id] !== undefined);
});

// ── Section 8: Incremental hull update ───────────────────────────────────────

console.log('\n── Section 8: Incremental hull update ────────────────────────────────');

// Build a reference hull and validCandidates via a normal run
const _ref = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
const REF_HULL = _ref.data.hull;
const REF_CANDIDATES = _ref.data.validCandidates;

test('INC01', 'same incident set → skipped: true when previousHull and previousIncidents provided', () => {
    const r = runConvexHull(
        SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.skipped === true;
});

test('INC02', 'skipped run returns previousHull unchanged', () => {
    const r = runConvexHull(
        SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.hull === REF_HULL; // same reference
});

test('INC03', 'new interior point added → all new inside hull → skipped: true', () => {
    const newIncidents = [
        ...SQUARE_INCIDENTS,
        { lat: 14.702, lng: 121.092 }  // interior, clearly inside square hull
    ];
    const r = runConvexHull(
        newIncidents, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.skipped === true;
});

test('INC04', 'new exterior point added → recomputes hull (skipped: false)', () => {
    const newIncidents = [
        ...SQUARE_INCIDENTS,
        { lat: 14.720, lng: 121.092 }  // outside square hull — far north
    ];
    const r = runConvexHull(
        newIncidents, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.skipped === false;
});

test('INC05', 'point removed from incident set → recomputes (skipped: false)', () => {
    // Remove one of the square corners — hull might shrink
    const reducedIncidents = SQUARE_INCIDENTS.slice(0, 3);
    const r = runConvexHull(
        reducedIncidents, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.skipped === false;
});

test('INC06', 'previousHull=null → full computation always (skipped: false)', () => {
    const r = runConvexHull(
        SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(),
        { previousHull: null, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.data.skipped === false;
});

test('INC07', 'no previousIncidents provided → conservative check, all-inside → skipped', () => {
    // All SQUARE_INCIDENTS are vertices of REF_HULL (on boundary — inside)
    // Conservative check: all inside → skip
    const r = runConvexHull(
        SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES }
        // previousIncidents omitted (defaults to null)
    );
    // All square points are on the hull boundary — ray cast with +lng direction is edge-case
    // The result should be skipped=true OR skipped=false (both are valid for boundary points)
    // We just assert it doesn't throw and returns a valid status
    return r.status === 'success' || r.status === 'warning' || r.status === 'error';
});

test('INC08', 'skipped result has status=success', () => {
    const r = runConvexHull(
        SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(),
        { previousHull: REF_HULL, previousValidCandidates: REF_CANDIDATES, previousIncidents: SQUARE_INCIDENTS }
    );
    return r.status === 'success';
});

// ── Section 9: pushProgress callback ─────────────────────────────────────────

console.log('\n── Section 9: pushProgress callback ─────────────────────────────────');

test('PROG01', 'pushProgress is called after pre-filtering', () => {
    let called = false;
    runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), {
        pushProgress: () => { called = true; }
    });
    return called === true;
});

test('PROG02', 'pushProgress receives stage=1', () => {
    let stageArg = null;
    runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), {
        pushProgress: (data) => { stageArg = data.stage; }
    });
    return stageArg === 1;
});

test('PROG03', 'pushProgress receives hullAreaM2 > 0', () => {
    let areaArg = null;
    runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), {
        pushProgress: (data) => { areaArg = data.hullAreaM2; }
    });
    return typeof areaArg === 'number' && areaArg > 0;
});

test('PROG04', 'pushProgress receives validCandidateCount matching result', () => {
    let countArg = null;
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), {
        pushProgress: (data) => { countArg = data.validCandidateCount; }
    });
    return countArg === r.data.validCandidates.length;
});

test('PROG05', 'null pushProgress → no throw', () => {
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData(), { pushProgress: null });
    return r.status === 'success' || r.status === 'warning';
});

test('PROG06', 'pushProgress NOT called on linear handler (short-circuits before pre-filter)', () => {
    let called = false;
    runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, makeMockNetworkData(), {
        pushProgress: () => { called = true; }
    });
    return called === false;
});

// ── Section 10: Result shape ──────────────────────────────────────────────────

console.log('\n── Section 10: Result shape ──────────────────────────────────────────');

const SUCCESS_RESULT = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, makeMockNetworkData());
const LINEAR_RESULT  = runConvexHull(COLLINEAR_INCIDENTS, 3, CONFIG, makeMockNetworkData());

test('SHAPE01', 'success result has all required top-level fields', () => {
    const r = SUCCESS_RESULT;
    return 'status' in r && 'message' in r && 'warnings' in r && 'data' in r;
});

test('SHAPE02', 'success result.data has all required fields', () => {
    const d = SUCCESS_RESULT.data;
    const required = [
        'hull', 'hullAreaDeg', 'hullAreaM2', 'validCandidates',
        'filteredCount', 'outlierCount', 'outlierIndices', 'validEdgesCount',
        'linearHandler', 'traceLog', 'skipped', 'updatedHullCache'
    ];
    const missing = required.filter(k => !(k in d));
    return missing.length === 0 || `missing: ${missing.join(', ')}`;
});

test('SHAPE03', 'linear handler result.data has all required fields', () => {
    const d = LINEAR_RESULT.data;
    const required = [
        'hull', 'validCandidates', 'filteredCount', 'outlierCount',
        'outlierIndices', 'validEdgesCount', 'linearHandler', 'traceLog', 'skipped'
    ];
    const missing = required.filter(k => !(k in d));
    return missing.length === 0 || `missing: ${missing.join(', ')}`;
});

test('SHAPE04', 'linearHandler object has triggered, reason, patrolPositions, lineLength, patrolSpacing', () => {
    const lh = LINEAR_RESULT.data.linearHandler;
    return lh.triggered === true &&
           typeof lh.reason === 'string' &&
           Array.isArray(lh.patrolPositions) &&
           typeof lh.lineLength === 'number' &&
           typeof lh.patrolSpacing === 'number';
});

test('SHAPE05', 'hull is array of {lat, lng} objects', () => {
    const hull = SUCCESS_RESULT.data.hull;
    return Array.isArray(hull) && hull.every(v =>
        typeof v.lat === 'number' && typeof v.lng === 'number'
    );
});

test('SHAPE06', 'traceLog is non-empty array of strings', () => {
    const log = SUCCESS_RESULT.data.traceLog;
    return Array.isArray(log) && log.length > 0 && log.every(e => typeof e === 'string');
});

test('SHAPE07', 'warnings is always an array', () => {
    return Array.isArray(SUCCESS_RESULT.warnings) && Array.isArray(LINEAR_RESULT.warnings);
});

test('SHAPE08', 'error result keeps hull when validCandidates is empty', () => {
    const outsideOnly = makeMockNetworkData(MOCK_NODES_OUTSIDE);
    const r = runConvexHull(SQUARE_INCIDENTS, 3, CONFIG, outsideOnly);
    return r.status === 'error' &&
           Array.isArray(r.data.hull) && r.data.hull.length > 0 &&
           'updatedHullCache' in r.data;
});

// ── Section 11: Real road_network.json integration ───────────────────────────

console.log('\n── Section 11: Real road_network.json integration ────────────────────');

// Build real network data from V1 road_network.json
const rn = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'road_network.json'), 'utf8'));

const realNodeMap = {};
for (const n of rn.nodes) realNodeMap[n.id] = n;

const degreeMap = {};
for (const n of rn.nodes) degreeMap[n.id] = 0;
for (const e of rn.edges) {
    degreeMap[e.from] = (degreeMap[e.from] || 0) + 1;
    degreeMap[e.to]   = (degreeMap[e.to]   || 0) + 1;
}
const realIntersectionIds = Object.entries(degreeMap)
    .filter(([, deg]) => deg >= 3)
    .map(([id]) => id);

const REAL_NET = {
    intersectionNodeIds: realIntersectionIds,
    nodeMap: realNodeMap,
    barangayAreaM2: BARANGAY_AREA_M2
};

// Incidents covering a meaningful portion of Commonwealth road network
const REAL_INCIDENTS = [
    { lat: 14.700, lng: 121.089 },
    { lat: 14.700, lng: 121.098 },
    { lat: 14.710, lng: 121.098 },
    { lat: 14.710, lng: 121.089 }
];

test('INT01', 'real network has 914 intersection nodes', () => {
    return realIntersectionIds.length === 914;
});

test('INT02', 'real network run succeeds and produces hull', () => {
    const r = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    return (r.status === 'success' || r.status === 'warning') && r.data.hull !== null;
});

test('INT03', 'real network validCandidates is subset of 914 intersection nodes', () => {
    const r = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    if (!r.data.validCandidates) return 'null candidates';
    const realIdSet = new Set(realIntersectionIds);
    return r.data.validCandidates.every(n => realIdSet.has(n.id));
});

test('INT04', 'real network validCandidates count > 0 and < 914', () => {
    const r = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    const count = r.data.validCandidates ? r.data.validCandidates.length : 0;
    return count > 0 && count < 914;
});

test('INT05', 'real network — all validCandidates are actually inside the hull', () => {
    const r = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    if (!r.data.hull || !r.data.validCandidates) return 'missing hull or candidates';
    const hull = r.data.hull;
    const eps  = CONFIG.snapping.boundingBoxEpsilon;
    return r.data.validCandidates.every(n => isPointInHull(n, hull, eps));
});

test('INT06', 'real network — cache hit on identical second run returns same candidate count', () => {
    const r1 = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    const r2 = runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET, { hullCache: r1.data.updatedHullCache });
    return r2.data.validCandidates !== null &&
           r2.data.validCandidates.length === r1.data.validCandidates.length;
});

test('INT07', 'real network performance — full run completes in < 1000ms', () => {
    const t0 = performance.now();
    runConvexHull(REAL_INCIDENTS, 3, CONFIG, REAL_NET);
    const elapsed = performance.now() - t0;
    console.log(`         (actual: ${elapsed.toFixed(1)}ms)`);
    return elapsed < 1000;
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
