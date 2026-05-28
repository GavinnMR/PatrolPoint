// PatrolPoint Stress Test Runner
//
// HOW TO USE:
//   1. Open the app in your browser (e.g. http://127.0.0.1:5500)
//   2. Wait for road network to finish loading
//   3. Open DevTools console (F12)
//   4. Paste this entire script, or run:
//        fetch('./tests/stress_tests.js').then(r => r.text()).then(t => eval(t))
//
// COMMANDS:
//   PP_TESTS.list()          — print all scenarios with expected outcomes
//   PP_TESTS.run(n)          — run scenario n (1-indexed)
//   PP_TESTS.runStage(1)     — run all Stage 1 scenarios
//   PP_TESTS.runStage(2)     — run all Stage 2 scenarios (requires Hill Climbing impl.)
//   PP_TESTS.runAll()        — run every scenario with 3s delay between each
//
// NOTE: Stage 2 scenarios require Hill Climbing to be implemented (Build Step 4).
//       Running them before that will stop after Stage 1 completes.

window.PP_TESTS = (() => {

    // ── Scenario definitions ──────────────────────────────────────────────────
    const SCENARIOS = [

        // ══ Stage 1 — Convex Hull ════════════════════════════════════════════

        {
            id: 'S1-T01', stage: 1, n: 3,
            name: 'Happy path — 15 scattered points',
            expect: [
                'Clean hull polygon rendered, no warnings',
                'Valid candidates found (check trace panel)',
                'Stage 1: ✅'
            ],
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.6985, lng: 121.0882 },
                { lat: 14.7010, lng: 121.0908 }, { lat: 14.7035, lng: 121.0935 },
                { lat: 14.7060, lng: 121.0968 }, { lat: 14.7085, lng: 121.1000 },
                { lat: 14.7110, lng: 121.1032 }, { lat: 14.7000, lng: 121.0862 },
                { lat: 14.7025, lng: 121.0950 }, { lat: 14.7050, lng: 121.0985 },
                { lat: 14.6975, lng: 121.0920 }, { lat: 14.7040, lng: 121.0900 },
                { lat: 14.7080, lng: 121.0928 }, { lat: 14.6992, lng: 121.0990 },
                { lat: 14.7068, lng: 121.0862 }
            ]
        },

        {
            id: 'S1-T02', stage: 1, n: 2,
            name: 'Tight cluster — area threshold warning',
            expect: [
                'Hull polygon renders (small)',
                'Area threshold warning in banner: "tightly clustered"',
                'Stage 1: ⚠️'
            ],
            coords: [
                { lat: 14.7020, lng: 121.0935 }, { lat: 14.7022, lng: 121.0941 },
                { lat: 14.7024, lng: 121.0946 }, { lat: 14.7026, lng: 121.0938 },
                { lat: 14.7028, lng: 121.0943 }, { lat: 14.7030, lng: 121.0937 },
                { lat: 14.7023, lng: 121.0948 }, { lat: 14.7027, lng: 121.0933 },
                { lat: 14.7032, lng: 121.0945 }, { lat: 14.7025, lng: 121.0940 }
            ]
        },

        {
            id: 'S1-T03', stage: 1, n: 2,
            name: 'Single strong outlier among 8 clustered points',
            expect: [
                'Point[8] flagged amber (the far point)',
                'Hull computed from 8 cluster points only',
                'Trace: "1 outlier detected"',
                'Stage 1: ⚠️ or ✅'
            ],
            coords: [
                { lat: 14.7026, lng: 121.0939 }, { lat: 14.7033, lng: 121.0951 },
                { lat: 14.7022, lng: 121.0937 }, { lat: 14.7030, lng: 121.0938 },
                { lat: 14.7025, lng: 121.0951 }, { lat: 14.7034, lng: 121.0942 },
                { lat: 14.7021, lng: 121.0946 }, { lat: 14.7031, lng: 121.0955 },
                { lat: 14.7118, lng: 121.1034 }  // ~1.1km from cluster centroid
            ]
        },

        {
            id: 'S1-T04', stage: 1, n: 3,
            name: 'Three extreme outliers among 7 clustered points',
            expect: [
                'Multiple amber markers on map',
                'Trace: "X outliers detected" (likely 2–3 depending on centroid pull)',
                'Hull computed from remaining cluster points'
            ],
            coords: [
                { lat: 14.7026, lng: 121.0939 }, { lat: 14.7033, lng: 121.0951 },
                { lat: 14.7022, lng: 121.0937 }, { lat: 14.7030, lng: 121.0938 },
                { lat: 14.7025, lng: 121.0951 }, { lat: 14.7034, lng: 121.0942 },
                { lat: 14.7021, lng: 121.0946 },
                { lat: 14.7155, lng: 121.1065 },  // outlier 1 — northeast edge
                { lat: 14.6952, lng: 121.0836 },  // outlier 2 — southwest edge
                { lat: 14.7148, lng: 121.0838 }   // outlier 3 — northwest edge
            ]
        },

        {
            id: 'S1-T05', stage: 1, n: 4,
            name: 'Only 2 points — linear handler',
            expect: [
                'Warning banner: "Only 2 incident coordinates plotted"',
                '4 patrol markers placed along the line',
                'No hull polygon rendered',
                'Pipeline stops after Stage 1'
            ],
            coords: [
                { lat: 14.7000, lng: 121.0900 },
                { lat: 14.7100, lng: 121.1000 }
            ]
        },

        {
            id: 'S1-T06', stage: 1, n: 4,
            name: '5 exactly collinear points — linear handler',
            expect: [
                'Warning banner: "All incident coordinates are collinear"',
                '4 patrol markers placed along the diagonal line',
                'No hull polygon rendered',
                'Pipeline stops after Stage 1'
            ],
            // All on the line lat = lng - 106.389: verified k=0 for every triple
            coords: [
                { lat: 14.6960, lng: 121.0850 },
                { lat: 14.6990, lng: 121.0880 },
                { lat: 14.7020, lng: 121.0910 },
                { lat: 14.7050, lng: 121.0940 },
                { lat: 14.7080, lng: 121.0970 }
            ]
        },

        {
            id: 'S1-T07', stage: 1, n: 2,
            name: 'Minimal 3-point triangle — thin hull',
            expect: [
                'Valid 3-vertex hull rendered',
                'Area threshold warning likely ("tightly clustered")',
                'Very few valid candidates inside thin triangle',
                'Stage 1: ⚠️'
            ],
            coords: [
                { lat: 14.6955, lng: 121.0855 },
                { lat: 14.7148, lng: 121.1068 },
                { lat: 14.7056, lng: 121.0963 }  // slightly off midpoint — not collinear
            ]
        },

        {
            id: 'S1-T08', stage: 1, n: 4,
            name: 'Near-perfect octagon — all 8 points on hull',
            expect: [
                '8-vertex hull rendered',
                'All 8 points are hull vertices (none interior)',
                'No warnings',
                'Stage 1: ✅'
            ],
            // Center (14.703, 121.0944), r=0.008 at 45° steps
            coords: [
                { lat: 14.7110, lng: 121.0944 },
                { lat: 14.7087, lng: 121.1001 },
                { lat: 14.7030, lng: 121.1024 },
                { lat: 14.6973, lng: 121.1001 },
                { lat: 14.6950, lng: 121.0944 },
                { lat: 14.6973, lng: 121.0887 },
                { lat: 14.7030, lng: 121.0864 },
                { lat: 14.7087, lng: 121.0887 }
            ]
        },

        {
            id: 'S1-T09', stage: 1, n: 5,
            name: 'Maximum load — 28 points (O(n³) stress test)',
            expect: [
                'Hull computed — check trace panel runtime (should be < 50ms)',
                'Hull with ~6–10 vertices enclosing all points',
                'Valid candidates count in trace',
                'Stage 1: ✅'
            ],
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.6975, lng: 121.0870 },
                { lat: 14.6990, lng: 121.0885 }, { lat: 14.7005, lng: 121.0900 },
                { lat: 14.7020, lng: 121.0915 }, { lat: 14.7035, lng: 121.0930 },
                { lat: 14.7050, lng: 121.0945 }, { lat: 14.7065, lng: 121.0960 },
                { lat: 14.7080, lng: 121.0975 }, { lat: 14.7095, lng: 121.0990 },
                { lat: 14.7110, lng: 121.1005 }, { lat: 14.7125, lng: 121.1020 },
                { lat: 14.6970, lng: 121.0900 }, { lat: 14.6985, lng: 121.0932 },
                { lat: 14.7000, lng: 121.0962 }, { lat: 14.7015, lng: 121.0875 },
                { lat: 14.7030, lng: 121.0855 }, { lat: 14.7045, lng: 121.0910 },
                { lat: 14.7060, lng: 121.0990 }, { lat: 14.7075, lng: 121.1022 },
                { lat: 14.7090, lng: 121.0940 }, { lat: 14.7105, lng: 121.0870 },
                { lat: 14.6965, lng: 121.0952 }, { lat: 14.6980, lng: 121.1002 },
                { lat: 14.7055, lng: 121.0862 }, { lat: 14.7070, lng: 121.1042 },
                { lat: 14.7140, lng: 121.0952 }, { lat: 14.6950, lng: 121.1002 }
            ]
        },

        {
            id: 'S1-T10', stage: 1, n: 3,
            name: 'One point near hull edge — hull membership check after pipeline',
            expect: [
                'Hull renders normally',
                'After pipeline: clicking map inside hull adds a new crime node',
                'Clicking outside hull shows "Incident plotted outside the current danger zone" warning',
                '(Manual test — watch the map click behavior after this runs)'
            ],
            coords: [
                { lat: 14.6975, lng: 121.0870 }, { lat: 14.7120, lng: 121.0870 },
                { lat: 14.7120, lng: 121.1030 }, { lat: 14.6975, lng: 121.1030 },
                { lat: 14.7048, lng: 121.0950 }
            ]
        },

        {
            id: 'S1-T11', stage: 1, n: 2,
            name: 'Outlier-sensitivity edge case — reduce multiplier to 1.2 in Settings first',
            expect: [
                'SETUP: Open Settings, set Outlier Multiplier to 1.2, click Apply',
                'With multiplier 1.2: more points get flagged amber',
                'Hull computed from unflagged subset',
                'Compare flagged count vs default multiplier (2.5) run'
            ],
            coords: [
                { lat: 14.7028, lng: 121.0944 }, { lat: 14.7035, lng: 121.0955 },
                { lat: 14.7022, lng: 121.0938 }, { lat: 14.7030, lng: 121.0950 },
                { lat: 14.7040, lng: 121.0935 }, { lat: 14.7018, lng: 121.0948 },
                { lat: 14.7070, lng: 121.0995 },  // moderate outlier (~700m from cluster)
                { lat: 14.6985, lng: 121.0892 }   // moderate outlier (~600m from cluster)
            ]
        },

        // ══ Stage 2 — Hill Climbing ══════════════════════════════════════════
        // NOTE: These require Hill Climbing to be implemented (Build Step 4).
        // Running them now will complete Stage 1 and stop at the Stage 2 placeholder.

        {
            id: 'S2-T01', stage: 2, n: 1,
            name: 'n=1 — single patrol, skip Hill Climbing',
            expect: [
                'Single patrol placed at the most central intersection node',
                'Trace: "Single patrol mode — placed at most central intersection node"',
                'No Hill Climbing restarts shown',
                'Proceeds directly to Stage 3'
            ],
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 }
            ]
        },

        {
            id: 'S2-T02', stage: 2, n: 5,
            name: 'n=5 — standard spread, large hull',
            expect: [
                '5 patrol markers spread inside hull',
                'Trace: best restart index, min pairwise distance (should be >200m)',
                'No duplicate configuration warnings',
                'Stage 2: ✅'
            ],
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ]
        },

        {
            id: 'S2-T03', stage: 2, n: 10,
            name: 'n=10 — high patrol count, watch for radius expansions',
            expect: [
                '10 patrol markers inside hull, visibly spread',
                'Trace: any radius expansions logged?',
                'Trace: any restarts hitting max iterations?',
                'Min pairwise distance likely smaller than S2-T02 due to crowding'
            ],
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6985, lng: 121.0882 },
                { lat: 14.7095, lng: 121.0882 }, { lat: 14.7095, lng: 121.1018 },
                { lat: 14.6985, lng: 121.1018 }, { lat: 14.7040, lng: 121.0882 },
                { lat: 14.7040, lng: 121.1018 }, { lat: 14.6985, lng: 121.0948 }
            ]
        },

        {
            id: 'S2-T04', stage: 2, n: 30,
            name: 'n=30 — at n_max soft cap, watch for cap warning',
            expect: [
                'Warning in banner if n > n_max (n_max = floor(sqrt(914)) = 30)',
                'n may be capped to validCandidates count if hull is small',
                'Trace: how many valid candidates inside hull?'
            ],
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ]
        },

        {
            id: 'S2-T05', stage: 2, n: 3,
            name: 'Small hull — few valid candidates, n may be capped',
            expect: [
                'Very few intersection nodes inside the tiny hull',
                'If candidates < 3: warning, n capped',
                'Possibly: "No road intersections found" error if hull misses all nodes'
            ],
            coords: [
                { lat: 14.7025, lng: 121.0940 }, { lat: 14.7038, lng: 121.0958 },
                { lat: 14.7030, lng: 121.0935 }, { lat: 14.7042, lng: 121.0950 },
                { lat: 14.7028, lng: 121.0962 }
            ]
        },

        {
            id: 'S2-T06', stage: 2, n: 5,
            name: 'Restart convergence test — same config across restarts',
            expect: [
                'In a small hull with few candidates, all 10 restarts converge to same config',
                'Trace: "Restart X converged to previously found configuration" repeated',
                'Stage 2: ⚠️ (low solution diversity)'
            ],
            coords: [
                { lat: 14.7020, lng: 121.0930 }, { lat: 14.7050, lng: 121.0970 },
                { lat: 14.7020, lng: 121.0970 }, { lat: 14.7050, lng: 121.0930 },
                { lat: 14.7035, lng: 121.0950 }
            ]
        }
    ];

    // ── Helpers ───────────────────────────────────────────────────────────────

    function resetApp() {
        if (typeof pipelineRunning !== 'undefined' && pipelineRunning) {
            console.warn('[PP_TESTS] Pipeline is currently running — wait for it to finish.');
            return false;
        }
        P.length = 0;
        crimeMarkers.forEach(m => m.remove());
        crimeMarkers.length = 0;
        lastRemovedPoint = null;
        pipelineResults = false;
        clearMapResults({
            clearHull: true, clearPatrols: true, clearRoutes: true,
            clearZoneLines: true, clearNearestHighlights: true
        });
        clearBanner();
        document.getElementById('trace-stages').innerHTML = '';
        document.getElementById('pipeline-summary').textContent = '';
        return true;
    }

    async function run(idx) {
        const s = SCENARIOS[idx - 1];
        if (!s) {
            console.error(`[PP_TESTS] No scenario ${idx}. Use PP_TESTS.list() to see all.`);
            return;
        }

        if (!resetApp()) return;

        console.group(`%c[PP_TESTS] ${s.id} — ${s.name}`, 'color: #0072B2; font-weight: bold');
        console.log(`Points: ${s.coords.length}  |  n patrols: ${s.n}`);
        console.log('Expected:');
        s.expect.forEach(e => console.log(`  • ${e}`));

        document.getElementById('patrol-count').value = s.n;
        s.coords.forEach(pt => addCrimeNode(pt));

        const t0 = performance.now();
        await runPipeline();
        const elapsed = Math.round(performance.now() - t0);

        console.log(`%cCompleted in ${elapsed}ms`, 'color: #009E73');
        console.groupEnd();
    }

    async function runAll(delayMs = 3000) {
        console.log(`%c[PP_TESTS] Running all ${SCENARIOS.length} scenarios (${delayMs}ms delay between each)`, 'color: #D55E00; font-weight: bold');
        for (let i = 1; i <= SCENARIOS.length; i++) {
            await run(i);
            if (i < SCENARIOS.length) await new Promise(r => setTimeout(r, delayMs));
        }
        console.log('%c[PP_TESTS] All scenarios complete.', 'color: #009E73; font-weight: bold');
    }

    async function runStage(stageNum, delayMs = 3000) {
        const matching = SCENARIOS.filter(s => s.stage === stageNum);
        if (matching.length === 0) {
            console.error(`[PP_TESTS] No scenarios for stage ${stageNum}.`);
            return;
        }
        console.log(`%c[PP_TESTS] Running ${matching.length} Stage ${stageNum} scenarios`, 'color: #D55E00; font-weight: bold');
        for (let i = 0; i < matching.length; i++) {
            const globalIdx = SCENARIOS.indexOf(matching[i]) + 1;
            await run(globalIdx);
            if (i < matching.length - 1) await new Promise(r => setTimeout(r, delayMs));
        }
        console.log(`%c[PP_TESTS] Stage ${stageNum} complete.`, 'color: #009E73; font-weight: bold');
    }

    function list() {
        console.log('%c[PP_TESTS] All scenarios:', 'font-weight: bold');
        const byStage = {};
        SCENARIOS.forEach((s, i) => { (byStage[s.stage] = byStage[s.stage] || []).push({ s, i }); });
        for (const [stage, items] of Object.entries(byStage)) {
            console.log(`%c  ── Stage ${stage} ──`, 'color: #888');
            items.forEach(({ s, i }) => {
                console.log(`  ${i + 1}. [${s.id}] (${s.coords.length} pts, n=${s.n}) ${s.name}`);
            });
        }
        console.log('\nRun with: PP_TESTS.run(n)  |  PP_TESTS.runStage(1)  |  PP_TESTS.runAll()');
    }

    // ── Load message ──────────────────────────────────────────────────────────
    console.log('%c[PP_TESTS] PatrolPoint stress tests loaded.', 'color: #009E73; font-weight: bold');
    console.log('  PP_TESTS.list()         — show all scenarios');
    console.log('  PP_TESTS.run(n)         — run scenario n');
    console.log('  PP_TESTS.runStage(1)    — run all Stage 1 tests');
    console.log('  PP_TESTS.runStage(2)    — run all Stage 2 tests (needs Hill Climbing)');
    console.log('  PP_TESTS.runAll()       — run every scenario');

    return { run, runAll, runStage, list, SCENARIOS };
})();

console.log('Access via: PP_TESTS.run(n), PP_TESTS.runStage(1), PP_TESTS.runAll()');
