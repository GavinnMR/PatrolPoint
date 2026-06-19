// test_zoneAssignment.js — comprehensive test suite for server/algorithms/zoneAssignment.js
// Run: node test_zoneAssignment.js

import { runZoneAssignment } from '../server/algorithms/zoneAssignment.js';
import { haversineDistance }  from '../server/algorithms/dijkstra.js';

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function section(name) { console.log(`\n▶ ${name}`); }
function ok(label, cond, got, want) {
    if (cond) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.log(`  FAIL  ${label}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
        failed++;
    }
}

// Axis-aligned rectangular hull (4 vertices, CCW order is fine for diameter math)
function boxHull(s, w, n, e) {
    return [{ lat: s, lng: w }, { lat: n, lng: w },
            { lat: n, lng: e }, { lat: s, lng: e }];
}

// Compute hull diameter the same way zoneAssignment.js does — used to set up
// test cases that depend on exact hull diameter values.
function hullDiameter(hull) {
    let max = 0;
    for (let i = 0; i < hull.length; i++)
        for (let j = i + 1; j < hull.length; j++) {
            const d = haversineDistance(hull[i].lat, hull[i].lng, hull[j].lat, hull[j].lng);
            if (d > max) max = d;
        }
    return max;
}

// Linear chain of (count+1) nodes n0..nN; each edge edgeW metres.
// lng spacing derived from edgeW at lat 14.700 so haversine ≈ edgeW per hop.
function makeChain(count, edgeW = 100) {
    const dLng = edgeW / (111000 * Math.cos(14.700 * Math.PI / 180));
    const nodes = {}, adj = {};
    for (let i = 0; i <= count; i++) {
        nodes[`n${i}`] = { id: `n${i}`, lat: 14.700, lng: 121.090 + i * dLng };
        adj[`n${i}`] = [];
        if (i > 0)     adj[`n${i}`].push({ neighborId: `n${i-1}`, weight: edgeW });
        if (i < count) adj[`n${i}`].push({ neighborId: `n${i+1}`, weight: edgeW });
    }
    return { nodes, adj };
}

const CFG = {
    tsp:      { maxCrimeNodesPerZone: 10 },
    snapping: { boundingBoxEpsilon: 1e-7, initialSearchRadiusMeters: 500 }
};

// ─────────────────────────────────────────────────────────────────────────────
section('T01 · Defensive check — empty validCandidates returns error immediately');
// ─────────────────────────────────────────────────────────────────────────────
{
    const patrol = [{ id:'s1', nodeId:'n0', lat:14.700, lng:121.090, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.091);
    const crimes = [{ crimeId:'C1', lat:14.700, lng:121.090 }];

    const r = runZoneAssignment(crimes, patrol, [], hull, {}, {}, CFG);
    ok('status is error',          r.status  === 'error',   r.status,  'error');
    ok('correct error message',    r.message.includes('No valid patrol positions'), r.message, '...');
    ok('data.zones is null',       r.data.zones === null,   r.data.zones, null);
}

// ─────────────────────────────────────────────────────────────────────────────
section('T02 · Snapping restricted to validCandidates — never touches full node set');
// ─────────────────────────────────────────────────────────────────────────────
{
    // n_bad1 and n_bad2 exist in adj but are NOT validCandidates.
    // Crime placed at n_bad1 coords — nearest geometrically, but must snap to n_vc1 (nearest valid).
    const n_bad1 = { id:'n_bad1', lat:14.700, lng:121.090  };
    const n_bad2 = { id:'n_bad2', lat:14.700, lng:121.0901 };
    const n_vc1  = { id:'n_vc1',  lat:14.700, lng:121.0906 };  // ~64m east — nearest valid
    const n_vc2  = { id:'n_vc2',  lat:14.700, lng:121.092  };
    const adj = {
        n_bad1: [{ neighborId:'n_vc1', weight:700 }],
        n_bad2: [{ neighborId:'n_vc1', weight:600 }],
        n_vc1:  [{ neighborId:'n_bad1', weight:700 }, { neighborId:'n_vc2', weight:150 }],
        n_vc2:  [{ neighborId:'n_vc1', weight:150 }],
    };
    const validCandidates = [n_vc1, n_vc2];
    const patrol = [{ id:'s1', nodeId:'n_vc2', lat:n_vc2.lat, lng:n_vc2.lng, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.093);
    const crimes = [{ crimeId:'C1', lat:n_bad1.lat, lng:n_bad1.lng }];

    const r = runZoneAssignment(crimes, patrol, validCandidates, hull, adj, {}, CFG);
    const sid = r.data.zones.flat()[0]?.snappedNodeId;
    const vcIds = new Set(validCandidates.map(c => c.id));

    ok('snapped node is in validCandidates',  vcIds.has(sid),       sid, 'n_vc1 or n_vc2');
    ok('snapped to n_vc1 (nearest valid)',     sid === 'n_vc1',      sid, 'n_vc1');
    ok('n_bad1 never chosen as snap target',  sid !== 'n_bad1',     sid, '!n_bad1');
    ok('n_bad2 never chosen as snap target',  sid !== 'n_bad2',     sid, '!n_bad2');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T03 · Bounding box pre-filter — significantly reduces Haversine candidates');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 400 candidates spread over 4° × 4° (~440 km × 440 km).
    // 1 near candidate at ~215m east. Only a tiny box fraction should survive the filter.
    const crime = { lat: 14.700, lng: 121.090 };
    const allCandidates = [];

    // Grid: 20 × 20 = 400 candidates across [12.75..16.55] lat, [119.13..123.13] lng.
    // Offset by 0.05° so no grid point falls on the crime at (14.700, 121.090).
    for (let r = 0; r < 20; r++) {
        for (let c = 0; c < 20; c++) {
            allCandidates.push({
                id: `g${r}_${c}`,
                lat: 12.750 + r * 0.2,   // 14.700 not reachable (12.75+9.975×0.2 ≠ integer r)
                lng: 119.130 + c * 0.2,  // 121.090 not reachable (119.13+9.8×0.2 ≠ integer c)
            });
        }
    }
    const nearCand = { id: 'near', lat: 14.700, lng: 121.092 }; // ~214m east
    allCandidates.push(nearCand);   // index 400
    // remove any that accidentally ended up within 500m of the crime (grid spacing >>500m, safe)

    // Manually apply bounding box formula (mirrors snapToNearestCandidate)
    const searchR = CFG.snapping.initialSearchRadiusMeters;
    const eps     = CFG.snapping.boundingBoxEpsilon;
    const dLat    = searchR / 111000;
    const dLng    = searchR / (111000 * Math.cos(crime.lat * Math.PI / 180));
    const inBox   = allCandidates.filter(c =>
        c.lat >= crime.lat - dLat - eps && c.lat <= crime.lat + dLat + eps &&
        c.lng >= crime.lng - dLng - eps && c.lng <= crime.lng + dLng + eps
    );

    ok('bounding box retains < 2% of 401 candidates', inBox.length < 401 * 0.02, inBox.length, '< 9');
    ok('at least 1 candidate (near) survives filter', inBox.length >= 1, inBox.length, '>= 1');
    ok('near candidate is in filtered set', inBox.some(c => c.id === 'near'), inBox.map(c=>c.id), 'includes near');

    // Run the actual function — verify correct result despite 401 candidates
    const adj = { near: [], ...Object.fromEntries(allCandidates.filter(c=>c.id!=='near').map(c=>[c.id,[]])) };
    adj['near'] = [{ neighborId: 'g14_10', weight: 100 }];   // connect to a grid node for Dijkstra
    adj['g14_10'] = [{ neighborId: 'near', weight: 100 }];

    const patrol = [{ id:'s1', nodeId:'near', lat:nearCand.lat, lng:nearCand.lng, color:'#e74c3c' }];
    const hull   = boxHull(12.0, 119.0, 17.0, 124.0);
    const crimes = [{ crimeId:'C1', lat:crime.lat, lng:crime.lng }];

    const rr = runZoneAssignment(crimes, patrol, allCandidates, hull, adj, {}, CFG);
    const sid = rr.data.zones.flat()[0]?.snappedNodeId;
    ok('function finds near candidate correctly', sid === 'near', sid, 'near');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T04 · Search radius expansion — fires when initial 500m radius misses');
// ─────────────────────────────────────────────────────────────────────────────
{
    // Near candidate is ~611m away (beyond 500m initial radius).
    // After one expansion: 500 × 1.5 = 750m — should find it.
    // Hull is large so hull-diameter cap does NOT block expansion.
    const crimeCoords = { lat: 14.700, lng: 121.090 };
    const nearCand = { id: 'n_near', lat: 14.7055, lng: 121.090 }; // ~611m north
    const farCand  = { id: 'n_far',  lat: 14.720,  lng: 121.090 }; // ~2200m north
    const d611 = haversineDistance(crimeCoords.lat, crimeCoords.lng, nearCand.lat, nearCand.lng);

    ok('test setup: near candidate IS beyond 500m', d611 > 500, Math.round(d611), '>500');
    ok('test setup: near candidate IS within 750m', d611 < 750, Math.round(d611), '<750');

    const adj = {
        n_near: [{ neighborId: 'n_far', weight: 1600 }],
        n_far:  [{ neighborId: 'n_near', weight: 1600 }],
    };
    const hull   = boxHull(14.698, 121.088, 14.722, 121.092); // diameter ≈ 2700m >> 750m
    const patrol = [{ id:'s1', nodeId:'n_far', lat:farCand.lat, lng:farCand.lng, color:'#e74c3c' }];
    const crimes = [{ crimeId:'C1', lat:crimeCoords.lat, lng:crimeCoords.lng }];

    const r = runZoneAssignment(crimes, patrol, [nearCand, farCand], hull, adj, {}, CFG);
    const snapped = r.data.zones.flat()[0];

    ok('crime not excluded (expansion succeeded)', r.data.excludedCrimeNodes.length === 0,
       r.data.excludedCrimeNodes.length, 0);
    ok('snapped to near candidate after expansion', snapped?.snappedNodeId === 'n_near',
       snapped?.snappedNodeId, 'n_near');
    ok('snapping dist > 500m (confirms expansion was needed)', snapped?.snappingDist > 500,
       Math.round(snapped?.snappingDist ?? 0), '>500');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T05 · Crime beyond hull diameter — excluded with correct warning');
// ─────────────────────────────────────────────────────────────────────────────
{
    // Tiny hull (diameter ~111m). Sole valid candidate placed 600m away.
    // Snapping expands to hull diameter (~111m) then returns null → excluded.
    const n_vc   = { id: 'n_vc', lat: 14.705, lng: 121.090 }; // ~556m from crime
    const hull   = boxHull(14.699, 121.089, 14.700, 121.090);  // ≈111m diagonal
    const diam   = hullDiameter(hull);

    ok('test setup: hull diameter < candidate distance',
       diam < haversineDistance(14.700, 121.090, n_vc.lat, n_vc.lng),
       Math.round(diam), '< 556m');

    const adj    = { n_vc: [] };
    const patrol = [{ id:'s1', nodeId:'n_vc', lat:n_vc.lat, lng:n_vc.lng, color:'#e74c3c' }];
    const crimes = [{ crimeId:'C1', lat:14.700, lng:121.090 }];

    const r = runZoneAssignment(crimes, patrol, [n_vc], hull, adj, {}, CFG);

    ok('crime excluded',                           r.data.excludedCrimeNodes.length === 1,
       r.data.excludedCrimeNodes.length, 1);
    ok('excluded reason is no_reachable_intersection',
       r.data.excludedCrimeNodes[0]?.reason === 'no_reachable_intersection',
       r.data.excludedCrimeNodes[0]?.reason, 'no_reachable_intersection');
    ok('crime does not appear in any zone',        r.data.zones.every(z => z.length === 0),
       r.data.zones.map(z=>z.length), 'all 0');
    ok('status is warning',                        r.status === 'warning', r.status, 'warning');
    ok('warning message mentions exclusion',
       r.warnings.some(w => w.includes('no reachable road intersection')),
       r.warnings, 'includes exclusion warning');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T06 · Duplicate snapping — two crimes snap to same candidate, produce one waypoint');
// ─────────────────────────────────────────────────────────────────────────────
{
    // n0 is the only valid candidate near both crimes.
    // crime1 is exactly at n0's coords; crime2 is ~10m away (still snaps to n0).
    const n0 = { id:'n0', lat:14.700, lng:121.090 };
    const n1 = { id:'n1', lat:14.705, lng:121.090 }; // patrol position, far
    const adj = {
        n0: [{ neighborId:'n1', weight:550 }],
        n1: [{ neighborId:'n0', weight:550 }],
    };
    const validCandidates = [n0, n1];
    const patrol = [{ id:'s1', nodeId:'n1', lat:n1.lat, lng:n1.lng, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.706, 121.091);
    const crimes = [
        { crimeId:'C1', lat:14.700,    lng:121.090   },  // exactly at n0
        { crimeId:'C2', lat:14.700,    lng:121.09009 },  // ~9m east of n0, still snaps to n0
    ];

    const r = runZoneAssignment(crimes, patrol, validCandidates, hull, adj, {}, CFG);

    ok('mergedCount is 1 (one duplicate discarded)',  r.data.mergedCount === 1, r.data.mergedCount, 1);
    ok('snappedCount is 2 (both crimes snapped OK)',  r.data.snappedCount === 2, r.data.snappedCount, 2);
    ok('zone has 1 TSP waypoint (not 2)',             r.data.zones[0].length === 1, r.data.zones[0].length, 1);
    ok('status is warning (merge triggers warning)',  r.status === 'warning', r.status, 'warning');
    ok('warnings[] contains merge message',
       r.warnings.some(w => w.includes('merged with nearby incident')),
       r.warnings, 'includes merge warning');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T07 · Road network distance ≠ Euclidean — barrier assigns to road-accessible patrol');
// ─────────────────────────────────────────────────────────────────────────────
{
    // Topology:
    //   n_near (patrol0) ─── [NO ROAD] ─── n_crime ──200m── n_far (patrol1)
    //
    // n_crime is ~107m from n_near (Euclidean) but road-disconnected from n_near.
    // Road distance to n_far = 200m → assigned to patrol1 (not patrol0).
    //
    // Euclidean would assign to patrol0 — road assigns to patrol1.
    const n_near  = { id:'n_near',  lat:14.700, lng:121.090  };
    const n_crime = { id:'n_crime', lat:14.700, lng:121.091  }; // ~107m east of n_near
    const n_far   = { id:'n_far',   lat:14.700, lng:121.093  }; // ~107m east of n_crime
    const adj = {
        n_near:  [],   // isolated — no road to n_crime
        n_crime: [{ neighborId:'n_far', weight:200 }],
        n_far:   [{ neighborId:'n_crime', weight:200 }],
    };
    const patrols = [
        { id:'s1', nodeId:'n_near', lat:n_near.lat,  lng:n_near.lng,  color:'#e74c3c' },
        { id:'s2', nodeId:'n_far',  lat:n_far.lat,   lng:n_far.lng,   color:'#3498db' },
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.094);
    const crimes = [{ crimeId:'C1', lat:n_crime.lat, lng:n_crime.lng }];

    const dEucNear = haversineDistance(n_crime.lat, n_crime.lng, n_near.lat, n_near.lng);
    const dEucFar  = haversineDistance(n_crime.lat, n_crime.lng, n_far.lat,  n_far.lng);
    ok('test geometry: n_near IS Euclidean-closer', dEucNear < dEucFar,
       `${Math.round(dEucNear)}m vs ${Math.round(dEucFar)}m`, 'n_near < n_far');

    const r = runZoneAssignment(crimes, patrols, [n_near, n_crime, n_far], hull, adj, {}, CFG);

    ok('crime assigned to patrol1 (n_far) via road',   r.data.zones[1].length === 1, r.data.zones[1].length, 1);
    ok('patrol0 (n_near) has empty zone',              r.data.zones[0].length === 0, r.data.zones[0].length, 0);
    ok('no Euclidean fallback used (distance finite)',
       !r.warnings.some(w => w.includes('straight-line distance')),
       r.warnings, 'no fallback warning');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T08 · Dijkstra runs exactly m times (m = unique snapped sources), not m×n');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 3 crimes → 3 unique snapped nodes → exactly 3 Dijkstra runs.
    // Verified by inspecting dijkstraCache key count after zone assignment.
    const { nodes, adj } = makeChain(5, 100);
    const patrols = [
        { id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' },
        { id:'s2', nodeId:'n5', lat:nodes.n5.lat, lng:nodes.n5.lng, color:'#3498db' },
    ];
    const validCandidates = [nodes.n1, nodes.n2, nodes.n3, nodes.n4];
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n5.lng + 0.001);
    const crimes = [
        { crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng },
        { crimeId:'C2', lat:nodes.n2.lat, lng:nodes.n2.lng },
        { crimeId:'C3', lat:nodes.n3.lat, lng:nodes.n3.lng },
    ];

    const cache = {};
    runZoneAssignment(crimes, patrols, validCandidates, hull, adj, cache, CFG);
    const cacheKeys = Object.keys(cache);

    ok('dijkstraCache has exactly 3 entries (1 per unique snapped node)',
       cacheKeys.length === 3, cacheKeys.length, 3);
    ok('cache keys are the 3 snapped node IDs',
       ['n1','n2','n3'].every(id => cacheKeys.includes(id)),
       cacheKeys.sort(), ['n1','n2','n3']);
    // Verify patrol node IDs are NOT added as cache keys (Stage 3 only runs Dijkstra from crime nodes)
    ok('patrol nodes n0/n5 not in cache (not run from patrol sources)',
       !cacheKeys.includes('n0') && !cacheKeys.includes('n5'),
       cacheKeys, 'no n0 or n5');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T09 · Cache populated with valid entries usable by Stage 4');
// ─────────────────────────────────────────────────────────────────────────────
{
    const { nodes, adj } = makeChain(4, 100);
    const patrols = [{ id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' }];
    const hull    = boxHull(14.699, 121.089, 14.701, nodes.n4.lng + 0.001);
    const crimes  = [
        { crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng },
        { crimeId:'C2', lat:nodes.n2.lat, lng:nodes.n2.lng },
    ];
    const cache = {};
    runZoneAssignment(crimes, patrols, [nodes.n1, nodes.n2, nodes.n3], hull, adj, cache, CFG);

    for (const key of ['n1', 'n2']) {
        const entry = cache[key];
        ok(`cache[${key}] exists`,                   !!entry, !!entry, true);
        ok(`cache[${key}].distances is object`,      typeof entry?.distances === 'object', typeof entry?.distances, 'object');
        ok(`cache[${key}].parents is object`,        typeof entry?.parents   === 'object', typeof entry?.parents,   'object');
        ok(`cache[${key}].distances[n0] is number`,  typeof entry?.distances?.n0 === 'number', typeof entry?.distances?.n0, 'number');
        ok(`cache[${key}].distances[n0] > 0`,        (entry?.distances?.n0 ?? 0) > 0, entry?.distances?.n0, '>0');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
section('T10a · Euclidean fallback NOT triggered when only one patrol is disconnected');
// ─────────────────────────────────────────────────────────────────────────────
{
    // patrol0 at n_A (isolated — no road to n_crime).
    // patrol1 at n_B (connected to n_crime, road dist 200m).
    // allInfinity = false → no fallback, crime goes to patrol1 via road.
    const n_A     = { id:'n_A',     lat:14.700, lng:121.090 };  // isolated
    const n_crime = { id:'n_crime', lat:14.700, lng:121.093 };  // crime snaps here
    const n_B     = { id:'n_B',     lat:14.700, lng:121.095 };  // patrol1, connected

    const adj = {
        n_A:     [],
        n_crime: [{ neighborId:'n_B', weight:200 }],
        n_B:     [{ neighborId:'n_crime', weight:200 }],
    };
    const patrols = [
        { id:'s1', nodeId:'n_A', lat:n_A.lat, lng:n_A.lng, color:'#e74c3c' },
        { id:'s2', nodeId:'n_B', lat:n_B.lat, lng:n_B.lng, color:'#3498db' },
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.096);
    const crimes = [{ crimeId:'C1', lat:n_crime.lat, lng:n_crime.lng }];

    const r = runZoneAssignment(crimes, patrols, [n_A, n_crime, n_B], hull, adj, {}, CFG);

    ok('no Euclidean fallback warning', !r.warnings.some(w => w.includes('straight-line distance')),
       r.warnings, 'no fallback');
    ok('crime assigned to patrol1 (only road-connected patrol)', r.data.zones[1].length === 1,
       r.data.zones[1].length, 1);
    ok('patrol0 zone is empty', r.data.zones[0].length === 0, r.data.zones[0].length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
section('T10b · Euclidean fallback triggered when ALL patrols disconnected from crime');
// ─────────────────────────────────────────────────────────────────────────────
{
    // n_iso has no edges — Dijkstra from n_iso returns Infinity to all patrols.
    // allInfinity = true → Euclidean fallback.
    // n_B is Euclidean-closer to n_iso → crime should go to patrol1 (n_B).
    const n_A   = { id:'n_A',  lat:14.700, lng:121.090 };
    const n_B   = { id:'n_B',  lat:14.700, lng:121.095 };  // ~536m east
    const n_iso = { id:'n_iso',lat:14.700, lng:121.093 };  // ~322m from n_A, ~214m from n_B

    const adj = {
        n_A:   [{ neighborId:'n_B', weight:600 }],
        n_B:   [{ neighborId:'n_A', weight:600 }],
        n_iso: [],  // completely isolated
    };
    const patrols = [
        { id:'s1', nodeId:'n_A', lat:n_A.lat, lng:n_A.lng, color:'#e74c3c' },
        { id:'s2', nodeId:'n_B', lat:n_B.lat, lng:n_B.lng, color:'#3498db' },
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.096);
    const crimes = [{ crimeId:'C1', lat:n_iso.lat, lng:n_iso.lng }];

    const r = runZoneAssignment(crimes, patrols, [n_A, n_B, n_iso], hull, adj, {}, CFG);

    ok('Euclidean fallback warning is present',
       r.warnings.some(w => w.includes('straight-line distance')), r.warnings, 'includes fallback');
    ok('crime assigned to Euclidean-closer patrol (n_B = patrol1)',
       r.data.zones[1].length === 1, r.data.zones[1].length, 1);
    // Verify Euclidean distance confirms n_B is closer
    const dA = haversineDistance(n_iso.lat, n_iso.lng, n_A.lat, n_A.lng);
    const dB = haversineDistance(n_iso.lat, n_iso.lng, n_B.lat, n_B.lng);
    ok('test geometry: n_B is Euclidean-closer to n_iso', dB < dA, Math.round(dB), `< ${Math.round(dA)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('T11 · Tiebreaker — lower patrol index wins on exactly equal road distance');
// ─────────────────────────────────────────────────────────────────────────────
{
    // n_A ──100m── n_C ──100m── n_B
    // patrol0 at n_A, patrol1 at n_B, crime at n_C.
    // Road dist n_C→n_A = 100m, n_C→n_B = 100m (exactly equal).
    // Tiebreaker: patrol0 (idx 0) wins — strict < means first patrol wins on tie.
    const { nodes, adj } = makeChain(2, 100);  // n0, n1, n2
    const patrols = [
        { id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' }, // idx 0
        { id:'s2', nodeId:'n2', lat:nodes.n2.lat, lng:nodes.n2.lng, color:'#3498db' }, // idx 1
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n2.lng + 0.001);
    const crimes = [{ crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng }]; // n1 = midpoint

    const r = runZoneAssignment(crimes, patrols, [nodes.n0, nodes.n1, nodes.n2], hull, adj, {}, CFG);

    // Confirm both road distances are truly equal (100m each, symmetric graph)
    const cache = {};
    runZoneAssignment(crimes, patrols, [nodes.n0, nodes.n1, nodes.n2], hull, adj, cache, CFG);
    const distToP0 = cache['n1']?.distances?.['n0'] ?? Infinity;
    const distToP1 = cache['n1']?.distances?.['n2'] ?? Infinity;
    ok('test setup: road distances are equal', Math.abs(distToP0 - distToP1) < 0.001,
       `d_p0=${distToP0} d_p1=${distToP1}`, 'equal');

    ok('crime assigned to patrol0 (lower index)', r.data.zones[0].length === 1, r.data.zones[0].length, 1);
    ok('patrol1 zone is empty',                   r.data.zones[1].length === 0, r.data.zones[1].length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
section('T12 · Zone cap — keeps nearest by ROAD distance, not Euclidean distance');
// ─────────────────────────────────────────────────────────────────────────────
{
    // U-shaped road: n0 ─200m─ n_a ─200m─ n_b ─200m─ n_c
    // n_c is spatially close to n0 (same lat, 1 step east in lng) but road-far (600m via U-shape).
    // Crimes at n_a(200m road), n_b(400m road), n_c(600m road, ~107m Euclidean from n0).
    // Cap = 2: road keeps {n_a, n_b}, Euclidean would keep {n_c, n_a}.
    // Assert: n_c is excluded (not n_b), proving road-distance sort is used.
    const dLng1 = 0.001;   // ~107m east
    const n0 = { id:'n0', lat:14.700, lng:121.090 };
    const n_a = { id:'n_a', lat:14.701, lng:121.090 };    // 200m road; ~111m Euclidean from n0
    const n_b = { id:'n_b', lat:14.701, lng:121.090 + dLng1 }; // 400m road; ~153m Euclidean
    const n_c = { id:'n_c', lat:14.700, lng:121.090 + dLng1 }; // 600m road; ~107m Euclidean from n0!

    const adj = {
        n0:  [{ neighborId:'n_a', weight:200 }],
        n_a: [{ neighborId:'n0', weight:200 }, { neighborId:'n_b', weight:200 }],
        n_b: [{ neighborId:'n_a', weight:200 }, { neighborId:'n_c', weight:200 }],
        n_c: [{ neighborId:'n_b', weight:200 }],
    };
    const cfg2 = { ...CFG, tsp: { maxCrimeNodesPerZone: 2 } };
    const patrol = [{ id:'s1', nodeId:'n0', lat:n0.lat, lng:n0.lng, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.702, 121.092);
    const crimes = [
        { crimeId:'C_a', lat:n_a.lat, lng:n_a.lng },
        { crimeId:'C_b', lat:n_b.lat, lng:n_b.lng },
        { crimeId:'C_c', lat:n_c.lat, lng:n_c.lng },
    ];

    // Verify Euclidean distances (confirms n_c is geometrically closer to n0 than n_b)
    const dEucA = haversineDistance(n0.lat, n0.lng, n_a.lat, n_a.lng);
    const dEucB = haversineDistance(n0.lat, n0.lng, n_b.lat, n_b.lng);
    const dEucC = haversineDistance(n0.lat, n0.lng, n_c.lat, n_c.lng);
    ok('Euclidean: n_c < n_b from patrol (n_c is deceivingly close)',
       dEucC < dEucB, `n_c=${Math.round(dEucC)}m, n_b=${Math.round(dEucB)}m`, 'n_c < n_b');

    const r = runZoneAssignment(crimes, patrol, [n0, n_a, n_b, n_c], hull, adj, {}, cfg2);

    ok('zone capped at 2 nodes',     r.data.zones[0].length === 2,  r.data.zones[0].length, 2);
    ok('cappedZonesCount = 1',       r.data.cappedZonesCount === 1, r.data.cappedZonesCount, 1);
    const kept = r.data.zones[0].map(z => z.snappedNodeId).sort();
    ok('road-nearest n_a retained',  kept.includes('n_a'), kept, 'includes n_a');
    ok('road-nearest n_b retained',  kept.includes('n_b'), kept, 'includes n_b');
    ok('road-farthest n_c excluded (not Euclidean-farthest n_b)',
       !kept.includes('n_c'), kept, 'excludes n_c');
    const excl = r.data.excludedCrimeNodes.map(e => e.snappedNodeId);
    ok('n_c is in excludedCrimeNodes', excl.includes('n_c'), excl, 'includes n_c');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T13 · Zone rebalancing — fires when imbalance exceeds threshold');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 21-node chain (n0..n20), edges 100m each.
    // 3 patrols: p0=n0, p1=n10, p2=n20.
    // Crimes at n1..n5 → zone0(5), n12 → zone1(1), n18 → zone2(1).
    // Mean = 7/3 ≈ 2.33. Zone0: 5 > 4.67 ✓. Zone1: 1 < 1.17 ✓ → rebalancing fires.
    // n5 is the only boundary crime: d(n5,n0)=500m, d(n5,n10)=500m → equidistant → reassigned.
    const { nodes, adj } = makeChain(20, 100);
    const patrols = [
        { id:'s1', nodeId:'n0',  lat:nodes.n0.lat,  lng:nodes.n0.lng,  color:'#e74c3c' },
        { id:'s2', nodeId:'n10', lat:nodes.n10.lat, lng:nodes.n10.lng, color:'#3498db' },
        { id:'s3', nodeId:'n20', lat:nodes.n20.lat, lng:nodes.n20.lng, color:'#2ecc71' },
    ];
    const validCandidates = [0,1,2,3,4,5,10,12,18,20].map(i => nodes[`n${i}`]);
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n20.lng + 0.001);
    const crimes = [1,2,3,4,5,12,18].map((i, ci) => ({
        crimeId: `C${ci+1}`, lat: nodes[`n${i}`].lat, lng: nodes[`n${i}`].lng
    }));

    const r = runZoneAssignment(crimes, patrols, validCandidates, hull, adj, {}, CFG);

    ok('rebalancing fired (≥1 iteration)',     r.data.rebalanceIterations >= 1,
       r.data.rebalanceIterations, '>= 1');
    ok('zone0 reduced from 5',                 r.data.zones[0].length < 5,
       r.data.zones[0].length, '< 5');
    ok('total crime count preserved (7)',
       r.data.zones.reduce((s,z) => s+z.length, 0) === 7,
       r.data.zones.reduce((s,z) => s+z.length, 0), 7);
    ok('rebalance log entry exists',
       r.data.traceLog.some(l => l.includes('Rebalance iter')),
       r.data.traceLog.filter(l=>l.includes('Rebalance')), 'includes rebalance log');
    ok('rebalance log mentions crimeId and patrol IDs',
       r.data.traceLog.some(l => l.includes('from patrol') && l.includes('to patrol')),
       r.data.traceLog.filter(l=>l.includes('from patrol')), 'patrol IDs in log');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T14 · Zone rebalancing — stops at maximum 10 iterations');
// ─────────────────────────────────────────────────────────────────────────────
{
    // Run the same heavy-imbalance scenario. Whether loop exits via threshold resolution
    // or boundary-node exhaustion, iterations must never exceed 10.
    const { nodes, adj } = makeChain(20, 100);
    const patrols = [
        { id:'s1', nodeId:'n0',  lat:nodes.n0.lat,  lng:nodes.n0.lng,  color:'#e74c3c' },
        { id:'s2', nodeId:'n10', lat:nodes.n10.lat, lng:nodes.n10.lng, color:'#3498db' },
        { id:'s3', nodeId:'n20', lat:nodes.n20.lat, lng:nodes.n20.lng, color:'#2ecc71' },
    ];
    const validCandidates = Object.values(nodes);
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n20.lng + 0.001);
    // 9 crimes at n0..n8 (deep in zone0 — most NOT boundary nodes), 1 at n12, 1 at n18
    const crimes = [0,1,2,3,4,5,6,7,8,12,18].map((i, ci) => ({
        crimeId: `C${ci+1}`, lat: nodes[`n${i}`].lat, lng: nodes[`n${i}`].lng
    }));

    const r = runZoneAssignment(crimes, patrols, validCandidates, hull, adj, {}, CFG);

    ok('rebalanceIterations <= 10 (cap respected)',  r.data.rebalanceIterations <= 10,
       r.data.rebalanceIterations, '<= 10');
    ok('total crime count still correct after cap',
       r.data.zones.reduce((s,z) => s+z.length, 0) === 11,
       r.data.zones.reduce((s,z)=>s+z.length,0), 11);

    // Also run with an inherently non-rebalanceable case to confirm 0 iterations safe
    const r2 = runZoneAssignment(
        [{ crimeId:'X1', lat:nodes.n0.lat, lng:nodes.n0.lng }],
        [{ id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' }],
        [nodes.n0], hull, adj, {}, CFG
    );
    ok('0 iterations when rebalancing never needed', r2.data.rebalanceIterations === 0,
       r2.data.rebalanceIterations, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
section('T15 · Empty zone classification — stationary flag, empty warning');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 1 crime, 3 patrols. Crime snaps to n1 (middle node).
    // Road: n0 ─100m─ n1 ─100m─ n2 ─100m─ n3.
    // d(n1,n0)=100m, d(n1,n2)=100m → tie → patrol0 wins (lower index).
    // patrol1 and patrol2 get empty zones.
    const { nodes, adj } = makeChain(3, 100);
    const patrols = [
        { id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' },
        { id:'s2', nodeId:'n2', lat:nodes.n2.lat, lng:nodes.n2.lng, color:'#3498db' },
        { id:'s3', nodeId:'n3', lat:nodes.n3.lat, lng:nodes.n3.lng, color:'#2ecc71' },
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n3.lng + 0.001);
    const crimes = [{ crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng }];

    const r = runZoneAssignment(crimes, patrols, Object.values(nodes), hull, adj, {}, CFG);

    ok('crime in zone0 (tiebreaker)',         r.data.zones[0].length === 1, r.data.zones[0].length, 1);
    ok('zone1 is empty',                      r.data.zones[1].length === 0, r.data.zones[1].length, 0);
    ok('zone2 is empty',                      r.data.zones[2].length === 0, r.data.zones[2].length, 0);
    ok('emptyZones includes indices 1 and 2', r.data.emptyZones.includes(1) && r.data.emptyZones.includes(2),
       r.data.emptyZones, '[1, 2]');
    ok('2 empty zones total',                 r.data.emptyZones.length === 2, r.data.emptyZones.length, 2);
    ok('singleNodeZones has patrol0 (zone0)', r.data.singleNodeZones.includes(0),
       r.data.singleNodeZones, 'includes 0');
    ok('multiNodeZones is empty',             r.data.multiNodeZones.length === 0, r.data.multiNodeZones.length, 0);
    ok('status is warning (empty zones)',     r.status === 'warning', r.status, 'warning');
    ok('warning mentions stationary patrols',
       r.warnings.some(w => w.includes('stationary')), r.warnings, 'includes stationary');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T16 · Single node zone classification — direct route, TSP skipped');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 1 patrol, 1 crime → singleNodeZones should contain patrol index 0.
    const { nodes, adj } = makeChain(2, 100);
    const patrol = [{ id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n2.lng + 0.001);
    const crimes = [{ crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng }];

    const r = runZoneAssignment(crimes, patrol, Object.values(nodes), hull, adj, {}, CFG);

    ok('singleNodeZones contains patrol 0', r.data.singleNodeZones.includes(0),
       r.data.singleNodeZones, 'includes 0');
    ok('emptyZones is empty',               r.data.emptyZones.length === 0, r.data.emptyZones.length, 0);
    ok('multiNodeZones is empty',           r.data.multiNodeZones.length === 0, r.data.multiNodeZones.length, 0);
    ok('zone0 has exactly 1 crime node',    r.data.zones[0].length === 1, r.data.zones[0].length, 1);
    ok('trace log mentions direct visit route',
       r.data.traceLog.some(l => l.includes('single node zone')),
       r.data.traceLog.filter(l=>l.includes('single')), 'includes single node log');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T17 · Aggregate snapping statistics — avg and max correct, excludes excluded crimes');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 3 crimes that snap successfully + 1 that is excluded (beyond hull diameter).
    // Snap distances:
    //   C1: snaps to n0 exactly → 0m
    //   C2: placed 0.00045° north of n1 → ~50m snap distance
    //   C3: placed 0.0018° north of n2 → ~200m snap distance
    //   C4: placed far away, excluded (no candidate within hull diameter)
    //
    // Expected avg = (0 + d2 + d3) / 3 (NOT including C4)
    // Expected max = d3 (NOT from C4)
    const n0 = { id:'n0', lat:14.700, lng:121.090 };
    const n1 = { id:'n1', lat:14.701, lng:121.090 };  // ~111m north of n0
    const n2 = { id:'n2', lat:14.702, lng:121.090 };  // ~111m north of n1
    const adj = {
        n0: [{ neighborId:'n1', weight:111 }],
        n1: [{ neighborId:'n0', weight:111 }, { neighborId:'n2', weight:111 }],
        n2: [{ neighborId:'n1', weight:111 }],
    };
    // Small hull (diameter ~220m) — C4 at 500m north will be beyond it and excluded.
    const hull = boxHull(14.699, 121.089, 14.703, 121.091);  // ~±222m in lat, diam ~440m
    const hullD = hullDiameter(hull);
    ok('test setup: hull diameter > 200m so C3 snapping is possible',
       hullD > 200, Math.round(hullD), '> 200m');

    // C2: place ~50m north of n1
    const c2Lat = n1.lat + (50 / 111000);
    // C3: place ~200m north of n2
    const c3Lat = n2.lat + (200 / 111000);
    // C4: ~600m north of n2 — guaranteed beyond hull diameter
    const c4Lat = n2.lat + (600 / 111000);
    ok('test setup: C4 is beyond hull diameter from all candidates',
       haversineDistance(c4Lat, 121.090, n2.lat, n2.lng) > hullD,
       Math.round(haversineDistance(c4Lat, 121.090, n2.lat, n2.lng)), `> ${Math.round(hullD)}`);

    const patrol = [{ id:'s1', nodeId:'n0', lat:n0.lat, lng:n0.lng, color:'#e74c3c' }];
    const crimes = [
        { crimeId:'C1', lat:n0.lat,   lng:n0.lng   },        // 0m snap
        { crimeId:'C2', lat:c2Lat,    lng:n1.lng   },        // ~50m snap
        { crimeId:'C3', lat:c3Lat,    lng:n2.lng   },        // ~200m snap
        { crimeId:'C4', lat:c4Lat,    lng:n2.lng   },        // EXCLUDED
    ];

    const r = runZoneAssignment(crimes, patrol, [n0, n1, n2], hull, adj, {}, CFG);

    // Compute expected values from actual snapping results
    const snappedNodes = r.data.zones.flat();
    const excl = r.data.excludedCrimeNodes.filter(e => e.reason === 'no_reachable_intersection');
    ok('C4 is excluded',         excl.length === 1, excl.length, 1);
    ok('3 crimes snapped',       r.data.snappedCount === 3, r.data.snappedCount, 3);

    // Use the actual distances reported by the function
    const d0 = snappedNodes.find(n => n.crimeId === 'C1')?.snappingDist ?? 0;
    const d2 = snappedNodes.find(n => n.crimeId === 'C2')?.snappingDist ?? 0;
    const d3 = snappedNodes.find(n => n.crimeId === 'C3')?.snappingDist ?? 0;

    const expectedAvg = Math.round(((d0 + d2 + d3) / 3) * 10) / 10;
    const expectedMax = Math.round(d3 * 10) / 10;

    ok('C1 snapping dist ≈ 0m',      d0 < 1, Math.round(d0), '~0m');
    ok('C2 snapping dist ≈ 50m',     d2 > 40 && d2 < 60, Math.round(d2), '40-60m');
    ok('C3 snapping dist ≈ 200m',    d3 > 180 && d3 < 220, Math.round(d3), '180-220m');
    ok('average snapping dist matches (excludes C4)',
       Math.abs(r.data.avgSnappingDist - expectedAvg) <= 1,
       r.data.avgSnappingDist, expectedAvg);
    ok('max snapping dist matches (excludes C4)',
       Math.abs(r.data.maxSnappingDist - expectedMax) <= 1,
       r.data.maxSnappingDist, expectedMax);
    ok('excluded crime NOT in average (avg < d4 from excluded crime)',
       r.data.avgSnappingDist < 200, r.data.avgSnappingDist, '< 200m');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T18 · Warning status set when maximum snapping distance exceeds 200m');
// ─────────────────────────────────────────────────────────────────────────────
{
    // Crime placed 250m north of its nearest valid candidate.
    // Hull diameter large enough so crime is not excluded (expansion finds it).
    // Max snapping dist > 200m → status must be warning.
    const n0 = { id:'n0', lat:14.700, lng:121.090 };  // patrol
    const n1 = { id:'n1', lat:14.700, lng:121.093 };  // candidate ~322m east
    const adj = {
        n0: [{ neighborId:'n1', weight:350 }],
        n1: [{ neighborId:'n0', weight:350 }],
    };
    // Crime placed 250m north of n1
    const c1Lat = n1.lat + (250 / 111000);
    const snapDist = haversineDistance(c1Lat, n1.lng, n1.lat, n1.lng);
    ok('test setup: snap distance > 200m', snapDist > 200, Math.round(snapDist), '> 200m');

    // Hull spans well beyond snap distance so crime is not excluded
    const hull = boxHull(14.698, 121.089, 14.705, 121.095);
    ok('test setup: hull diameter > snap dist', hullDiameter(hull) > snapDist,
       Math.round(hullDiameter(hull)), `> ${Math.round(snapDist)}`);

    const patrol = [{ id:'s1', nodeId:'n0', lat:n0.lat, lng:n0.lng, color:'#e74c3c' }];
    const crimes = [{ crimeId:'C1', lat:c1Lat, lng:n1.lng }];

    const r = runZoneAssignment(crimes, patrol, [n0, n1], hull, adj, {}, CFG);

    ok('crime is not excluded (snapping found it)',  r.data.excludedCrimeNodes.length === 0,
       r.data.excludedCrimeNodes.length, 0);
    ok('maxSnappingDist > 200m',     r.data.maxSnappingDist > 200, r.data.maxSnappingDist, '> 200');
    ok('status is warning',          r.status === 'warning', r.status, 'warning');
    ok('warning mentions 200m threshold',
       r.warnings.some(w => w.includes('200m') || w.includes('200 m')),
       r.warnings, 'includes 200m warning');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T19 · Full pipeline scenario — multi-zone with mixed classifications');
// ─────────────────────────────────────────────────────────────────────────────
{
    // 3 patrols on 10-node chain. Multiple crimes → zones with empty, single, multi nodes.
    // Also verifies traceLog, distanceMatrix shape, and return data completeness.
    const { nodes, adj } = makeChain(9, 100);
    const patrols = [
        { id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' },
        { id:'s2', nodeId:'n5', lat:nodes.n5.lat, lng:nodes.n5.lng, color:'#3498db' },
        { id:'s3', nodeId:'n9', lat:nodes.n9.lat, lng:nodes.n9.lng, color:'#2ecc71' },
    ];
    const validCandidates = Object.values(nodes);
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n9.lng + 0.001);
    // Zone0: crimes at n1,n2 (2 nodes → multi). Zone1: crime at n6 (1 node → single). Zone2: empty.
    const crimes = [
        { crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng },
        { crimeId:'C2', lat:nodes.n2.lat, lng:nodes.n2.lng },
        { crimeId:'C3', lat:nodes.n6.lat, lng:nodes.n6.lng },
    ];
    const cache = {};
    // Pass bestRestartIndex so the HC restart log line is emitted
    const r = runZoneAssignment(crimes, patrols, validCandidates, hull, adj, cache, CFG,
                                { bestRestartIndex: 3 });

    // Zone2 is empty → status is 'warning' (empty zone triggers warning)
    ok('status is warning (zone2 empty)',      r.status === 'warning', r.status, 'warning');
    ok('zone0 has 2 crimes (multi)',           r.data.zones[0].length === 2, r.data.zones[0].length, 2);
    ok('zone1 has 1 crime (single)',           r.data.zones[1].length === 1, r.data.zones[1].length, 1);
    ok('zone2 is empty',                       r.data.zones[2].length === 0, r.data.zones[2].length, 0);
    ok('multiNodeZones contains 0',            r.data.multiNodeZones.includes(0), r.data.multiNodeZones, '[0]');
    ok('singleNodeZones contains 1',           r.data.singleNodeZones.includes(1), r.data.singleNodeZones, '[1]');
    ok('emptyZones contains 2',                r.data.emptyZones.includes(2), r.data.emptyZones, '[2]');
    ok('distanceMatrix has 3 entries (C1,C2,C3 snap to n1,n2,n6)',
       Object.keys(r.data.distanceMatrix).length >= 3,
       Object.keys(r.data.distanceMatrix).length, '>= 3');
    ok('traceLog is non-empty array',          Array.isArray(r.data.traceLog) && r.data.traceLog.length > 5,
       r.data.traceLog.length, '> 5');
    ok('traceLog contains Stage 3 Summary',
       r.data.traceLog.some(l => l.includes('Stage 3 Summary')),
       r.data.traceLog.filter(l=>l.includes('Summary')), 'includes summary');
    ok('cache populated from zone assignment', Object.keys(cache).length > 0, Object.keys(cache).length, '> 0');
    ok('Hill Climbing restart log present (bestRestartIndex=3)',
       r.data.traceLog.some(l => l.includes('Hill Climbing restart 3')),
       r.data.traceLog.filter(l=>l.includes('Hill Climbing')), 'includes HC restart 3');
}

// ─────────────────────────────────────────────────────────────────────────────
section('T20 · n=1 patrol — sole patrol gets all crimes, no empty zones');
// ─────────────────────────────────────────────────────────────────────────────
{
    const { nodes, adj } = makeChain(4, 100);
    const patrol = [{ id:'s1', nodeId:'n0', lat:nodes.n0.lat, lng:nodes.n0.lng, color:'#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.701, nodes.n4.lng + 0.001);
    const crimes = [
        { crimeId:'C1', lat:nodes.n1.lat, lng:nodes.n1.lng },
        { crimeId:'C2', lat:nodes.n2.lat, lng:nodes.n2.lng },
        { crimeId:'C3', lat:nodes.n3.lat, lng:nodes.n3.lng },
    ];
    const r = runZoneAssignment(crimes, patrol, Object.values(nodes), hull, adj, {}, CFG);

    ok('status success',          r.status === 'success', r.status, 'success');
    ok('all 3 crimes in zone0',   r.data.zones[0].length === 3, r.data.zones[0].length, 3);
    ok('no empty zones',          r.data.emptyZones.length === 0, r.data.emptyZones.length, 0);
    ok('zone0 is multi-node',     r.data.multiNodeZones.includes(0), r.data.multiNodeZones, '[0]');
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
console.log(`Total: ${passed + failed}  |  PASS: ${passed}  |  FAIL: ${failed}`);
if (failed > 0) {
    console.log('Some tests FAILED. Fix all failures before proceeding.');
    process.exit(1);
} else {
    console.log('All tests PASSED.');
}
