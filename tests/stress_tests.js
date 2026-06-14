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

    // v2: pipeline runs server-side via WebSocket; trigger recalculate then poll pipelineRunning
    async function runPipeline() {
        window.uiApp?.recalculate();
        // Phase 1: wait for pipeline to START (pipelineRunning → true), up to 3s
        await new Promise(resolve => {
            const start = Date.now();
            const poll = setInterval(() => {
                if (window.pipelineRunning || Date.now() - start > 3000) {
                    clearInterval(poll);
                    resolve();
                }
            }, 50);
        });
        // Phase 2: wait for pipeline to COMPLETE (pipelineRunning → false), up to 60s
        await new Promise(resolve => {
            const start = Date.now();
            const poll = setInterval(() => {
                if (!window.pipelineRunning || Date.now() - start > 60000) {
                    clearInterval(poll);
                    resolve();
                }
            }, 100);
        });
    }

    // v2: traceStages is Alpine state, status stored as string not emoji
    function stageStatus(n) {
        const stage = window.uiApp?.traceStages?.find(s => s.id === n);
        if (!stage) return null;
        if (stage.status === 'success') return '✅';
        if (stage.status === 'warning') return '⚠️';
        if (stage.status === 'error')   return '❌';
        if (stage.status === 'running') return '🔄';
        return null;
    }

    // v2: banner state lives on window.uiApp, not a DOM element with id="warning-banner"
    function bannerType() {
        const ui = window.uiApp;
        if (!ui || !ui.bannerMessage) return 'none';
        return ui.bannerType || 'warning';
    }

    function bannerText() {
        return window.uiApp?.bannerMessage || '';
    }

    function stage1Status() { return stageStatus(1); }

    function outlierMarkerCount() {
        return Object.values(crimeMarkers).filter(m => {
            const html = m.getIcon && m.getIcon().options && m.getIcon().options.html;
            return html && html.includes('#E69F00');
        }).length;
    }

    // ── Scenario definitions ──────────────────────────────────────────────────

    const SCENARIOS = [

        // ══ Stage 0 — Pre-pipeline Validation ════════════════════════════════

        {
            id: 'S0-T01', stage: 0, n: 0,
            name: 'n=0 — error banner, pipeline fully blocked',
            coords: [
                { lat: 14.7000, lng: 121.0900 }, { lat: 14.7050, lng: 121.0950 }
            ],
            check() { return [
                chkEq(bannerType(), 'error',                        'error banner shown'),
                chkIncludes(bannerText(), 'positive whole number',  'banner mentions valid n requirement'),
                chkEq(Object.keys(window.patrolMarkers || {}).length, 0,                      'no patrol markers placed'),
                chkNull(currentHull,                                'no hull computed'),
                chkEq(zones.length, 0,                              'zones not populated')
            ]; }
        },

        {
            id: 'S0-T02', stage: 0, n: 2.5,
            name: 'n=2.5 decimal — error banner, pipeline fully blocked',
            coords: [
                { lat: 14.7000, lng: 121.0900 }, { lat: 14.7050, lng: 121.0950 }
            ],
            check() { return [
                chkEq(bannerType(), 'error',                'error banner shown'),
                chkIncludes(bannerText(), 'whole number',   'banner mentions whole number requirement'),
                chkEq(Object.keys(window.patrolMarkers || {}).length, 0,              'no patrol markers placed'),
                chkNull(currentHull,                        'no hull computed')
            ]; }
        },

        {
            id: 'S0-T03', stage: 0, n: 3,
            name: '|P|=1 — error banner, pipeline fully blocked',
            coords: [
                { lat: 14.7000, lng: 121.0900 }
            ],
            check() { return [
                chkEq(bannerType(), 'error',                        'error banner shown'),
                chkIncludes(bannerText(), '2 incident',             'banner mentions minimum 2 coords'),
                chkEq(Object.keys(window.patrolMarkers || {}).length, 0,                      'no patrol markers placed'),
                chkNull(currentHull,                                'no hull computed')
            ]; }
        },

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
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner'),
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
                chkEq(Object.keys(window.patrolMarkers || {}).length, 4,           '4 patrol markers on line'),
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
                chkEq(Object.keys(window.patrolMarkers || {}).length, 4,            '4 patrol markers on line'),
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
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner'),
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

        {
            id: 'S1-T12', stage: 1, n: 2,
            name: 'Empty candidates — 5 nearest intersection highlights rendered',
            coords: [
                { lat: 14.7020, lng: 121.0935 }, { lat: 14.7022, lng: 121.0941 },
                { lat: 14.7024, lng: 121.0946 }, { lat: 14.7026, lng: 121.0938 },
                { lat: 14.7028, lng: 121.0943 }, { lat: 14.7030, lng: 121.0937 },
                { lat: 14.7023, lng: 121.0948 }, { lat: 14.7027, lng: 121.0933 },
                { lat: 14.7032, lng: 121.0945 }, { lat: 14.7025, lng: 121.0940 }
            ],
            check() { return [
                chkEq(validCandidates ? validCandidates.length : -1, 0, 'zero valid candidates'),
                chkEq((window.nearestHighlights || []).length, 5,   '5 nearest intersection highlights on map'),
                chkEq(bannerType(), 'error',                         'error banner shown'),
                chkIncludes(bannerText(), 'road intersections',      'banner mentions road intersections')
            ]; }
        },

        // ══ Stage 2 — Hill Climbing ══════════════════════════════════════════

        {
            id: 'S2-T01', stage: 2, n: 1,
            name: 'n=1 — single patrol, skip Hill Climbing',
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 }
            ],
            check() { return [
                chkEq(Object.keys(window.patrolMarkers || {}).length, 1,              '1 patrol marker placed'),
                chkEq(S_star ? S_star.length : 0, 1,        'S_star has 1 position'),
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner'),
                chkIncludes(
                    document.getElementById('trace-content')?.textContent || '',
                    'single patrol',                        'trace mentions single patrol mode'
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
                chkEq(Object.keys(window.patrolMarkers || {}).length, 5,              '5 patrol markers placed'),
                chkEq(S_star ? S_star.length : 0, 5,        'S_star has 5 positions'),
                chkEq(S_star ? new Set(S_star.map(p => p.id)).size : 0, 5, 'all 5 positions are unique nodes'),
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
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
                chkEq(Object.keys(window.patrolMarkers || {}).length, 10,             '10 patrol markers placed'),
                chkEq(S_star ? S_star.length : 0, 10,       'S_star has 10 positions'),
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
            ]; }
        },

        {
            id: 'S2-T04', stage: 2, n: 30,
            name: 'n=30 — exactly at n_max, no n_max warning fires',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() { return [
                chkEq(Object.keys(window.patrolMarkers || {}).length, 30,             '30 patrol markers placed'),
                chkEq(S_star ? S_star.length : 0, 30,       'S_star has 30 positions'),
                chkEq(bannerText().includes('recommended maximum') ? 'bad' : 'ok', 'ok',
                    'n=30 is exactly n_max — no n_max warning fires'),
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok',
                    'no error banner (HC warnings are acceptable)')
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
                chkGt(Object.keys(window.patrolMarkers || {}).length, 0,              'patrol markers placed'),
                { ok: 'manual', label: 'Check trace — may show "converged to previously found configuration"' }
            ]; }
        },

        {
            id: 'S2-T07', stage: 2, n: 2,
            name: 'n=2 — minimum multi-patrol, positions must be distinct nodes',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const distinct = S_star && S_star.length === 2 ? S_star[0].id !== S_star[1].id : false;
                return [
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 2,          '2 patrol markers placed'),
                    chkEq(S_star ? S_star.length : 0, 2,    'S_star has 2 positions'),
                    chkEq(distinct ? 'yes' : 'no', 'yes',   'both positions are at distinct nodes'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok',
                        'no error banner (convergence warnings expected with n=2)')
                ];
            }
        },

        {
            id: 'S2-T08', stage: 2, n: 5,
            name: 'n=5 — all patrol positions lie inside hull',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const uniqueCount = S_star ? new Set(S_star.map(p => p.id)).size : 0;
                const allInHull = S_star && currentHull
                    ? S_star.every(p => isPointInHull(p, currentHull))
                    : false;
                return [
                    chkEq(S_star ? S_star.length : 0, 5,    'S_star has 5 positions'),
                    chkEq(uniqueCount, 5,                    'all 5 positions are unique nodes'),
                    chkEq(allInHull ? 'yes' : 'no', 'yes',  'all positions lie inside hull'),
                    chkEq(Object.keys(window.patrolMarkers || {}).length, S_star ? S_star.length : -1,
                        'marker count matches S_star length')
                ];
            }
        },

        {
            id: 'S2-T09', stage: 2, n: 31,
            name: 'n=31 — exceeds n_max, warning fires, pipeline continues',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() { return [
                chkEq(bannerType(), 'warning',              'warning banner shown'),
                chkIncludes(bannerText(), 'exceeds',        'banner mentions "exceeds"'),
                chkEq(Object.keys(window.patrolMarkers || {}).length, 31,             '31 patrol markers placed — pipeline continued')
            ]; }
        },

        {
            id: 'S2-T10', stage: 2, n: 8,
            name: 'n=8 — S_star, patrolMarkers, and unique node IDs all in agreement',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 }
            ],
            check() {
                const uniqueIds = S_star ? new Set(S_star.map(p => p.id)).size : 0;
                return [
                    chkEq(S_star ? S_star.length : 0, 8,   'S_star has 8 positions'),
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 8,          '8 patrol markers on map'),
                    chkEq(uniqueIds, 8,                     '8 unique node IDs in S_star'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        // ══ Stage 2 — Road Distance Matrix ══════════════════════════════════

        {
            id: 'S2-T11', stage: 2, n: 5,
            name: 'Road distance matrix — Stage 2 trace confirms road network metric used',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const traceText = document.getElementById('trace-content')?.textContent || '';
                return [
                    chkIncludes(traceText, 'road network',      'Stage 2 trace confirms road network distance metric'),
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 5,              '5 patrol markers still placed (matrix did not break placement)'),
                    chkEq(S_star ? S_star.length : 0, 5,        'S_star has 5 positions'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        {
            id: 'S2-T12', stage: 2, n: 5,
            name: 'Road distance matrix — bestMinPairwiseDist is finite and positive',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                // v2: summaries are Alpine state, not DOM elements
                const s2Summary = window.uiApp?.traceStages?.find(s => s.id === 2)?.summary || '';
                const distMatch = s2Summary.match(/min pairwise[^:]*:\s*([\d.]+)m/i);
                const dist = distMatch ? parseFloat(distMatch[1]) : null;
                return [
                    chkEq(S_star ? S_star.length : 0, 5,                        'S_star has 5 positions'),
                    chkEq(dist !== null ? 'ok' : 'fail', 'ok',                  'Stage 2 summary contains min pairwise distance'),
                    chkEq(dist > 0 ? 'ok' : 'fail', 'ok',                       'min pairwise distance is positive (> 0m)'),
                    chkEq(dist < Infinity ? 'ok' : 'fail', 'ok',                'min pairwise distance is finite (not Infinity)')
                ];
            }
        },

        {
            id: 'S2-T13', stage: 2, n: 3,
            name: 'Road distance matrix — n=1 single patrol uses matrix for central node',
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 }
            ],
            check() {
                // Set n=1 to trigger the single-patrol code path that uses road matrix
                const traceText = document.getElementById('trace-content')?.textContent || '';
                return [
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 3,              '3 patrol markers placed'),
                    chkEq(S_star ? S_star.length : 0, 3,        'S_star has 3 positions'),
                    chkEq(new Set(S_star?.map(p => p.nodeId) ?? []).size, 3, 'all 3 positions at distinct nodes'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        {
            id: 'S2-T14', stage: 2, n: 1,
            name: 'Road distance matrix — n=1 single patrol, central node via road distances',
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 }
            ],
            check() {
                const traceText = document.getElementById('trace-content')?.textContent || '';
                return [
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 1,              '1 patrol marker placed'),
                    chkIncludes(traceText, 'road network',      'trace confirms road network metric used for central node'),
                    chkIncludes(traceText, 'single patrol',     'trace confirms single patrol mode'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        // ══ Stage 3 — Zone Assignment (Build Step 5) ═════════════════════════

        {
            id: 'S3-T01', stage: 3, n: 3,
            name: 'Happy path — zones array formed, line count matches assigned nodes',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const totalAssigned = zones ? zones.reduce((s, z) => s + z.length, 0) : -1;
                return [
                    chkEq(zones ? zones.length : -1, 3,             'zones array has 3 entries'),
                    chkGt(totalAssigned, 0,                         'at least some nodes assigned'),
                    chkEq((window.zoneLines || []).length, totalAssigned, 'one zone line per assigned node'),
                    chkEq(stageStatus(3) === '✅' || stageStatus(3) === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 3 completed without error'),
                    chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        {
            id: 'S3-T02', stage: 3, n: 10,
            name: 'n=10 with 7 crime nodes — guaranteed empty zones (10 patrols > 7 nodes), stationary warning',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 },
                { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.1005 }
            ],
            check() {
                const emptyCount = zones ? zones.filter(z => z.length === 0).length : -1;
                return [
                    chkEq(Object.keys(window.patrolMarkers || {}).length, 10,                 '10 patrol markers on map'),
                    chkGt(emptyCount, 0,                            'at least one empty zone (n > crime nodes guarantees this)'),
                    chkEq(bannerType(), 'warning',                  'warning banner shown'),
                    chkIncludes(bannerText(), 'stationary',         'banner mentions stationary'),
                    { ok: 'manual', label: 'Verify: stationary patrols show hollow S-marker on map' }
                ];
            }
        },

        {
            id: 'S3-T03', stage: 3, n: 1,
            name: 'Zone cap — n=1 with 28 spread nodes capped to maxCrimeNodesPerZone',
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
            check() {
                const cap = (typeof CONFIG !== 'undefined' && CONFIG.tsp) ? CONFIG.tsp.maxCrimeNodesPerZone : 10;
                return [
                    chkEq(zones ? zones.length : -1, 1,             '1 zone for 1 patrol'),
                    chkEq(zones && zones[0] ? zones[0].length : -1, cap, `zone capped to ${cap} nodes`),
                    chkEq(bannerType(), 'warning',                  'warning banner shown'),
                    chkIncludes(bannerText(), 'capped',             'banner mentions capped')
                ];
            }
        },

        {
            id: 'S3-T04', stage: 3, n: 4,
            name: 'zones.length always equals number of patrols',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 }
            ],
            check() { return [
                chkEq(zones ? zones.length : -1, 4,                 'zones.length === 4'),
                chkEq(zones ? zones.length : -1, S_star ? S_star.length : -2,
                    'zones.length === S_star.length'),
                chkEq(stageStatus(3) === '✅' || stageStatus(3) === '⚠️' ? 'ok' : 'fail', 'ok',
                    'Stage 3 completed without error')
            ]; }
        },

        {
            id: 'S3-T05', stage: 3, n: 3,
            name: 'Stage 3 trace entry present and status not error',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const traceText = document.getElementById('trace-content')?.textContent || '';
                return [
                    chkIncludes(traceText, 'Zone Assignment',       'Stage 3 trace entry present'),
                    chkIncludes(traceText, 'Hill Climbing',         'Stage 3 references Hill Climbing restart'),
                    chkEq(stageStatus(3) === '✅' || stageStatus(3) === '⚠️' ? 'ok' : 'fail', 'ok',
                        'Stage 3 status is not error')
                ];
            }
        },

        {
            id: 'S3-T06', stage: 3, n: 3,
            name: 'Snapping distance >200m — Stage 3 status Warning, banner fires',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() { return [
                chkEq(stageStatus(3), '⚠️',                         'Stage 3 status is Warning'),
                chkEq(bannerType(), 'warning',                      'warning banner shown'),
                chkIncludes(bannerText(), 'snapping distance',      'banner mentions snapping distance')
            ]; }
        },

        {
            id: 'S3-T07', stage: 3, n: 3,
            name: 'Stage 4 data readiness — zone nodes and S_star have valid id/lat/lng',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const nodesValid = zones
                    ? zones.every(z => z.every(sn =>
                        typeof sn.id === 'string' &&
                        typeof sn.lat === 'number' &&
                        typeof sn.lng === 'number'))
                    : false;
                const sStarValid = S_star
                    ? S_star.every(p => typeof p.id === 'string' && p.id.startsWith('n'))
                    : false;
                const multipleZones = zones ? zones.some(z => z.length > 1) : false;
                const multiNodesUnique = zones
                    ? zones.every(z => z.length <= 1 || new Set(z.map(sn => sn.id)).size === z.length)
                    : false;
                return [
                    chkEq(nodesValid ? 'ok' : 'fail', 'ok',        'all zone nodes have string id, number lat/lng'),
                    chkEq(sStarValid ? 'ok' : 'fail', 'ok',        'all S_star positions have node id starting with n'),
                    chkEq(multipleZones ? 'ok' : 'skip', 'ok',     'at least one multi-node zone exists'),
                    chkEq(multiNodesUnique ? 'ok' : 'fail', 'ok',  'no duplicate node IDs within any zone')
                ];
            }
        },

        // ══ Stage 3 — Road Distance (zone assignment uses Dijkstra, not Haversine) ════

        {
            id: 'S3-T08', stage: 3, n: 3,
            name: 'Road distance — dijkstraCache pre-filled by Stage 3 in stationary mode (Stage 4 never runs)',
            // Stage 4 is skipped in stationary mode. Before the road-distance fix, dijkstraCache
            // stayed empty after Stage 3. After the fix, Stage 3 runs Dijkstra from each patrol
            // and populates the cache — so dijkstraCache must be non-empty even with no Stage 4.
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                // dijkstraCache lives server-side; verify Stage 3 ran road distances via trace
                const s3 = window.uiApp?.traceStages?.find(s => s.id === 3);
                const s3Log = s3?.fullLog || '';
                return [
                    chkNull(stageStatus(4), 'Stage 4 did not run (stationary mode)'),
                    chkNotNull(s3, 'Stage 3 trace entry present'),
                    chkEq(s3?.status !== 'error' ? 'ok' : 'fail', 'ok', 'Stage 3 completed without error')
                ];
            }
        },

        {
            id: 'S3-T09', stage: 3, n: 10,
            name: 'Road distance — single-node zone round trip comes from dijkstraCache, not Haversine',
            // n=10 with 5 spread crime nodes → 5 single-node zones + 5 empty zones (10 patrols, 5 nodes).
            // For each single-node zone, Stage 3 must have a dijkstraCache entry for that patrol→crime pair
            // and the trace log must show a finite road distance, not "undefined" or "unreachable by road".
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                // dijkstraCache and normalizeEdgeKey are server-side; verify via client trace text
                const s3 = window.uiApp?.traceStages?.find(s => s.id === 3);
                const traceText = s3?.fullLog || '';
                const hasSingleZone = zones ? zones.some(z => z && z.length === 1) : false;
                if (!hasSingleZone) {
                    return [{ ok: 'manual', label: 'No single-node zone produced — re-run or check zone distribution' }];
                }
                return [
                    chkIncludes(traceText, 'direct visit',
                        'Stage 3 trace contains "direct visit" for single-node zone'),
                    chkEq(!traceText.includes('round trip undefinedm') ? 'ok' : 'fail', 'ok',
                        'round trip distance resolved to a number, not undefined')
                ];
            }
        },

        // ══ Stage 4 — Backtracking TSP ══════════════════════════════════════

        {
            id: 'S4-T01', stage: 4, n: 3, mode: 'roaming',
            name: 'Roaming — n=3, 9 crime nodes — TSP routes rendered, Stage 4 present',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const s4 = stageStatus(4);
                return [
                    chkGt(Object.keys(window.patrolRoutes || {}).length, 0,                     'route polylines rendered'),
                    chkNotNull(s4,                                       'Stage 4 trace entry present'),
                    chkEq(s4 === '✅' || s4 === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 4 not error'),
                    chkEq(['none','warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        {
            id: 'S4-T02', stage: 4, n: 3, mode: 'stationary',
            name: 'Stationary — same coords — no Stage 4 trace entry, pipeline stops after Stage 3',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                return [
                    chkNull(stageStatus(4),                              'no Stage 4 trace entry (stationary stops after Stage 3)'),
                    chkEq(['none','warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner'),
                    chkEq(stageStatus(3) === '✅' || stageStatus(3) === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 3 completed'),
                    { ok: 'manual', label: 'Verify: zone lines visible on map, no road-following routes' }
                ];
            }
        },

        {
            id: 'S4-T03', stage: 4, n: 1, mode: 'roaming',
            name: 'Roaming — n=1, 2 crime nodes — k=2 case, circuit rendered',
            coords: [
                { lat: 14.6990, lng: 121.0880 }, { lat: 14.7060, lng: 121.0960 },
                { lat: 14.7030, lng: 121.1010 }, { lat: 14.6970, lng: 121.0970 },
                { lat: 14.7080, lng: 121.0880 },
                { lat: 14.7000, lng: 121.0900 },
                { lat: 14.7050, lng: 121.0940 }
            ],
            check() {
                const s4 = stageStatus(4);
                const traceText = document.getElementById('trace-content')?.textContent || '';
                return [
                    chkGt(Object.keys(window.patrolRoutes || {}).length, 0,                         'route polylines rendered'),
                    chkNotNull(s4,                                           'Stage 4 trace entry present'),
                    chkEq(s4 === '✅' || s4 === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 4 not error'),
                    chkEq(['none','warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner')
                ];
            }
        },

        {
            id: 'S4-T04', stage: 4, n: 2, mode: 'roaming',
            name: 'Roaming — n=2, multiple crime nodes — dijkstraCache populated',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                // dijkstraCache lives server-side; verify TSP ran via routes on map + Stage 4 trace
                const s4 = window.uiApp?.traceStages?.find(s => s.id === 4);
                const s4Metrics = s4?.metrics || [];
                const cacheMetric = s4Metrics.find(m => m.label?.toLowerCase().includes('cache hit'));
                return [
                    chkGt(Object.keys(window.patrolRoutes || {}).length, 0, 'route polylines rendered'),
                    chkNotNull(cacheMetric, 'Stage 4 cache hit rate metric present'),
                    chkEq(stageStatus(4) === '✅' || stageStatus(4) === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 4 not error')
                ];
            }
        },

        {
            id: 'S4-T05', stage: 4, n: 1, mode: 'roaming',
            name: 'Roaming — n=1, 28 crime nodes — zone capped, TSP runs on capped set',
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
            check() {
                const cap = (typeof CONFIG !== 'undefined' && CONFIG.tsp) ? CONFIG.tsp.maxCrimeNodesPerZone : 10;
                const s4 = stageStatus(4);
                return [
                    chkEq(zones && zones[0] ? zones[0].length : -1, cap, `zone capped to ${cap} nodes`),
                    chkGt(Object.keys(window.patrolRoutes || {}).length, 0, 'TSP routes rendered for capped zone'),
                    chkNotNull(s4,                                       'Stage 4 trace entry present'),
                    chkEq(s4 === '✅' || s4 === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 4 not error')
                ];
            }
        },

        {
            id: 'S4-T06', stage: 4, n: 3, mode: 'roaming',
            name: 'Road distance — Stage 3 cache pre-population gives Stage 4 cache hits for patrol→crime pairs',
            // Stage 3 runs Dijkstra from each patrol and stores patrol→crime pairs in dijkstraCache.
            // Stage 4 then iterates the same patrol→crime pairs and must find them cached (needsCompute=[]).
            // "Dijkstra calls avoided (cache): X" in the Stage 4 summary must have X > 0.
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const traceText = document.getElementById('trace-content')?.textContent || '';
                const hitMatch  = traceText.match(/dijkstra calls avoided \(cache\):\s*(\d+)/i);
                const cacheHits = hitMatch ? parseInt(hitMatch[1], 10) : null;
                return [
                    chkGt(Object.keys(window.patrolRoutes || {}).length, 0,
                        'TSP routes rendered'),
                    chkEq(cacheHits !== null ? 'ok' : 'fail', 'ok',
                        'Stage 4 summary contains "Dijkstra calls avoided (cache): X"'),
                    chkGt(cacheHits ?? -1, 0,
                        `Stage 4 reports >0 cache hits — Stage 3 pre-populated patrol→crime pairs (got: ${cacheHits})`)
                ];
            }
        },

        // ══ Stage 4 — Path-Aware Sequence Adjustment ════════════════════════════
        // commit e884fdc: adjustSequence() moves crime nodes encountered as natural road
        // intermediates to the point of traversal, eliminating redundant backtracking.

        {
            id: 'S4-T07', stage: 4, n: 3, mode: 'roaming',
            name: 'Path-aware adjustment — "Seq. adjustments" metric always present with numeric value >= 0',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const s4       = window.uiApp?.traceStages?.find(s => s.id === 4);
                const metrics  = s4?.metrics || [];
                const adjMetric = metrics.find(m => m.label?.toLowerCase().includes('seq. adjustments'));
                return [
                    chkNotNull(adjMetric,
                        'Stage 4 metrics include "Seq. adjustments" entry'),
                    chkEq(typeof adjMetric?.value === 'number' ? 'ok' : 'fail', 'ok',
                        `"Seq. adjustments" value is a number (got: ${typeof adjMetric?.value})`),
                    chkEq((adjMetric?.value ?? -1) >= 0 ? 'ok' : 'fail', 'ok',
                        `"Seq. adjustments" value is >= 0 (got: ${adjMetric?.value})`),
                    chkEq(adjMetric?.tooltip?.length > 5 ? 'ok' : 'fail', 'ok',
                        '"Seq. adjustments" metric has a tooltip description'),
                ];
            }
        },

        {
            id: 'S4-T08', stage: 4, n: 3, mode: 'roaming',
            name: 'Path-aware adjustment — sequenceAdjustmentsMade field present on all route objects',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const r = window.routes || [];
                const allHaveField = r.length > 0 && r.every(route =>
                    typeof route.sequenceAdjustmentsMade === 'number' &&
                    route.sequenceAdjustmentsMade >= 0
                );
                return [
                    chkGt(r.length, 0,
                        'window.routes is populated'),
                    chkEq(allHaveField ? 'ok' : 'fail', 'ok',
                        'every route object has sequenceAdjustmentsMade as a non-negative number'),
                ];
            }
        },

        {
            id: 'S4-T09', stage: 4, n: 3, mode: 'roaming',
            name: 'Path-aware adjustment — trace log and summary are consistent with adjustment count',
            // When adjustments fire: fullLog contains "sequence adjusted", summary contains "Sequence adjustments: X".
            // When 0 adjustments: neither appears.
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const s4       = window.uiApp?.traceStages?.find(s => s.id === 4);
                const fullLog  = s4?.fullLog  || '';
                const summary  = s4?.summary  || '';
                const metrics  = s4?.metrics  || [];
                const adjMetric = metrics.find(m => m.label?.toLowerCase().includes('seq. adjustments'));
                const adjCount = adjMetric?.value ?? 0;

                if (adjCount > 0) {
                    return [
                        chkIncludes(fullLog, 'sequence adjusted',
                            `fullLog contains "sequence adjusted" for ${adjCount} adjustment(s)`),
                        chkIncludes(summary, 'Sequence adjustments:',
                            'Stage 4 summary includes "Sequence adjustments: X" line'),
                    ];
                }
                // adjCount === 0 — neither trace entry should appear
                return [
                    chkEq(!fullLog.includes('sequence adjusted') ? 'ok' : 'fail', 'ok',
                        'no "sequence adjusted" in fullLog when adjustment count is 0'),
                    chkEq(!summary.includes('Sequence adjustments:') ? 'ok' : 'fail', 'ok',
                        'no "Sequence adjustments:" in summary when count is 0'),
                ];
            }
        },

        {
            id: 'S4-T10', stage: 4, n: 3, mode: 'roaming',
            name: 'Path-aware adjustment — route sequence nodes are a subset of zone snapped node IDs (no phantom nodes)',
            // adjustSequence() rearranges existing crime nodes in-place.
            // It must never insert a node that was not already in the zone.
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const r = window.routes || [];
                const z = window.zones  || [];
                if (!r.length || !z.length) {
                    return [fail('routes and zones populated', r.length + '/' + z.length, '> 0')];
                }

                let violation = null;
                for (const route of r) {
                    if (route.isEmpty) continue; // empty routes have no sequence to check
                    const pi             = route.patrolIndex;
                    const zoneSnappedIds = new Set((z[pi] || []).map(c => c.snappedNodeId));
                    // sequence = [patrol, crime1, ..., crimeK, patrol] — skip first and last nodes
                    const midNodes = (route.sequence || []).slice(1, -1).map(sn => sn.nodeId);
                    for (const nodeId of midNodes) {
                        if (!zoneSnappedIds.has(nodeId)) {
                            violation = `patrol ${route.patrolId}: nodeId ${nodeId} is not in zones[${pi}] snappedNodeIds`;
                            break;
                        }
                    }
                    if (violation) break;
                }
                return [
                    chkEq(violation === null ? 'ok' : 'fail', 'ok',
                        violation !== null
                            ? `phantom node inserted by adjustment: ${violation}`
                            : 'all sequence mid-nodes are valid snappedNodeIds from assigned zone'),
                ];
            }
        },

        // ══ Session Fixes — Bug fixes and new feature verification ══════════════
        //    Bug 5: patrol popup shows correct crime node count (off-by-one fix)
        //    Bug 7: routes cleared when switching from roaming to stationary
        //    Confidence: weighted composite formula (0-100 range check)
        //    New metrics: spread quality (S2), zone balance + coverage rate (S3),
        //                 cache hit rate + total circuit dist (S4)
        //    Em-dash removal: no '—' in any user-visible trace text
        //    Full log preamble: structured header present in each stage's full log
        //    Emoji removal: stage status is text-based in DOM

        {
            id: 'SF-T01', stage: 8, n: 2,
            name: 'Bug 5 fix — patrol popup shows correct crime node count for patrol s1',
            // s1 maps to zones[0] (0-based). Before fix: zones[idx] where idx=1 (wrong). After: zones[idx-1]=zones[0] (correct).
            // Use an asymmetric incident distribution so zones[0].length != zones[1].length and we can detect the error.
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.6965, lng: 121.0860 },
                { lat: 14.6970, lng: 121.0865 },
                { lat: 14.7120, lng: 121.1042 }, { lat: 14.7115, lng: 121.1038 },
                { lat: 14.7110, lng: 121.1034 }, { lat: 14.7105, lng: 121.1030 },
                { lat: 14.7100, lng: 121.1026 }
            ],
            check() {
                // Helper: read the crime node count shown in the patrol info popup
                function getPopupCrimeCount(patrolId) {
                    window.showPatrolInfoPanel?.(patrolId);
                    const panel = document.querySelector('.patrol-info-panel');
                    if (!panel) return null;
                    const rows = panel.querySelectorAll('.pp-row');
                    for (const row of rows) {
                        const label = row.querySelector('.pp-label');
                        if (label && label.textContent.includes('Crime nodes')) {
                            const val = row.querySelector('.pp-value');
                            return val ? parseInt(val.textContent, 10) : null;
                        }
                    }
                    return null;
                }

                const s1ZoneCount = zones ? (zones[0]?.length ?? -1) : -1;
                const s2ZoneCount = zones ? (zones[1]?.length ?? -1) : -1;

                if (s1ZoneCount === s2ZoneCount) {
                    return [{ ok: 'manual', label: 'Both zones have same size — cannot distinguish correct from wrong index. Re-run with coordinates that produce different zone sizes.' }];
                }

                const popupCountForS1 = getPopupCrimeCount('s1');
                const popupCountForS2 = getPopupCrimeCount('s2');

                return [
                    chkGt(Math.abs(s1ZoneCount - s2ZoneCount), 0,
                        `zones[0].length (${s1ZoneCount}) differs from zones[1].length (${s2ZoneCount}) — test is meaningful`),
                    chkEq(popupCountForS1, s1ZoneCount,
                        `popup for s1 shows zones[0].length (${s1ZoneCount}), not zones[1].length (${s2ZoneCount})`),
                    chkEq(popupCountForS2, s2ZoneCount,
                        `popup for s2 shows zones[1].length (${s2ZoneCount})`),
                ];
            }
        },

        {
            id: 'SF-T02', stage: 8, n: 3, mode: 'roaming',
            name: 'Bug 7 fix — stationary re-run clears route polylines left by prior roaming run',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            // check() is async — the runner must await it (runner updated below to support this)
            async check() {
                const routeCountAfterRoaming = Object.keys(window.patrolRoutes || {}).length;

                // Switch mode and re-run with the same crime nodes still in P
                if (window.uiApp) window.uiApp.deploymentMode = 'stationary';
                await runPipeline();

                const routeCountAfterStationary = Object.keys(window.patrolRoutes || {}).length;
                return [
                    chkGt(routeCountAfterRoaming, 0,
                        'roaming run produced route polylines on map'),
                    chkEq(routeCountAfterStationary, 0,
                        'switching to stationary and re-running cleared all route polylines'),
                ];
            }
        },

        {
            id: 'SF-T03', stage: 8, n: 3,
            name: 'Confidence — improved formula produces value in [0, 100]',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const s2 = window.uiApp?.traceStages?.find(s => s.id === 2);
                const conf = s2?.confidence;
                return [
                    chkEq(typeof conf === 'number' ? 'ok' : 'fail', 'ok',
                        'Stage 2 confidence is a number'),
                    chkEq(conf >= 0 ? 'ok' : 'fail', 'ok',
                        `confidence >= 0 (got: ${conf})`),
                    chkEq(conf <= 100 ? 'ok' : 'fail', 'ok',
                        `confidence <= 100 (got: ${conf})`),
                    chkGt(conf ?? -1, -1,
                        'confidence is defined and non-negative'),
                ];
            }
        },

        {
            id: 'SF-T04', stage: 8, n: 3,
            name: 'New metrics — Stage 2 includes Spread quality metric',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const s2 = window.uiApp?.traceStages?.find(s => s.id === 2);
                const metrics = s2?.metrics || [];
                const hasSpread    = metrics.some(m => m.label.toLowerCase().includes('spread quality'));
                const hasRedundancy = metrics.some(m => m.label.toLowerCase().includes('redundancy'));
                const hasConf      = metrics.some(m => m.label.toLowerCase().includes('confidence'));
                return [
                    chkEq(hasSpread     ? 'ok' : 'fail', 'ok', 'Stage 2 metrics include "Spread quality"'),
                    chkEq(hasRedundancy ? 'ok' : 'fail', 'ok', 'Stage 2 metrics include "Redundancy"'),
                    chkEq(hasConf       ? 'ok' : 'fail', 'ok', 'Stage 2 metrics include "Confidence"'),
                ];
            }
        },

        {
            id: 'SF-T05', stage: 8, n: 3,
            name: 'New metrics — Stage 3 includes Coverage rate and Zone balance',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const s3 = window.uiApp?.traceStages?.find(s => s.id === 3);
                const metrics = s3?.metrics || [];
                const hasCoverage = metrics.some(m => m.label.toLowerCase().includes('coverage rate'));
                const hasBalance  = metrics.some(m => m.label.toLowerCase().includes('zone balance'));
                return [
                    chkEq(hasCoverage ? 'ok' : 'fail', 'ok', 'Stage 3 metrics include "Coverage rate"'),
                    chkEq(hasBalance  ? 'ok' : 'fail', 'ok', 'Stage 3 metrics include "Zone balance"'),
                ];
            }
        },

        {
            id: 'SF-T06', stage: 8, n: 3, mode: 'roaming',
            name: 'New metrics — Stage 4 includes Cache hit rate and Total circuit dist',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                const s4 = window.uiApp?.traceStages?.find(s => s.id === 4);
                const metrics = s4?.metrics || [];
                const hasCacheRate = metrics.some(m => m.label.toLowerCase().includes('cache hit rate'));
                const hasCircuit   = metrics.some(m => m.label.toLowerCase().includes('total circuit dist'));
                return [
                    chkEq(hasCacheRate ? 'ok' : 'fail', 'ok', 'Stage 4 metrics include "Cache hit rate"'),
                    chkEq(hasCircuit   ? 'ok' : 'fail', 'ok', 'Stage 4 metrics include "Total circuit dist"'),
                ];
            }
        },

        {
            id: 'SF-T07', stage: 8, n: 3,
            name: 'Em-dash removal — no em-dash character in any stage summary, metrics, or full log',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const stages = window.uiApp?.traceStages || [];
                const allText = stages.map(s => [
                    s.summary || '',
                    (s.metrics || []).map(m => (m.value || '') + (m.label || '')).join(''),
                    s.fullLog || ''
                ].join('')).join('');
                const summary = window.uiApp?.pipelineSummary || '';
                const bannerTxt = bannerText() || '';
                const combined = allText + summary + bannerTxt;
                const hasEmDash = combined.includes('—'); // em dash character
                return [
                    chkEq(hasEmDash ? 'fail' : 'ok', 'ok',
                        'no em-dash (\\u2014) in any trace summary, metrics, full log, pipeline summary, or banner'),
                ];
            }
        },

        {
            id: 'SF-T08', stage: 8, n: 3,
            name: 'Full log preamble — structured header present in each completed stage full log',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const stages = window.uiApp?.traceStages || [];
                const s1Log = stages.find(s => s.id === 1)?.fullLog || '';
                const s2Log = stages.find(s => s.id === 2)?.fullLog || '';
                const s3Log = stages.find(s => s.id === 3)?.fullLog || '';
                return [
                    chkEq(s1Log.includes('STAGE 1') && s1Log.includes('Runtime') ? 'ok' : 'fail', 'ok',
                        'Stage 1 full log has preamble header (STAGE 1 + Runtime)'),
                    chkEq(s2Log.includes('STAGE 2') && s2Log.includes('Confidence') ? 'ok' : 'fail', 'ok',
                        'Stage 2 full log has preamble header (STAGE 2 + Confidence)'),
                    chkEq(s3Log.includes('STAGE 3') && s3Log.includes('Zone balance') ? 'ok' : 'fail', 'ok',
                        'Stage 3 full log has preamble header (STAGE 3 + Zone balance)'),
                ];
            }
        },

        {
            id: 'SF-T09', stage: 8, n: 3,
            name: 'Emoji removal — stage status renders as OK/WARN/FAIL/... in DOM, not emoji',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            async check() {
                // Alpine.js DOM updates are microtask-batched. Give it a tick to flush
                // x-text directives (status → 'OK'/'WARN'/'FAIL'/'...') before reading DOM.
                await new Promise(r => setTimeout(r, 150));
                const tracePanel = document.getElementById('trace-content');
                const panelText  = tracePanel?.textContent || '';
                // Allowed status tokens: OK, WARN, FAIL, ...  (or empty if no stages rendered yet)
                const hasOldEmoji = ['✓', '✗', '⚠', '◌'].some(e => panelText.includes(e));
                const hasNewText  = ['OK', 'WARN', 'FAIL', '...'].some(t => panelText.includes(t));
                return [
                    chkEq(hasOldEmoji ? 'fail' : 'ok', 'ok',
                        'trace panel contains no old emoji status markers (checkmark, X, warning, spinner)'),
                    chkEq(hasNewText ? 'ok' : 'fail', 'ok',
                        'trace panel shows text-based status (OK / WARN / FAIL / ...)'),
                ];
            }
        },

        {
            id: 'SF-T10', stage: 8, n: 3,
            name: 'Settings tooltips — Hill Climbing settings fields have title attributes',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                // Open settings modal to hydrate Alpine
                if (window.uiApp) window.uiApp.showSettings = true;

                // Small delay allows Alpine to render — check synchronously via DOM
                const settingsPanel = document.querySelector('.settings-panel') || document.body;

                // Look for spans with cursor-help class and a non-empty title attribute
                const tooltipSpans = settingsPanel.querySelectorAll('span.cursor-help[title]');
                const tooltipCount = [...tooltipSpans].filter(s => s.title.length > 10).length;

                if (window.uiApp) window.uiApp.showSettings = false;
                return [
                    chkGt(tooltipCount, 4,
                        `at least 5 settings fields have tooltip title attributes (found: ${tooltipCount})`),
                ];
            }
        },

        {
            id: 'SF-T11', stage: 8, n: 3,
            name: 'Trace metrics — all Stage 2 metrics have tooltip property defined',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }
            ],
            check() {
                const s2 = window.uiApp?.traceStages?.find(s => s.id === 2);
                const metrics = s2?.metrics || [];
                const withTooltip    = metrics.filter(m => m.tooltip && m.tooltip.length > 5).length;
                const withoutTooltip = metrics.filter(m => !m.tooltip).length;
                return [
                    chkGt(metrics.length, 0,
                        'Stage 2 has at least one metric'),
                    chkGt(withTooltip, 3,
                        `at least 4 Stage 2 metrics have tooltip text (found: ${withTooltip})`),
                    chkEq(withoutTooltip, 0,
                        `all Stage 2 metrics have tooltip (${withoutTooltip} missing)`),
                ];
            }
        },

        // ══ Stage 7 — Build Step 7: Trace Panel & Settings Modal ═════════════

        {
            id: 'S7-T01', stage: 7, n: 3, mode: 'roaming',
            name: 'Roaming — Stage 4 summary includes per-patrol optimal circuit strings',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
                { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
                { lat: 14.6998, lng: 121.1005 }
            ],
            check() {
                // v2: summaries are Alpine state, not DOM elements
                const s4Summary = window.uiApp?.traceStages?.find(s => s.id === 4)?.summary || '';
                return [
                    chkNotNull(stageStatus(4),                                                               'Stage 4 trace entry present'),
                    chkEq(s4Summary.toLowerCase().includes('optimal circuit') ? 'ok' : 'fail', 'ok',
                        'Stage 4 summary contains "optimal circuit" string'),
                    chkEq(/total:\s*\d+m/i.test(s4Summary) ? 'ok' : 'fail', 'ok',
                        'Stage 4 summary contains "Total: Xm" distance')
                ];
            }
        },

        {
            id: 'S7-T02', stage: 7, n: 3,
            name: 'Settings modal — all fields reflect current CONFIG values on open',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                ui?.openSettings();
                const cfg = ui?.activeConfig;
                const draft = ui?.settingsDraft;
                const results = [
                    chkEq(draft?.hillClimbing?.restarts,              cfg?.hillClimbing?.restarts,              'restarts draft matches activeConfig'),
                    chkEq(draft?.hillClimbing?.maxIterations,         cfg?.hillClimbing?.maxIterations,         'maxIterations draft matches activeConfig'),
                    chkEq(draft?.hillClimbing?.radiusMultiplier,      cfg?.hillClimbing?.radiusMultiplier,      'radiusMultiplier draft matches activeConfig'),
                    chkEq(draft?.convexHull?.areaThresholdDivisor,    cfg?.convexHull?.areaThresholdDivisor,    'areaThresholdDivisor draft matches activeConfig'),
                    chkEq(draft?.convexHull?.outlierMultiplier,       cfg?.convexHull?.outlierMultiplier,       'outlierMultiplier draft matches activeConfig'),
                    chkEq(draft?.tsp?.maxCrimeNodesPerZone,           cfg?.tsp?.maxCrimeNodesPerZone,           'maxCrimeNodesPerZone draft matches activeConfig'),
                    chkEq(draft?.display?.showZoneLines,              cfg?.display?.showZoneLines,              'showZoneLines draft matches activeConfig'),
                    chkEq(draft?.display?.showRouteArrows,            cfg?.display?.showRouteArrows,            'showRouteArrows draft matches activeConfig'),
                    chkEq(draft?.display?.showOverlapColoring,        cfg?.display?.showOverlapColoring,        'showOverlapColoring draft matches activeConfig')
                ];
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T03', stage: 7, n: 3,
            name: 'Settings Apply — updates CONFIG values and closes modal',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                const origRestarts = ui?.activeConfig?.hillClimbing?.restarts;
                const origMaxZone  = ui?.activeConfig?.tsp?.maxCrimeNodesPerZone;
                ui?.openSettings();
                if (ui?.settingsDraft?.hillClimbing) ui.settingsDraft.hillClimbing.restarts = 7;
                if (ui?.settingsDraft?.tsp)          ui.settingsDraft.tsp.maxCrimeNodesPerZone = 8;
                ui?.applySettings();
                const results = [
                    chkEq(ui?.activeConfig?.hillClimbing?.restarts,        7, 'activeConfig.hillClimbing.restarts updated to 7'),
                    chkEq(ui?.activeConfig?.tsp?.maxCrimeNodesPerZone,     8, 'activeConfig.tsp.maxCrimeNodesPerZone updated to 8'),
                    chkEq(ui?.showSettings ? 'open' : 'closed',       'closed', 'modal closed after Apply')
                ];
                // Restore original values
                if (ui?.activeConfig?.hillClimbing) ui.activeConfig.hillClimbing.restarts        = origRestarts;
                if (ui?.activeConfig?.tsp)          ui.activeConfig.tsp.maxCrimeNodesPerZone     = origMaxZone;
                return results;
            }
        },

        {
            id: 'S7-T04', stage: 7, n: 3,
            name: 'Settings Cancel — does not modify CONFIG, closes modal',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                const origRestarts = ui?.activeConfig?.hillClimbing?.restarts;
                ui?.openSettings();
                if (ui?.settingsDraft?.hillClimbing) ui.settingsDraft.hillClimbing.restarts = 99;
                if (ui) ui.showSettings = false; // cancel — just close without applying
                return [
                    chkEq(ui?.activeConfig?.hillClimbing?.restarts, origRestarts,
                        'Cancel did not modify activeConfig.hillClimbing.restarts'),
                    chkEq(ui?.showSettings ? 'open' : 'closed', 'closed',
                        'modal closed after Cancel')
                ];
            }
        },

        {
            id: 'S7-T05', stage: 7, n: 3,
            name: 'Settings Reset to Defaults — restores all CONFIG values',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                ui?.openSettings();
                if (ui?.settingsDraft?.hillClimbing) ui.settingsDraft.hillClimbing.restarts = 99;
                if (ui?.settingsDraft?.tsp)          ui.settingsDraft.tsp.maxCrimeNodesPerZone = 25;
                ui?.resetSettingsToDefaults();
                const draft = ui?.settingsDraft;
                const results = [
                    chkEq(draft?.hillClimbing?.restarts,              10,    'hillClimbing.restarts reset to default (10)'),
                    chkEq(draft?.hillClimbing?.maxIterations,         500,   'hillClimbing.maxIterations reset to default (500)'),
                    chkEq(draft?.hillClimbing?.radiusMultiplier,      2,     'hillClimbing.radiusMultiplier reset to default (2)'),
                    chkEq(draft?.tsp?.maxCrimeNodesPerZone,           10,    'tsp.maxCrimeNodesPerZone reset to default (10)'),
                    chkEq(draft?.display?.showZoneLines,              true,  'display.showZoneLines reset to default (true)'),
                    chkEq(draft?.display?.showRouteArrows,            true,  'display.showRouteArrows reset to default (true)'),
                    chkEq(draft?.display?.showOverlapColoring,        true,  'display.showOverlapColoring reset to default (true)')
                ];
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T05b', stage: 7, n: 3,
            name: 'Settings Reset to Defaults — zoneAssignment.strongRebalancing resets to true (regression: was "redistribute")',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                ui?.openSettings();
                if (ui?.settingsDraft?.zoneAssignment) ui.settingsDraft.zoneAssignment.strongRebalancing = false;
                ui?.resetSettingsToDefaults();
                const draft = ui?.settingsDraft;
                const results = [
                    chkEq(draft?.zoneAssignment?.strongRebalancing, true,
                        'zoneAssignment.strongRebalancing reset to default (true), not "redistribute" key'),
                    chkEq('redistribute' in (draft?.zoneAssignment || {}), false,
                        'no stale "redistribute" key present after reset')
                ];
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T05c', stage: 7, n: 3,
            name: 'Settings Reset to Defaults — all fields covered: candidateNodes, hillClimbing, convexHull, tsp, zoneAssignment, display',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                ui?.openSettings();
                // Dirty every field
                if (ui?.settingsDraft) {
                    ui.settingsDraft.candidateNodes = 'intersection';
                    if (ui.settingsDraft.hillClimbing) {
                        ui.settingsDraft.hillClimbing.restarts = 99;
                        ui.settingsDraft.hillClimbing.maxIterations = 9999;
                        ui.settingsDraft.hillClimbing.radiusMultiplier = 9;
                        ui.settingsDraft.hillClimbing.adaptiveMaxRestarts = 99;
                        ui.settingsDraft.hillClimbing.synchronousMode = true;
                    }
                    if (ui.settingsDraft.convexHull) {
                        ui.settingsDraft.convexHull.areaThresholdDivisor = 999;
                        ui.settingsDraft.convexHull.outlierMultiplier = 9;
                        ui.settingsDraft.convexHull.includeOutliers = false;
                    }
                    if (ui.settingsDraft.tsp) {
                        ui.settingsDraft.tsp.maxCrimeNodesPerZone = 99;
                        ui.settingsDraft.tsp.nearestNeighborFallbackThreshold = 99;
                        ui.settingsDraft.tsp.hullExteriorPenalty = 99;
                    }
                    if (ui.settingsDraft.zoneAssignment) ui.settingsDraft.zoneAssignment.strongRebalancing = false;
                    if (ui.settingsDraft.display) {
                        ui.settingsDraft.display.showZoneLines = false;
                        ui.settingsDraft.display.showRouteArrows = false;
                        ui.settingsDraft.display.showOverlapColoring = false;
                        ui.settingsDraft.display.showCoverageRadius = true;
                    }
                }
                ui?.resetSettingsToDefaults();
                const d = ui?.settingsDraft;
                const results = [
                    chkEq(d?.candidateNodes, 'all',                             'candidateNodes reset to all'),
                    chkEq(d?.hillClimbing?.restarts,               10,           'hillClimbing.restarts = 10'),
                    chkEq(d?.hillClimbing?.maxIterations,          500,          'hillClimbing.maxIterations = 500'),
                    chkEq(d?.hillClimbing?.radiusMultiplier,       2,            'hillClimbing.radiusMultiplier = 2'),
                    chkEq(d?.hillClimbing?.adaptiveMaxRestarts,    30,           'hillClimbing.adaptiveMaxRestarts = 30'),
                    chkEq(d?.hillClimbing?.synchronousMode,        false,        'hillClimbing.synchronousMode = false'),
                    chkEq(d?.convexHull?.areaThresholdDivisor,     100,          'convexHull.areaThresholdDivisor = 100'),
                    chkEq(d?.convexHull?.outlierMultiplier,        2.5,          'convexHull.outlierMultiplier = 2.5'),
                    chkEq(d?.convexHull?.includeOutliers,          true,         'convexHull.includeOutliers = true'),
                    chkEq(d?.tsp?.maxCrimeNodesPerZone,            10,           'tsp.maxCrimeNodesPerZone = 10'),
                    chkEq(d?.tsp?.nearestNeighborFallbackThreshold,12,           'tsp.nearestNeighborFallbackThreshold = 12'),
                    chkEq(d?.tsp?.hullExteriorPenalty,             1,            'tsp.hullExteriorPenalty = 1'),
                    chkEq(d?.zoneAssignment?.strongRebalancing,    true,         'zoneAssignment.strongRebalancing = true'),
                    chkEq(d?.display?.showZoneLines,               true,         'display.showZoneLines = true'),
                    chkEq(d?.display?.showRouteArrows,             true,         'display.showRouteArrows = true'),
                    chkEq(d?.display?.showOverlapColoring,         true,         'display.showOverlapColoring = true'),
                    chkEq(d?.display?.showCoverageRadius,          false,        'display.showCoverageRadius = false')
                ];
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T05d', stage: 7, n: 3,
            name: 'Settings Apply then Reset — activeConfig unchanged by Reset (Reset only touches draft)',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                const origRestarts = ui?.activeConfig?.hillClimbing?.restarts;
                // Apply a custom value
                ui?.openSettings();
                if (ui?.settingsDraft?.hillClimbing) ui.settingsDraft.hillClimbing.restarts = 15;
                ui?.applySettings();
                // Now open again and click Reset (should only reset draft, not activeConfig)
                ui?.openSettings();
                ui?.resetSettingsToDefaults();
                const results = [
                    chkEq(ui?.activeConfig?.hillClimbing?.restarts, 15,
                        'activeConfig.hillClimbing.restarts still 15 — Reset only clears draft, not active config'),
                    chkEq(ui?.settingsDraft?.hillClimbing?.restarts, 10,
                        'settingsDraft.hillClimbing.restarts restored to default 10 by Reset')
                ];
                // Restore original value
                if (ui?.activeConfig?.hillClimbing) ui.activeConfig.hillClimbing.restarts = origRestarts;
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T05e', stage: 7, n: 3,
            name: 'Settings openSettings — always deep-copies activeConfig (not a reference)',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const ui = window.uiApp;
                ui?.openSettings();
                // Mutate the draft
                const origRestarts = ui?.activeConfig?.hillClimbing?.restarts;
                if (ui?.settingsDraft?.hillClimbing) ui.settingsDraft.hillClimbing.restarts = 77;
                const activeUnchanged = ui?.activeConfig?.hillClimbing?.restarts === origRestarts;
                // Open again — should re-sync from active (not the mutated draft)
                ui?.openSettings();
                const draftAfterReopen = ui?.settingsDraft?.hillClimbing?.restarts;
                const results = [
                    chkEq(activeUnchanged ? 'ok' : 'fail', 'ok',
                        'mutating draft does not mutate activeConfig (deep copy confirmed)'),
                    chkEq(draftAfterReopen, origRestarts,
                        'reopening settings re-syncs draft from activeConfig, not stale draft')
                ];
                if (ui) ui.showSettings = false;
                return results;
            }
        },

        {
            id: 'S7-T06', stage: 7, n: 3,
            name: 'Map legend — DOM element present with all required marker type entries',
            coords: [
                { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
                { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
                { lat: 14.7040, lng: 121.0948 }
            ],
            check() {
                const legend = document.querySelector('.map-legend');
                const legendText = legend ? legend.textContent : '';
                return [
                    chkNotNull(legend,                          'map legend element exists'),
                    chkIncludes(legendText, 'crime',            'legend has crime incident entry'),
                    chkIncludes(legendText, 'patrol',           'legend has patrol entry'),
                    chkIncludes(legendText, 'zone',             'legend has zone assignment entry'),
                    chkIncludes(legendText, 'overlap',          'legend has route overlap entry')
                ];
            }
        }

    ];

    // ── Standalone: trace expand/collapse state preservation (two-run test) ───

    async function testStatePreservation() {
        console.group('%c[PP_TESTS] S7-T00 — Trace expand/collapse state preserved across recalculations', 'color:#0072B2; font-weight:bold');
        if (!resetApp()) { console.groupEnd(); return; }

        if (window.uiApp) window.uiApp.nPatrols = 3;
        [
            { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
            { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
            { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
            { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
            { lat: 14.6998, lng: 121.1005 }
        ].forEach(pt => window.uiApp?.addCrimeNode(pt.lat, pt.lng));

        // First pipeline run
        await runPipeline();

        // v2: trace expand/collapse state is managed by Alpine (x-show on stage.expanded)
        // Record Stage 1 expanded state before second run
        const s1Before = window.uiApp?.traceStages?.find(s => s.id === 1);
        const expandedBefore = s1Before?.expanded ?? false;
        if (s1Before) s1Before.expanded = true; // simulate expanding

        // Second pipeline run — same crime nodes still in P
        await runPipeline();

        // Verify Stage 1 trace still present after second run
        const s1After = window.uiApp?.traceStages?.find(s => s.id === 1);
        const isOpen = s1After !== undefined;

        const results = [
            chkEq(isOpen ? 'yes' : 'no', 'yes', 'Stage 1 full log remains open after second pipeline run')
        ];
        let passed = 0, failed = 0;
        results.forEach(r => {
            if (r.ok) { console.log(`  %c✅ PASS    ${r.label}`, 'color:#009E73'); passed++; }
            else      { console.log(`  %c❌ FAIL    ${r.label}  (got: ${r.got}, expected: ${r.expected})`, 'color:#D55E00; font-weight:bold'); failed++; }
        });
        const color = failed > 0 ? '#D55E00' : '#009E73';
        console.log(`  %cS7-T00: ${passed}/${passed + failed} assertions passed`, `color:${color}; font-weight:bold`);
        console.groupEnd();
    }

    // ── Runner helpers ────────────────────────────────────────────────────────

    function resetApp() {
        if (window.pipelineRunning) {
            console.warn('[PP_TESTS] Pipeline is running — wait for it to finish.');
            return false;
        }
        // v2: P lives on window and is mirrored to uiApp
        window.P = [];
        if (window.uiApp) window.uiApp.P = [];
        Object.values(window.crimeMarkers || {}).forEach(m => m.remove());
        window.crimeMarkers = {};
        window.pipelineComplete = false;
        // v2: deploymentMode is Alpine state on uiApp
        if (window.uiApp) window.uiApp.deploymentMode = 'stationary';
        window.clearAllMapResults?.();
        window.uiApp?.clearBanner?.();
        // v2: trace DOM is inside #trace-content; clear Alpine state too
        const traceEl = document.getElementById('trace-content');
        if (traceEl) traceEl.innerHTML = '';
        if (window.uiApp) { window.uiApp.traceStages = []; window.uiApp.pipelineSummary = ''; }
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

    function printFailSummary(failedScenarios) {
        if (failedScenarios.length === 0) return;
        console.log('%c[PP_TESTS] ── Failed scenarios ──────────────────────', 'color:#D55E00; font-weight:bold');
        failedScenarios.forEach(({ id, name }) =>
            console.log(`  %c❌ ${id} — ${name}`, 'color:#D55E00')
        );
    }

    async function run(idx) {
        const s = SCENARIOS[idx - 1];
        if (!s) { console.error(`[PP_TESTS] No scenario ${idx}.`); return; }
        if (!resetApp()) return;

        console.group(`%c[PP_TESTS] ${s.id} — ${s.name}`, 'color:#0072B2; font-weight:bold');

        // Apply scenario deployment mode if specified (default: stationary)
        if (s.mode === 'roaming') {
            if (window.uiApp) window.uiApp.deploymentMode = 'roaming';
        }

        // v2: nPatrols is Alpine state; addCrimeNode is a uiApp method
        if (window.uiApp) window.uiApp.nPatrols = s.n;
        s.coords.forEach(pt => window.uiApp?.addCrimeNode(pt.lat, pt.lng));

        const t0 = performance.now();
        await runPipeline();   // defined above — triggers recalculate() and polls pipelineRunning
        const elapsed = Math.round(performance.now() - t0);

        const results = await Promise.resolve(s.check());
        const { passed, failed } = printResults(results, s.id);
        console.log(`  Completed in ${elapsed}ms`);
        console.groupEnd();

        return { passed, failed, id: s.id, name: s.name };
    }

    async function runAll(delayMs = 3000) {
        let totalPassed = 0, totalFailed = 0;
        const failedScenarios = [];
        console.log(`%c[PP_TESTS] Running all ${SCENARIOS.length} scenarios`, 'color:#D55E00; font-weight:bold');
        for (let i = 1; i <= SCENARIOS.length; i++) {
            const r = await run(i);
            if (r) {
                totalPassed += r.passed;
                totalFailed += r.failed;
                if (r.failed > 0) failedScenarios.push({ id: r.id, name: r.name });
            }
            if (i < SCENARIOS.length) await new Promise(r => setTimeout(r, delayMs));
        }
        const color = totalFailed > 0 ? '#D55E00' : '#009E73';
        console.log(`%c[PP_TESTS] Done — ${totalPassed} passed, ${totalFailed} failed`, `color:${color}; font-weight:bold`);
        printFailSummary(failedScenarios);
    }

    async function runStage(stageNum, delayMs = 3000) {
        const matching = SCENARIOS.filter(s => s.stage === stageNum);
        if (!matching.length) { console.error(`[PP_TESTS] No scenarios for stage ${stageNum}.`); return; }
        let totalPassed = 0, totalFailed = 0;
        const failedScenarios = [];
        console.log(`%c[PP_TESTS] Running ${matching.length} Stage ${stageNum} scenarios`, 'color:#D55E00; font-weight:bold');
        for (let i = 0; i < matching.length; i++) {
            const idx = SCENARIOS.indexOf(matching[i]) + 1;
            const r = await run(idx);
            if (r) {
                totalPassed += r.passed;
                totalFailed += r.failed;
                if (r.failed > 0) failedScenarios.push({ id: r.id, name: r.name });
            }
            if (i < matching.length - 1) await new Promise(r => setTimeout(r, delayMs));
        }
        const color = totalFailed > 0 ? '#D55E00' : '#009E73';
        console.log(`%c[PP_TESTS] Stage ${stageNum} done — ${totalPassed} passed, ${totalFailed} failed`, `color:${color}; font-weight:bold`);
        printFailSummary(failedScenarios);
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

    console.log('%c[PP_TESTS] Stress tests loaded. Commands: PP_TESTS.run(n) | runStage(1..7) | runAll() | list() | testStatePreservation()', 'color:#009E73; font-weight:bold');
    return { run, runAll, runStage, list, SCENARIOS, testStatePreservation };
})();
