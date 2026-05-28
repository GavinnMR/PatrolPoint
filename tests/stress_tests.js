// PatrolPoint Stress Test Runner — with automatic pass/fail assertions
//
// HOW TO USE:
//   1. Open the app in your browser (e.g. http://127.0.0.1:5500)
//   2. Wait for road network to finish loading
//   3. Open DevTools console (F12), type: allow pasting  then Enter
//   4. Paste:  fetch('./tests/stress_tests.js').then(r => r.text()).then(t => eval(t))
//
// COMMANDS:
//   PP_TESTS.run(n)          — run scenario n (1-indexed)
//   PP_TESTS.runStage(1)     — run all Stage 1 scenarios
//   PP_TESTS.runStage(2)     — run all Stage 2 scenarios (needs Hill Climbing)
//   PP_TESTS.runAll()        — run all scenarios
//   PP_TESTS.list()          — list all scenarios

window.PP_TESTS = (() => {

    // ── Assertion helpers ─────────────────────────────────────────────────────

    function pass(label)                  { return { ok: true,  label }; }
    function fail(label, got, expected)   { return { ok: false, label, got, expected }; }

    function chkEq(got, expected, label)  { return got === expected   ? pass(label) : fail(label, got,    `=== ${expected}`); }
    function chkGt(got, min,      label)  { return got > min          ? pass(label) : fail(label, got,    `> ${min}`); }
    function chkNotNull(val,      label)  { return val !== null        ? pass(label) : fail(label, 'null', 'not null'); }
    function chkNull(val,         label)  { return val === null        ? pass(label) : fail(label, val,    'null'); }
    function chkIncludes(str, sub, label) {
        return String(str).toLowerCase().includes(sub.toLowerCase())
            ? pass(label)
            : fail(label, `"${str}"`, `includes "${sub}"`);
    }

    // ── DOM / state readers ───────────────────────────────────────────────────

    function bannerType() {
        const el = document.getElementById('warning-banner');
        if (el.style.display === 'none' || !el.style.display) return 'none';
        return el.className || 'none'; // 'warning' | 'error' | 'none'
    }

    function bannerText() {
        return document.getElementById('warning-banner').textContent.trim();
    }

    function stage1Status() {
        const el = document.querySelector('#trace-stages .trace-stage .trace-status');
        return el ? el.textContent.trim() : null;
    }

    function outlierMarkerCount() {
        return crimeMarkers.filter(m => {
            const html = m.getIcon && m.getIcon().options && m.getIcon().options.html;
            return html && html.includes('#E69F00');
        }).length;
    }

    // ── Scenario definitions ──────────────────────────────────────────────────

    const SCENARIOS = [

        // ══ Stage 1 — Convex Hull ════════════════════════════════════════════

        {
            id: 'S1-T01', stage: 1, n: 3,
            name: 'Happy path — 15 scattered points',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.6985, lng: 121.0882 },
                { lat: 14.7010, lng: 121.0908 }, { lat: 14.7035, lng: 121.0935 },
                { lat: 14.7060, lng: 121.0968 }, { lat: 14.7085, lng: 121.1000 },
                { lat: 14.7110, lng: 121.1032 }, { lat: 14.7000, lng: 121.0862 },
                { lat: 14.7025, lng: 121.0950 }, { lat: 14.7050, lng: 121.0985 },
                { lat: 14.6975, lng: 121.0920 }, { lat: 14.7040, lng: 121.0900 },
                { lat: 14.7080, lng: 121.0928 }, { lat: 14.6992, lng: 121.0990 },
                { lat: 14.7068, lng: 121.0862 }
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed'),
                chkGt(currentHull ? currentHull.length : 0, 2, 'hull has 3+ vertices'),
                chkNotNull(hullPolygon,            'hull polygon on map'),
                chkGt(validCandidates ? validCandidates.length : 0, 0, 'valid candidates found'),
                chkEq(bannerType(), 'none',        'no banner'),
                chkEq(stage1Status(), '✅',         'Stage 1 success')
            ]; }
        },

        {
            id: 'S1-T02', stage: 1, n: 2,
            // Hull is computed but too small to contain any road intersection nodes.
            // Area threshold warning fires internally (visible in trace), then
            // empty-candidates error overwrites the banner.
            name: 'Tight cluster — hull too small for road intersections (empty candidates error)',
            coords: [
                { lat: 14.7020, lng: 121.0935 }, { lat: 14.7022, lng: 121.0941 },
                { lat: 14.7024, lng: 121.0946 }, { lat: 14.7026, lng: 121.0938 },
                { lat: 14.7028, lng: 121.0943 }, { lat: 14.7030, lng: 121.0937 },
                { lat: 14.7023, lng: 121.0948 }, { lat: 14.7027, lng: 121.0933 },
                { lat: 14.7032, lng: 121.0945 }, { lat: 14.7025, lng: 121.0940 }
            ],
            check() { return [
                chkNotNull(hullPolygon,                       'hull polygon rendered (kept on map)'),
                chkEq(validCandidates ? validCandidates.length : -1, 0, 'zero valid candidates'),
                chkEq(bannerType(), 'error',                  'error banner shown'),
                chkIncludes(bannerText(), 'road intersections','banner mentions "road intersections"'),
                chkEq(stage1Status(), '⚠️',                   'Stage 1 trace shows area warning')
            ]; }
        },

        {
            id: 'S1-T03', stage: 1, n: 2,
            name: 'Single strong outlier among 8 clustered points',
            coords: [
                { lat: 14.7026, lng: 121.0939 }, { lat: 14.7033, lng: 121.0951 },
                { lat: 14.7022, lng: 121.0937 }, { lat: 14.7030, lng: 121.0938 },
                { lat: 14.7025, lng: 121.0951 }, { lat: 14.7034, lng: 121.0942 },
                { lat: 14.7021, lng: 121.0946 }, { lat: 14.7031, lng: 121.0955 },
                { lat: 14.7118, lng: 121.1034 }
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed'),
                chkEq(outlierMarkerCount(), 1,     '1 outlier marker (amber)'),
                chkNotNull(hullPolygon,            'hull polygon on map')
            ]; }
        },

        {
            id: 'S1-T04', stage: 1, n: 3,
            name: 'Three extreme outliers among 7 clustered points',
            coords: [
                { lat: 14.7026, lng: 121.0939 }, { lat: 14.7033, lng: 121.0951 },
                { lat: 14.7022, lng: 121.0937 }, { lat: 14.7030, lng: 121.0938 },
                { lat: 14.7025, lng: 121.0951 }, { lat: 14.7034, lng: 121.0942 },
                { lat: 14.7021, lng: 121.0946 },
                { lat: 14.7155, lng: 121.1065 },
                { lat: 14.6952, lng: 121.0836 },
                { lat: 14.7148, lng: 121.0838 }
            ],
            check() { return [
                chkGt(outlierMarkerCount(), 0,     'at least 1 outlier flagged'),
                chkNotNull(hullPolygon,            'hull polygon on map')
            ]; }
        },

        {
            id: 'S1-T05', stage: 1, n: 4,
            name: 'Only 2 points — linear handler',
            coords: [
                { lat: 14.7000, lng: 121.0900 },
                { lat: 14.7100, lng: 121.1000 }
            ],
            check() { return [
                chkNull(currentHull,                     'no hull (linear handler)'),
                chkNull(hullPolygon,                     'no hull polygon'),
                chkEq(patrolMarkers.length, 4,           '4 patrol markers on line'),
                chkEq(bannerType(), 'warning',           'warning banner shown'),
                chkIncludes(bannerText(), '2 incident',  'banner mentions "2 incident"'),
                chkEq(stage1Status(), '⚠️',               'Stage 1 warning')
            ]; }
        },

        {
            id: 'S1-T06', stage: 1, n: 4,
            name: '5 exactly collinear points — linear handler',
            coords: [
                { lat: 14.6960, lng: 121.0850 }, { lat: 14.6990, lng: 121.0880 },
                { lat: 14.7020, lng: 121.0910 }, { lat: 14.7050, lng: 121.0940 },
                { lat: 14.7080, lng: 121.0970 }
            ],
            check() { return [
                chkNull(currentHull,                      'no hull (collinear)'),
                chkNull(hullPolygon,                      'no hull polygon'),
                chkEq(patrolMarkers.length, 4,            '4 patrol markers on line'),
                chkEq(bannerType(), 'warning',            'warning banner shown'),
                chkIncludes(bannerText(), 'collinear',    'banner mentions "collinear"'),
                chkEq(stage1Status(), '⚠️',                'Stage 1 warning')
            ]; }
        },

        {
            id: 'S1-T07', stage: 1, n: 2,
            name: 'Minimal 3-point triangle — thin hull',
            coords: [
                { lat: 14.6955, lng: 121.0855 },
                { lat: 14.7148, lng: 121.1068 },
                { lat: 14.7056, lng: 121.0963 }
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed (not crashed)'),
                chkEq(currentHull ? currentHull.length : 0, 3, '3-vertex hull'),
                chkNotNull(hullPolygon,            'hull polygon on map')
            ]; }
        },

        {
            id: 'S1-T08', stage: 1, n: 4,
            name: 'Near-perfect octagon — all 8 points on hull',
            coords: [
                { lat: 14.7110, lng: 121.0944 }, { lat: 14.7087, lng: 121.1001 },
                { lat: 14.7030, lng: 121.1024 }, { lat: 14.6973, lng: 121.1001 },
                { lat: 14.6950, lng: 121.0944 }, { lat: 14.6973, lng: 121.0887 },
                { lat: 14.7030, lng: 121.0864 }, { lat: 14.7087, lng: 121.0887 }
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed'),
                chkEq(currentHull ? currentHull.length : 0, 8, 'all 8 points on hull'),
                chkNotNull(hullPolygon,            'hull polygon on map'),
                chkEq(bannerType(), 'none',        'no error banner'),
                chkEq(stage1Status(), '✅',         'Stage 1 success')
            ]; }
        },

        {
            id: 'S1-T09', stage: 1, n: 5,
            name: 'Maximum load — 28 points (O(n³) stress)',
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
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed'),
                chkGt(currentHull ? currentHull.length : 0, 2, 'hull has 3+ vertices'),
                chkGt(validCandidates ? validCandidates.length : 0, 0, 'valid candidates found'),
                chkNotNull(hullPolygon,            'hull polygon on map')
            ]; }
        },

        {
            id: 'S1-T10', stage: 1, n: 3,
            name: 'Rectangle hull — hull membership check',
            coords: [
                { lat: 14.6975, lng: 121.0870 }, { lat: 14.7120, lng: 121.0870 },
                { lat: 14.7120, lng: 121.1030 }, { lat: 14.6975, lng: 121.1030 },
                { lat: 14.7048, lng: 121.0950 }
            ],
            check() { return [
                chkNotNull(currentHull,            'hull computed'),
                chkEq(currentHull ? currentHull.length : 0, 4, '4-vertex hull (rectangle)'),
                chkNotNull(hullPolygon,            'hull polygon on map'),
                chkEq(stage1Status(), '✅',         'Stage 1 success')
            ]; }
        },

        {
            id: 'S1-T11', stage: 1, n: 2,
            name: 'Moderate outliers — sensitivity test (reduce multiplier to 1.2 in Settings first)',
            coords: [
                { lat: 14.7028, lng: 121.0944 }, { lat: 14.7035, lng: 121.0955 },
                { lat: 14.7022, lng: 121.0938 }, { lat: 14.7030, lng: 121.0950 },
                { lat: 14.7040, lng: 121.0935 }, { lat: 14.7018, lng: 121.0948 },
                { lat: 14.7070, lng: 121.0995 },
                { lat: 14.6985, lng: 121.0892 }
            ],
            check() { return [
                chkNotNull(hullPolygon,            'hull polygon on map'),
                { ok: 'manual', label: 'Outlier count depends on Settings multiplier — check amber markers on map' }
            ]; }
        },

        // ══ Stage 2 — Hill Climbing ══════════════════════════════════════════
        // NOTE: Requires Hill Climbing implementation (Build Step 4).

        {
            id: 'S2-T01', stage: 2, n: 1,
            name: 'n=1 — single patrol, skip Hill Climbing',
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 }
            ],
            check() { return [
                chkEq(patrolMarkers.length, 1,     '1 patrol marker placed'),
                chkEq(bannerType(), 'none',        'no error banner'),
                chkIncludes(
                    document.querySelector('#trace-stages')?.textContent || '',
                    'single patrol',               'trace mentions single patrol mode'
                )
            ]; }
        },

        {
            id: 'S2-T02', stage: 2, n: 5,
            name: 'n=5 — standard spread, large hull',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() { return [
                chkEq(patrolMarkers.length, 5,     '5 patrol markers placed'),
                chkEq(bannerType(), 'none',        'no error banner')
            ]; }
        },

        {
            id: 'S2-T03', stage: 2, n: 10,
            name: 'n=10 — high patrol count',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6985, lng: 121.0882 },
                { lat: 14.7095, lng: 121.0882 }, { lat: 14.7095, lng: 121.1018 },
                { lat: 14.6985, lng: 121.1018 }, { lat: 14.7040, lng: 121.0882 },
                { lat: 14.7040, lng: 121.1018 }, { lat: 14.6985, lng: 121.0948 }
            ],
            check() { return [
                chkGt(patrolMarkers.length, 0,     'patrol markers placed'),
                chkEq(bannerType(), 'none',        'no error banner')
            ]; }
        },

        {
            id: 'S2-T04', stage: 2, n: 30,
            name: 'n=30 — at n_max soft cap',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() { return [
                chkGt(patrolMarkers.length, 0,     'some patrol markers placed'),
                { ok: 'manual', label: 'Check banner — may warn about n > n_max or capping' }
            ]; }
        },

        {
            id: 'S2-T05', stage: 2, n: 3,
            name: 'Small hull — few valid candidates',
            coords: [
                { lat: 14.7025, lng: 121.0940 }, { lat: 14.7038, lng: 121.0958 },
                { lat: 14.7030, lng: 121.0935 }, { lat: 14.7042, lng: 121.0950 },
                { lat: 14.7028, lng: 121.0962 }
            ],
            check() { return [
                { ok: 'manual', label: 'Check trace — may show n capped to available candidates, or empty-candidates error' }
            ]; }
        },

        {
            id: 'S2-T06', stage: 2, n: 5,
            name: 'Small hull — restart convergence test',
            coords: [
                { lat: 14.7020, lng: 121.0930 }, { lat: 14.7050, lng: 121.0970 },
                { lat: 14.7020, lng: 121.0970 }, { lat: 14.7050, lng: 121.0930 },
                { lat: 14.7035, lng: 121.0950 }
            ],
            check() { return [
                chkGt(patrolMarkers.length, 0,     'patrol markers placed'),
                { ok: 'manual', label: 'Check trace — may show "converged to previously found configuration"' }
            ]; }
        }
    ];

    // ── Runner helpers ────────────────────────────────────────────────────────

    function resetApp() {
        if (typeof pipelineRunning !== 'undefined' && pipelineRunning) {
            console.warn('[PP_TESTS] Pipeline is running — wait for it to finish.');
            return false;
        }
        P.length = 0;
        crimeMarkers.forEach(m => m.remove());
        crimeMarkers.length = 0;
        lastRemovedPoint = null;
        pipelineResults = false;
        clearMapResults({ clearHull: true, clearPatrols: true, clearRoutes: true, clearZoneLines: true, clearNearestHighlights: true });
        clearBanner();
        document.getElementById('trace-stages').innerHTML = '';
        document.getElementById('pipeline-summary').textContent = '';
        return true;
    }

    function printResults(results, scenarioId) {
        let passed = 0, failed = 0, manual = 0;
        results.forEach(r => {
            if (r.ok === 'manual') {
                console.log(`  %c⬜ MANUAL  ${r.label}`, 'color:#888');
                manual++;
            } else if (r.ok) {
                console.log(`  %c✅ PASS    ${r.label}`, 'color:#009E73');
                passed++;
            } else {
                console.log(`  %c❌ FAIL    ${r.label}  (got: ${JSON.stringify(r.got)}, expected: ${r.expected})`, 'color:#D55E00; font-weight:bold');
                failed++;
            }
        });
        const total = passed + failed;
        const color = failed > 0 ? '#D55E00' : '#009E73';
        console.log(`  %c${scenarioId}: ${passed}/${total} assertions passed${manual > 0 ? `, ${manual} manual` : ''}`, `color:${color}; font-weight:bold`);
        return { passed, failed, manual };
    }

    async function run(idx) {
        const s = SCENARIOS[idx - 1];
        if (!s) { console.error(`[PP_TESTS] No scenario ${idx}.`); return; }
        if (!resetApp()) return;

        console.group(`%c[PP_TESTS] ${s.id} — ${s.name}`, 'color:#0072B2; font-weight:bold');
        document.getElementById('patrol-count').value = s.n;
        s.coords.forEach(pt => addCrimeNode(pt));

        const t0 = performance.now();
        await runPipeline();
        const elapsed = Math.round(performance.now() - t0);

        const results = s.check();
        const { passed, failed } = printResults(results, s.id);
        console.log(`  Completed in ${elapsed}ms`);
        console.groupEnd();

        return { passed, failed };
    }

    async function runAll(delayMs = 3000) {
        let totalPassed = 0, totalFailed = 0;
        console.log(`%c[PP_TESTS] Running all ${SCENARIOS.length} scenarios`, 'color:#D55E00; font-weight:bold');
        for (let i = 1; i <= SCENARIOS.length; i++) {
            const r = await run(i);
            if (r) { totalPassed += r.passed; totalFailed += r.failed; }
            if (i < SCENARIOS.length) await new Promise(r => setTimeout(r, delayMs));
        }
        const color = totalFailed > 0 ? '#D55E00' : '#009E73';
        console.log(`%c[PP_TESTS] Done — ${totalPassed} passed, ${totalFailed} failed`, `color:${color}; font-weight:bold`);
    }

    async function runStage(stageNum, delayMs = 3000) {
        const matching = SCENARIOS.filter(s => s.stage === stageNum);
        if (!matching.length) { console.error(`[PP_TESTS] No scenarios for stage ${stageNum}.`); return; }
        let totalPassed = 0, totalFailed = 0;
        console.log(`%c[PP_TESTS] Running ${matching.length} Stage ${stageNum} scenarios`, 'color:#D55E00; font-weight:bold');
        for (let i = 0; i < matching.length; i++) {
            const idx = SCENARIOS.indexOf(matching[i]) + 1;
            const r = await run(idx);
            if (r) { totalPassed += r.passed; totalFailed += r.failed; }
            if (i < matching.length - 1) await new Promise(r => setTimeout(r, delayMs));
        }
        const color = totalFailed > 0 ? '#D55E00' : '#009E73';
        console.log(`%c[PP_TESTS] Stage ${stageNum} done — ${totalPassed} passed, ${totalFailed} failed`, `color:${color}; font-weight:bold`);
    }

    function list() {
        console.log('%c[PP_TESTS] All scenarios:', 'font-weight:bold');
        const byStage = {};
        SCENARIOS.forEach((s, i) => { (byStage[s.stage] = byStage[s.stage] || []).push({ s, i }); });
        for (const [stage, items] of Object.entries(byStage)) {
            console.log(`%c  ── Stage ${stage} ──`, 'color:#888');
            items.forEach(({ s, i }) => console.log(`  ${i + 1}. [${s.id}] (${s.coords.length} pts, n=${s.n}) ${s.name}`));
        }
        console.log('\nRun: PP_TESTS.run(n)  |  PP_TESTS.runStage(1)  |  PP_TESTS.runAll()');
    }

    console.log('%c[PP_TESTS] Stress tests loaded. Commands: PP_TESTS.run(n) | runStage(1) | runAll() | list()', 'color:#009E73; font-weight:bold');
    return { run, runAll, runStage, list, SCENARIOS };
})();
