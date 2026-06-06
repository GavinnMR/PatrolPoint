// test_zone_assignment.js — focused tests for server/algorithms/zoneAssignment.js
// Run: node test_zone_assignment.js

import { runZoneAssignment } from './server/algorithms/zoneAssignment.js';
import { haversineDistance }  from './server/algorithms/dijkstra.js';

const CFG = {
    tsp:      { maxCrimeNodesPerZone: 10 },
    snapping: { boundingBoxEpsilon: 1e-7, initialSearchRadiusMeters: 500 },
};

let pass = 0, fail = 0;
const ok = (label, cond, got, want) => {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else       { console.log(`  FAIL  ${label}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); fail++; }
};

// Axis-aligned hull bounding all test nodes with margin.
function boxHull(s, w, n, e) {
    return [{ lat: s, lng: w }, { lat: n, lng: w },
            { lat: n, lng: e }, { lat: s, lng: e }];
}

// ── Test 1: Snapping to nearest valid candidate ──────────────────────────────
console.log('\n[Test 1] Snapping to nearest valid candidate');
{
    // Two candidates: n0 at lng 121.090, n1 at lng 121.095 (~536m apart).
    // Incident at lng 121.0913 — ~140m from n0, ~397m from n1 → must snap to n0.
    const n0 = { id: 'n0', lat: 14.700, lng: 121.090 };
    const n1 = { id: 'n1', lat: 14.700, lng: 121.095 };
    const adj = {
        n0: [{ neighborId: 'n1', weight: 600 }],
        n1: [{ neighborId: 'n0', weight: 600 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: n0.lat, lng: n0.lng, color: '#e74c3c' }];
    const inc    = [{ crimeId: 'C1', lat: 14.700, lng: 121.0913 }];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.096);

    const r = runZoneAssignment(inc, patrol, [n0, n1], hull, adj, {}, CFG);

    const snapped = r.data.zones[0][0];
    const expectedSnapDist = haversineDistance(inc[0].lat, inc[0].lng, n0.lat, n0.lng);

    ok('snaps to nearest candidate (n0)', snapped?.snappedNodeId === 'n0', snapped?.snappedNodeId, 'n0');
    ok('snapping distance recorded correctly',
       snapped && Math.abs(snapped.snappingDist - expectedSnapDist) < 0.01,
       snapped?.snappingDist?.toFixed(2), expectedSnapDist.toFixed(2));
    ok('snapped count = 1', r.data.snappedCount === 1, r.data.snappedCount, 1);
    ok('status success', r.status === 'success', r.status, 'success');
}

// ── Test 2: Road network distance produces different assignment than Euclidean ─
console.log('\n[Test 2] Road network distance ≠ Euclidean assignment');
{
    // Topology:
    //   n_near (patrol 0) ──500m── n_loop1 ──100m── n_loop2 ──500m── n_mid (crime)
    //                                                                        │
    //                                                                       200m
    //                                                                        │
    //                                                                    n_far (patrol 1)
    //
    // n_mid Euclidean: ~107m to n_near, ~430m to n_far → Euclidean picks patrol 0.
    // n_mid road:     1100m to n_near, 200m to n_far → Road picks patrol 1. ← what we assert.

    const nn  = { id: 'n_near',  lat: 14.700, lng: 121.090 };
    const nm  = { id: 'n_mid',   lat: 14.700, lng: 121.091 };  // ~107m Euclidean from n_near
    const nf  = { id: 'n_far',   lat: 14.700, lng: 121.095 };  // ~430m Euclidean from n_mid
    const nl1 = { id: 'n_loop1', lat: 14.704, lng: 121.090 };
    const nl2 = { id: 'n_loop2', lat: 14.704, lng: 121.091 };

    const adj = {
        n_near:  [{ neighborId: 'n_loop1', weight: 500 }],
        n_loop1: [{ neighborId: 'n_near',  weight: 500 }, { neighborId: 'n_loop2', weight: 100 }],
        n_loop2: [{ neighborId: 'n_loop1', weight: 100 }, { neighborId: 'n_mid',   weight: 500 }],
        n_mid:   [{ neighborId: 'n_loop2', weight: 500 }, { neighborId: 'n_far',   weight: 200 }],
        n_far:   [{ neighborId: 'n_mid',   weight: 200 }],
    };

    const patrols = [
        { id: 's1', nodeId: 'n_near', lat: nn.lat, lng: nn.lng, color: '#e74c3c' },
        { id: 's2', nodeId: 'n_far',  lat: nf.lat, lng: nf.lng, color: '#3498db' },
    ];
    const hull = boxHull(14.699, 121.089, 14.705, 121.096);
    const inc  = [{ crimeId: 'C1', lat: nm.lat, lng: nm.lng }]; // snaps exactly to n_mid

    const r = runZoneAssignment(inc, patrols, [nn, nm, nf], hull, adj, {}, CFG);

    // Verify test geometry is correctly set up: Euclidean confirms n_near IS closer.
    const dEucNear = haversineDistance(nm.lat, nm.lng, nn.lat, nn.lng);
    const dEucFar  = haversineDistance(nm.lat, nm.lng, nf.lat, nf.lng);
    ok('test setup: n_near is Euclidean-closer to n_mid', dEucNear < dEucFar,
       `${dEucNear.toFixed(0)}m vs ${dEucFar.toFixed(0)}m`, 'n_near < n_far');

    // Road network assigns to n_far patrol (opposite of Euclidean).
    ok('road assigns to n_far patrol (s2)', r.data.zones[1].length === 1, r.data.zones[1].length, 1);
    ok('n_near patrol zone is empty (Euclidean would have filled it)', r.data.zones[0].length === 0,
       r.data.zones[0].length, 0);
}

// ── Test 3: Zone rebalancing fires when imbalance exceeds threshold ───────────
console.log('\n[Test 3] Zone rebalancing fires on imbalance');
{
    // 21-node chain. Each edge weight = 100m. Nodes n0..n20 at 0.000931° lng increments.
    // Patrols: s1→n0, s2→n10, s3→n20.
    // Crimes at n1..n5 (→ zone 0, 5 nodes), n12 (→ zone 1, 1 node), n18 (→ zone 2, 1 node).
    // Initial sizes [5, 1, 1]: mean=7/3≈2.33, zone0>4.67 AND zone1<1.17 → rebalancing triggers.
    // n5 is the boundary node: road dist 500m to n0 = 500m to n10 → reassigned to zone 1.
    // Expected after rebalancing: zone0=[4], zone1=[2], zone2=[1].

    const coords = {};
    const adj    = {};
    for (let i = 0; i <= 20; i++) {
        coords[`n${i}`] = { id: `n${i}`, lat: 14.700, lng: 121.090 + i * 0.000931 };
        adj[`n${i}`] = [];
        if (i > 0)  adj[`n${i}`].push({ neighborId: `n${i - 1}`, weight: 100 });
        if (i < 20) adj[`n${i}`].push({ neighborId: `n${i + 1}`, weight: 100 });
    }

    const validCandidates = [0, 1, 2, 3, 4, 5, 10, 12, 18, 20].map(i => coords[`n${i}`]);
    const hull    = boxHull(14.699, 121.089, 14.701, 121.111);
    const patrols = [
        { id: 's1', nodeId: 'n0',  lat: coords.n0.lat,  lng: coords.n0.lng,  color: '#e74c3c' },
        { id: 's2', nodeId: 'n10', lat: coords.n10.lat, lng: coords.n10.lng, color: '#3498db' },
        { id: 's3', nodeId: 'n20', lat: coords.n20.lat, lng: coords.n20.lng, color: '#2ecc71' },
    ];
    // Place crimes exactly at node coordinates → 0m snapping distance, no ambiguity.
    const crimes = [1, 2, 3, 4, 5, 12, 18].map((i, ci) => ({
        crimeId: `C${ci + 1}`,
        lat: coords[`n${i}`].lat,
        lng: coords[`n${i}`].lng,
    }));

    const r = runZoneAssignment(crimes, patrols, validCandidates, hull, adj, {}, CFG);

    ok('rebalancing fired (≥1 iteration)', r.data.rebalanceIterations >= 1,
       r.data.rebalanceIterations, '>= 1');
    ok('zone0 reduced from 5 to 4', r.data.zones[0].length === 4, r.data.zones[0].length, 4);
    ok('zone1 grew from 1 to 2',    r.data.zones[1].length === 2, r.data.zones[1].length, 2);
    ok('zone2 unchanged at 1',      r.data.zones[2].length === 1, r.data.zones[2].length, 1);

    const total = r.data.zones.reduce((s, z) => s + z.length, 0);
    ok('total crime count preserved (7)', total === 7, total, 7);
}

// ── Test 4: Zone cap excludes excess nodes, keeps nearest by road distance ────
console.log('\n[Test 4] Zone cap');
{
    const cfg = { ...CFG, tsp: { maxCrimeNodesPerZone: 2 } };

    // Linear chain: n0(patrol)──n1──n2──n3. Road distances: 100m, 200m, 300m to patrol.
    // 3 crimes at n1, n2, n3 → all assigned to sole patrol. Cap=2 → n3 excluded.
    const nodes = [0, 1, 2, 3].map(i => ({ id: `n${i}`, lat: 14.700, lng: 121.090 + i * 0.00093 }));
    const adj   = {
        n0: [{ neighborId: 'n1', weight: 100 }],
        n1: [{ neighborId: 'n0', weight: 100 }, { neighborId: 'n2', weight: 100 }],
        n2: [{ neighborId: 'n1', weight: 100 }, { neighborId: 'n3', weight: 100 }],
        n3: [{ neighborId: 'n2', weight: 100 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: nodes[0].lat, lng: nodes[0].lng, color: '#e74c3c' }];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.094);
    const crimes = nodes.slice(1).map((n, i) => ({ crimeId: `C${i + 1}`, lat: n.lat, lng: n.lng }));

    const r = runZoneAssignment(crimes, patrol, nodes, hull, adj, {}, cfg);

    ok('zone size capped at 2',          r.data.zones[0].length === 2, r.data.zones[0].length, 2);
    ok('cappedZonesCount = 1',           r.data.cappedZonesCount === 1, r.data.cappedZonesCount, 1);
    ok('1 node excluded (zone_cap)',
       r.data.excludedCrimeNodes.filter(e => e.reason === 'zone_cap').length === 1,
       r.data.excludedCrimeNodes.length, 1);
    ok('status warning',                 r.status === 'warning', r.status, 'warning');

    // Cap keeps nearest by road distance: n1 (100m) and n2 (200m), excludes n3 (300m).
    const kept = r.data.zones[0].map(z => z.snappedNodeId).sort();
    ok('nearest 2 nodes retained (n1, n2)', JSON.stringify(kept) === '["n1","n2"]', kept, ['n1','n2']);
    const excluded = r.data.excludedCrimeNodes.map(e => e.snappedNodeId);
    ok('farthest node excluded (n3)',        excluded.includes('n3'), excluded, ['n3']);
}

// ── Test 5: Empty and single node zone classification ─────────────────────────
console.log('\n[Test 5] Empty and single node zone classification');
{
    // Chain n0──n1──n2──n3. Patrols at n0, n2, n3. One crime at n1.
    // Road distances from n1: 100m to n0, 100m to n2, 200m to n3.
    // Tie on n0/n2 → tiebreaker: lower patrol index (s1 at index 0) wins.
    // s2 (n2) and s3 (n3) get empty zones.
    const nodes = [0, 1, 2, 3].map(i => ({ id: `n${i}`, lat: 14.700, lng: 121.090 + i * 0.00093 }));
    const adj   = {
        n0: [{ neighborId: 'n1', weight: 100 }],
        n1: [{ neighborId: 'n0', weight: 100 }, { neighborId: 'n2', weight: 100 }],
        n2: [{ neighborId: 'n1', weight: 100 }, { neighborId: 'n3', weight: 100 }],
        n3: [{ neighborId: 'n2', weight: 100 }],
    };
    const patrols = [
        { id: 's1', nodeId: 'n0', lat: nodes[0].lat, lng: nodes[0].lng, color: '#e74c3c' },
        { id: 's2', nodeId: 'n2', lat: nodes[2].lat, lng: nodes[2].lng, color: '#3498db' },
        { id: 's3', nodeId: 'n3', lat: nodes[3].lat, lng: nodes[3].lng, color: '#2ecc71' },
    ];
    const hull   = boxHull(14.699, 121.089, 14.701, 121.094);
    const crimes = [{ crimeId: 'C1', lat: nodes[1].lat, lng: nodes[1].lng }];

    const r = runZoneAssignment(crimes, patrols, nodes, hull, adj, {}, CFG);

    ok('crime assigned to s1 (tiebreaker: lower patrol index)',
       r.data.zones[0].length === 1, r.data.zones[0].length, 1);
    ok('s1 classified as single node zone',  r.data.singleNodeZones.includes(0),
       r.data.singleNodeZones, 'includes 0');
    ok('s2 classified as empty zone',        r.data.emptyZones.includes(1),
       r.data.emptyZones, 'includes 1');
    ok('s3 classified as empty zone',        r.data.emptyZones.includes(2),
       r.data.emptyZones, 'includes 2');
    ok('2 empty zones total',                r.data.emptyZones.length === 2,
       r.data.emptyZones.length, 2);
    ok('status warning (empty zones exist)', r.status === 'warning', r.status, 'warning');
    ok('multiNodeZones is empty',            r.data.multiNodeZones.length === 0,
       r.data.multiNodeZones.length, 0);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
