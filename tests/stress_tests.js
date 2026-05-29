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

    function stageStatus(n) {
        const els = document.querySelectorAll('#trace-stages .trace-stage .trace-status');
        return els[n - 1] ? els[n - 1].textContent.trim() : null;
    }

    function bannerType() {
        const el = document.getElementById('warning-banner');
        if (el.style.display === 'none' || !el.style.display) return 'none';
        return el.className || 'none'; // 'warning' | 'error' | 'none'
    }

    function bannerText() {
        return document.getElementById('warning-banner').textContent.trim();
    }

    function stage1Status() { return stageStatus(1); }

    function outlierMarkerCount() {
        return crimeMarkers.filter(m => {
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
                chkEq(patrolMarkers.length, 0,                      'no patrol markers placed'),
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
                chkEq(patrolMarkers.length, 0,              'no patrol markers placed'),
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
                chkEq(patrolMarkers.length, 0,                      'no patrol markers placed'),
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
                chkEq(nearestHighlightMarkers.length, 5,             '5 nearest intersection highlights on map'),
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
                chkEq(patrolMarkers.length, 1,              '1 patrol marker placed'),
                chkEq(S_star ? S_star.length : 0, 1,        'S_star has 1 position'),
                chkEq(['none', 'warning'].includes(bannerType()) ? 'ok' : 'fail', 'ok', 'no error banner'),
                chkIncludes(
                    document.querySelector('#trace-stages')?.textContent || '',
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
                chkEq(patrolMarkers.length, 5,              '5 patrol markers placed'),
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
                chkEq(patrolMarkers.length, 10,             '10 patrol markers placed'),
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
                chkEq(patrolMarkers.length, 30,             '30 patrol markers placed'),
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
                chkGt(patrolMarkers.length, 0,              'patrol markers placed'),
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
                    chkEq(patrolMarkers.length, 2,          '2 patrol markers placed'),
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
                    chkEq(patrolMarkers.length, S_star ? S_star.length : -1,
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
                chkEq(patrolMarkers.length, 31,             '31 patrol markers placed — pipeline continued')
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
                    chkEq(patrolMarkers.length, 8,          '8 patrol markers on map'),
                    chkEq(uniqueIds, 8,                     '8 unique node IDs in S_star'),
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
                    chkEq(zoneLines.length, totalAssigned,          'one zone line per assigned node'),
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
                    chkEq(patrolMarkers.length, 10,                 '10 patrol markers on map'),
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
                    chkEq(zones ? zones[0].length : -1, cap,        `zone capped to ${cap} nodes`),
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
                const traceText = document.querySelector('#trace-stages')?.textContent || '';
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
                    chkGt(routePolylines.length, 0,                     'route polylines rendered'),
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
                const traceText = document.querySelector('#trace-stages')?.textContent || '';
                return [
                    chkGt(routePolylines.length, 0,                         'route polylines rendered'),
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
                const cachePopulated = Object.keys(dijkstraCache).length > 0;
                return [
                    chkGt(routePolylines.length, 0,                     'route polylines rendered'),
                    chkEq(cachePopulated ? 'ok' : 'fail', 'ok',         'dijkstraCache populated after TSP run'),
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
                    chkEq(zones ? zones[0].length : -1, cap,            `zone capped to ${cap} nodes`),
                    chkGt(routePolylines.length, 0,                     'TSP routes rendered for capped zone'),
                    chkNotNull(s4,                                       'Stage 4 trace entry present'),
                    chkEq(s4 === '✅' || s4 === '⚠️' ? 'ok' : 'fail', 'ok', 'Stage 4 not error')
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
                const summaries = document.querySelectorAll('#trace-stages .trace-summary');
                const s4Summary = summaries[summaries.length - 1]?.textContent || '';
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
                openSettings();
                const results = [
                    chkEq(parseInt(document.getElementById('cfg-hc-restarts').value),    CONFIG.hillClimbing.restarts,          'restarts field matches CONFIG'),
                    chkEq(parseInt(document.getElementById('cfg-hc-maxiter').value),     CONFIG.hillClimbing.maxIterations,     'maxIterations field matches CONFIG'),
                    chkEq(parseFloat(document.getElementById('cfg-hc-radius').value),    CONFIG.hillClimbing.radiusMultiplier,  'radiusMultiplier field matches CONFIG'),
                    chkEq(parseInt(document.getElementById('cfg-ch-area').value),         CONFIG.convexHull.areaThresholdDivisor,'areaThresholdDivisor field matches CONFIG'),
                    chkEq(parseFloat(document.getElementById('cfg-ch-outlier').value),   CONFIG.convexHull.outlierMultiplier,   'outlierMultiplier field matches CONFIG'),
                    chkEq(parseInt(document.getElementById('cfg-tsp-max').value),         CONFIG.tsp.maxCrimeNodesPerZone,      'maxCrimeNodesPerZone field matches CONFIG'),
                    chkEq(document.getElementById('cfg-show-zone-lines').checked,         CONFIG.display.showZoneLines,         'showZoneLines checkbox matches CONFIG'),
                    chkEq(document.getElementById('cfg-show-arrows').checked,             CONFIG.display.showRouteArrows,       'showRouteArrows checkbox matches CONFIG'),
                    chkEq(document.getElementById('cfg-show-overlap').checked,            CONFIG.display.showOverlapColoring,   'showOverlapColoring checkbox matches CONFIG')
                ];
                closeSettings();
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
                const orig = { restarts: CONFIG.hillClimbing.restarts, maxZone: CONFIG.tsp.maxCrimeNodesPerZone };
                openSettings();
                document.getElementById('cfg-hc-restarts').value = '7';
                document.getElementById('cfg-tsp-max').value = '8';
                document.getElementById('settings-apply').click();
                const results = [
                    chkEq(CONFIG.hillClimbing.restarts,        7,        'CONFIG.hillClimbing.restarts updated to 7'),
                    chkEq(CONFIG.tsp.maxCrimeNodesPerZone,     8,        'CONFIG.tsp.maxCrimeNodesPerZone updated to 8'),
                    chkEq(document.getElementById('settings-modal').classList.contains('open') ? 'open' : 'closed', 'closed',
                        'modal closed after Apply')
                ];
                CONFIG.hillClimbing.restarts    = orig.restarts;
                CONFIG.tsp.maxCrimeNodesPerZone = orig.maxZone;
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
                const origRestarts = CONFIG.hillClimbing.restarts;
                openSettings();
                document.getElementById('cfg-hc-restarts').value = '99';
                document.getElementById('settings-cancel').click();
                return [
                    chkEq(CONFIG.hillClimbing.restarts, origRestarts,
                        'Cancel did not modify CONFIG.hillClimbing.restarts'),
                    chkEq(document.getElementById('settings-modal').classList.contains('open') ? 'open' : 'closed', 'closed',
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
                CONFIG.hillClimbing.restarts     = 99;
                CONFIG.tsp.maxCrimeNodesPerZone  = 25;
                openSettings();
                document.getElementById('settings-reset').click();
                // reset handler calls openSettings() again — modal stays open with defaults populated
                const results = [
                    chkEq(CONFIG.hillClimbing.restarts,          CONFIG_DEFAULTS.hillClimbing.restarts,         'hillClimbing.restarts restored to default'),
                    chkEq(CONFIG.hillClimbing.maxIterations,     CONFIG_DEFAULTS.hillClimbing.maxIterations,    'hillClimbing.maxIterations restored to default'),
                    chkEq(CONFIG.hillClimbing.radiusMultiplier,  CONFIG_DEFAULTS.hillClimbing.radiusMultiplier, 'hillClimbing.radiusMultiplier restored to default'),
                    chkEq(CONFIG.tsp.maxCrimeNodesPerZone,       CONFIG_DEFAULTS.tsp.maxCrimeNodesPerZone,      'tsp.maxCrimeNodesPerZone restored to default'),
                    chkEq(CONFIG.display.showZoneLines,          CONFIG_DEFAULTS.display.showZoneLines,         'display.showZoneLines restored to default'),
                    chkEq(CONFIG.display.showRouteArrows,        CONFIG_DEFAULTS.display.showRouteArrows,       'display.showRouteArrows restored to default'),
                    chkEq(CONFIG.display.showOverlapColoring,    CONFIG_DEFAULTS.display.showOverlapColoring,   'display.showOverlapColoring restored to default')
                ];
                closeSettings();
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

        document.getElementById('patrol-count').value = 3;
        [
            { lat: 14.6960, lng: 121.0855 }, { lat: 14.7120, lng: 121.1042 },
            { lat: 14.7120, lng: 121.0855 }, { lat: 14.6960, lng: 121.1042 },
            { lat: 14.7040, lng: 121.0948 }, { lat: 14.6998, lng: 121.0892 },
            { lat: 14.7082, lng: 121.0892 }, { lat: 14.7082, lng: 121.1005 },
            { lat: 14.6998, lng: 121.1005 }
        ].forEach(pt => addCrimeNode(pt));

        // First pipeline run
        await runPipeline();

        // Expand Stage 1 full log
        const firstLog = document.querySelector('#trace-stages .trace-stage .trace-log');
        if (!firstLog) {
            console.log('%c  ❌ FAIL    No Stage 1 trace log found after first run', 'color:#D55E00; font-weight:bold');
            console.groupEnd();
            return;
        }
        firstLog.classList.add('open');

        // Second pipeline run — same crime nodes still in P
        await runPipeline();

        // Verify Stage 1 log is still open
        const firstLogAfter = document.querySelector('#trace-stages .trace-stage .trace-log');
        const isOpen = firstLogAfter ? firstLogAfter.classList.contains('open') : false;

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
        if (typeof pipelineRunning !== 'undefined' && pipelineRunning) {
            console.warn('[PP_TESTS] Pipeline is running — wait for it to finish.');
            return false;
        }
        P.length = 0;
        crimeMarkers.forEach(m => m.remove());
        crimeMarkers.length = 0;
        lastRemovedPoint = null;
        pipelineResults = false;
        // Reset deployment mode to stationary so tests start from a clean state
        deploymentMode = 'stationary';
        document.querySelectorAll('#mode-toggle input[type=radio]').forEach(r => {
            r.checked = r.value === 'stationary';
        });
        document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('mode-active'));
        const stationaryOption = document.querySelector('.mode-option');
        if (stationaryOption) stationaryOption.classList.add('mode-active');
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
            deploymentMode = 'roaming';
            document.querySelectorAll('#mode-toggle input[type=radio]').forEach(r => {
                r.checked = r.value === 'roaming';
            });
            document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('mode-active'));
            const roamingOption = document.querySelector('.mode-option:last-of-type');
            if (roamingOption) roamingOption.classList.add('mode-active');
        }

        document.getElementById('patrol-count').value = s.n;
        s.coords.forEach(pt => addCrimeNode(pt));

        const t0 = performance.now();
        await runPipeline();
        const elapsed = Math.round(performance.now() - t0);

        const results = s.check();
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
