// test_tsp_verifier.js — focused tests for tsp.js and verifier.js
// Run: node test_tsp_verifier.js

import { runTSP } from '../server/algorithms/tsp.js';
import {
    verifyConvexHull, verifyPatrolPositions,
    verifyZoneAssignment, verifyTSPRoute, verifyAll
} from '../server/algorithms/verifier.js';

const CFG = { tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12 } };

let pass = 0, fail = 0;
const ok = (label, cond, got, want) => {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else       { console.log(`  FAIL  ${label}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); fail++; }
};

function boxHull(s, w, n, e) {
    return [{ lat: s, lng: w }, { lat: n, lng: w },
            { lat: n, lng: e }, { lat: s, lng: e }];
}

// ── Shared setup: diamond graph ───────────────────────────────────────────────
//
// n0 (patrol) ─50m─ n1 ─50m─ n3 ─50m─ n2
//  └──────────────────────────500m──────┘  (direct n0-n2, always more expensive)
//
// Road distances from n0: n1=50, n3=100 (via n1), n2=150 (via n1→n3)
// All permutations of {n1,n2,n3}: optimal = 300m (multiple sequences achieve it)
// Suboptimal [n2,n1,n3] = 150+100+50+100 = 400m — used in Test 8

const diamondNodeMap = {
    n0: { id: 'n0', lat: 14.700, lng: 121.090  },
    n1: { id: 'n1', lat: 14.700, lng: 121.0905 },
    n2: { id: 'n2', lat: 14.700, lng: 121.092  },
    n3: { id: 'n3', lat: 14.700, lng: 121.091  },
};
const diamondAdj = {
    n0: [{ neighborId: 'n1', weight: 50  }, { neighborId: 'n2', weight: 500 }],
    n1: [{ neighborId: 'n0', weight: 50  }, { neighborId: 'n3', weight: 50  }],
    n2: [{ neighborId: 'n3', weight: 50  }, { neighborId: 'n0', weight: 500 }],
    n3: [{ neighborId: 'n1', weight: 50  }, { neighborId: 'n2', weight: 50  }],
};
const diamondPatrol = [{ id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
const diamondCrimes = [
    { crimeId: 'C1', snappedNodeId: 'n1', snappedLat: 14.700, snappedLng: 121.0905 },
    { crimeId: 'C2', snappedNodeId: 'n2', snappedLat: 14.700, snappedLng: 121.092  },
    { crimeId: 'C3', snappedNodeId: 'n3', snappedLat: 14.700, snappedLng: 121.091  },
];
const diamondZones  = [diamondCrimes];
const diamondCache  = {};
const diamondResult = runTSP(
    diamondZones, diamondPatrol, [0], [],
    diamondNodeMap, diamondAdj, diamondCache, CFG
);

// ── Test 1: Road network distance matrix ─────────────────────────────────────
console.log('\n[Test 1] Road network distance matrix');
{
    // n0→n2 via road: n0→n1→n3→n2 = 50+50+50 = 150m  (NOT 500m direct or ~214m Euclidean)
    ok('n0→n2 road dist 150m (not 500m direct or Euclidean)',
       diamondCache['n0']?.distances?.['n2'] === 150,
       diamondCache['n0']?.distances?.['n2'], 150);
    ok('n0→n1 road dist 50m',
       diamondCache['n0']?.distances?.['n1'] === 50,
       diamondCache['n0']?.distances?.['n1'], 50);
    ok('n0→n3 road dist 100m (via n1)',
       diamondCache['n0']?.distances?.['n3'] === 100,
       diamondCache['n0']?.distances?.['n3'], 100);
}

// ── Test 2: Backtracking finds optimal sequence ───────────────────────────────
console.log('\n[Test 2] Backtracking TSP optimal sequence');
{
    const route = diamondResult.data.routes[0];
    ok('status success',          diamondResult.status === 'success', diamondResult.status, 'success');
    ok('circuitDistanceM === 300', route?.circuitDistanceM === 300,    route?.circuitDistanceM, 300);
    ok('approximate === false',   route?.approximate === false,        route?.approximate, false);
}

// ── Test 3: Nearest neighbor fallback activates above threshold ───────────────
console.log('\n[Test 3] Nearest neighbor fallback for k > threshold');
{
    // 14-node chain: n0(patrol), n1..n13 (crimes). k=13 > threshold=12 → NN fallback
    const nm  = {};
    const adj = {};
    for (let i = 0; i <= 13; i++) {
        nm[`n${i}`]  = { id: `n${i}`, lat: 14.700, lng: 121.090 + i * 0.001 };
        adj[`n${i}`] = [];
        if (i > 0)  adj[`n${i}`].push({ neighborId: `n${i - 1}`, weight: 100 });
        if (i < 13) adj[`n${i}`].push({ neighborId: `n${i + 1}`, weight: 100 });
    }
    const patrol = [{ id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
    const crimes = Array.from({ length: 13 }, (_, i) => ({
        crimeId: `C${i + 1}`, snappedNodeId: `n${i + 1}`,
        snappedLat: 14.700, snappedLng: 121.090 + (i + 1) * 0.001,
    }));
    const r     = runTSP([[...crimes]], patrol, [0], [], nm, adj, {}, CFG);
    const route = r.data.routes[0];
    ok('approximate === true (NN fallback active)',
       route?.approximate === true, route?.approximate, true);
    ok('warning mentions nearest neighbor heuristic',
       r.warnings.some(w => w.toLowerCase().includes('nearest neighbor')),
       r.warnings.length, '>0');
}

// ── Test 4: Return leg included in pathSegments ───────────────────────────────
console.log('\n[Test 4] Return leg included in pathSegments');
{
    // Chain n0─n1─n2 (each 100m). Single-node zone: crime at n2.
    // pathSegments[0] = outbound n0→n2 (via n1)
    // pathSegments[1] = return  n2→n0 (via n1) — the explicit return leg
    const nm  = {
        n0: { id: 'n0', lat: 14.700, lng: 121.090 },
        n1: { id: 'n1', lat: 14.700, lng: 121.091 },
        n2: { id: 'n2', lat: 14.700, lng: 121.092 },
    };
    const adj = {
        n0: [{ neighborId: 'n1', weight: 100 }],
        n1: [{ neighborId: 'n0', weight: 100 }, { neighborId: 'n2', weight: 100 }],
        n2: [{ neighborId: 'n1', weight: 100 }],
    };
    const patrol = [{ id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
    const crime  = [{ crimeId: 'C1', snappedNodeId: 'n2', snappedLat: 14.700, snappedLng: 121.092 }];
    const r      = runTSP([[...crime]], patrol, [], [0], nm, adj, {}, CFG);
    const route  = r.data.routes[0];

    ok('isSingleNode === true',
       route?.isSingleNode === true, route?.isSingleNode, true);
    ok('pathSegments.length === 2 (outbound + return)',
       route?.pathSegments?.length === 2, route?.pathSegments?.length, 2);

    const returnLeg = route?.pathSegments?.[1];
    const lastCoord = returnLeg?.[returnLeg.length - 1];
    ok('return leg ends at patrol position n0',
       lastCoord?.lat === 14.700 && lastCoord?.lng === 121.090,
       `${lastCoord?.lat},${lastCoord?.lng}`, '14.7,121.09');

    const firstCoord = returnLeg?.[0];
    ok('return leg starts at crime position n2',
       firstCoord?.lat === 14.700 && firstCoord?.lng === 121.092,
       `${firstCoord?.lat},${firstCoord?.lng}`, '14.7,121.092');
}

// ── Test 5: verifyAll passes on valid pipeline result ─────────────────────────
console.log('\n[Test 5] verifyAll passes on valid pipeline result');
{
    // hull contains all incidents and the patrol node (n0)
    const hull = boxHull(14.699, 121.089, 14.701, 121.093);
    const result = verifyAll({
        hull,
        incidents: [
            { lat: 14.700, lng: 121.0905 }, // n1
            { lat: 14.700, lng: 121.092  }, // n2
            { lat: 14.700, lng: 121.091  }, // n3
        ],
        patrols:         diamondPatrol,
        validCandidates: Object.values(diamondNodeMap),
        zones:           diamondZones,
        routes:          diamondResult.data.routes,
        dijkstraCache:   diamondCache,
    });
    ok('overallPass === true',       result.overallPass === true,  result.overallPass, true);
    ok('failureCount === 0',         result.failureCount === 0,    result.failureCount, 0);
    ok('convexHull.pass === true',   result.convexHull.pass === true,      result.convexHull.pass, true);
    ok('patrolPositions.pass === true', result.patrolPositions.pass === true, result.patrolPositions.pass, true);
    ok('tspRoutes[0].pass === true', result.tspRoutes[0]?.pass === true,   result.tspRoutes[0]?.pass, true);
}

// ── Test 6: verifyConvexHull catches incident outside hull ────────────────────
console.log('\n[Test 6] verifyConvexHull catches incident outside hull');
{
    const hull = boxHull(14.698, 121.089, 14.702, 121.094);
    const result = verifyConvexHull(hull, [
        { lat: 14.700, lng: 121.091 }, // inside
        { lat: 14.710, lng: 121.091 }, // outside — lat > 14.702
    ]);
    ok('pass === false when incident outside hull',
       result.pass === false, result.pass, false);
    ok('message mentions outside',
       result.message.toLowerCase().includes('outside'), result.message, 'includes "outside"');
}

// ── Test 7: verifyZoneAssignment catches duplicate assignment ─────────────────
console.log('\n[Test 7] verifyZoneAssignment catches duplicate assignment');
{
    const zones = [
        [{ crimeId: 'C1', snappedNodeId: 'n1' }],
        [{ crimeId: 'C1', snappedNodeId: 'n1' }], // same crimeId in second zone — duplicate
    ];
    const patrols = [
        { id: 's1', nodeId: 'n0', lat: 14.700, lng: 121.090, color: '#e74c3c' },
        { id: 's2', nodeId: 'n2', lat: 14.700, lng: 121.092, color: '#3498db' },
    ];
    const result = verifyZoneAssignment(zones, patrols, [{ crimeId: 'C1', snappedNodeId: 'n1' }], {});
    ok('pass === false for duplicate assignment',
       result.pass === false, result.pass, false);
    ok('message identifies C1',
       result.message.includes('C1'), result.message, 'includes "C1"');
}

// ── Test 8: verifyTSPRoute catches suboptimal sequence ────────────────────────
console.log('\n[Test 8] verifyTSPRoute catches suboptimal sequence');
{
    // Diamond optimal = 300m. Inject [n2,n1,n3] = 150+100+50+100 = 400m.
    // k=3 ≤ 6, approximate=false → exhaustive check runs → finds 300m → fail.
    const suboptRoute = {
        patrolId: 's1', patrolIndex: 0,
        sequence: [
            { nodeId: 'n0', lat: 14.700, lng: 121.090  },
            { nodeId: 'n2', lat: 14.700, lng: 121.092  },
            { nodeId: 'n1', lat: 14.700, lng: 121.0905 },
            { nodeId: 'n3', lat: 14.700, lng: 121.091  },
            { nodeId: 'n0', lat: 14.700, lng: 121.090  },
        ],
        circuitDistanceM: 400, // correct for this suboptimal sequence
        approximate: false,
        isEmpty: false, isSingleNode: false,
    };
    // diamondCache populated by the setup runTSP — all 4 source nodes cached
    const result = verifyTSPRoute(suboptRoute, diamondCache, 3);
    ok('pass === false for suboptimal sequence',
       result.pass === false, result.pass, false);
    ok('message mentions optimality',
       result.message.toLowerCase().includes('optimal'),
       result.message, 'includes "optimal"');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
