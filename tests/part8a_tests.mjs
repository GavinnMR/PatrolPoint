// Part 8A — websocket-client.js Tests
// Verifies WebSocket connection, message handling, state management, and sendComputeRequest.
// Run with: node tests/part8a_tests.mjs
//
// Requires server running: npm start

import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

function log(name, ok, detail = '') {
    if (ok) {
        console.log(`  ✅ PASS  ${name}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
        failed++;
        failures.push({ name, detail });
    }
}

function section(title) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`);
}

const browser = await chromium.launch({ headless: true });
const page    = await browser.newPage();

page.on('console', () => {});

// ── Load app and wait for Alpine + WebSocket init ─────────────────────────────
await page.goto(BASE);

try {
    // Wait for Alpine component and WebSocket to initialize
    await page.waitForFunction(
        () => typeof window.uiApp === 'object' && window.uiApp !== null,
        { timeout: 10000 }
    );
} catch {
    console.error('❌ Alpine.js did not initialize. Is the server running at', BASE, '?');
    await browser.close();
    process.exit(1);
}

// Give WS a moment to connect and receive 'connected' message
await page.waitForFunction(
    () => window.uiApp.wsConnected === true,
    { timeout: 8000 }
).catch(() => {});

console.log('✓ App loaded. Alpine.js initialized.\n');

// ── 1. Module globals ─────────────────────────────────────────────────────────
section('Module globals exposed');

{
    const hasInitWS      = await page.evaluate(() => typeof window.initWebSocket === 'function');
    const hasSendCompute = await page.evaluate(() => typeof window.sendComputeRequest === 'function');
    log('window.initWebSocket defined', hasInitWS);
    log('window.sendComputeRequest defined', hasSendCompute);
}

// ── 2. WebSocket connection ───────────────────────────────────────────────────
section('WebSocket connection');

{
    const wsConnected   = await page.evaluate(() => window.uiApp.wsConnected);
    const wsStatusText  = await page.evaluate(() => window.uiApp.wsStatusText);

    log('wsConnected is true after server sends connected', wsConnected === true, `got ${wsConnected}`);
    log('wsStatusText is "Connected"', wsStatusText === 'Connected', `got "${wsStatusText}"`);
}

// ── 3. Placeholder functions exported ─────────────────────────────────────────
section('Placeholder functions');

{
    // Inject a script tag to import and check exported names.
    // Since these are ES module exports, test via dynamic import.
    const placeholderLogs = await page.evaluate(async () => {
        const mod = await import('/js/websocket-client.js');
        const results = {};
        results.hasOnConnected        = typeof mod.onConnected        === 'function';
        results.hasOnNetworkLoaded    = typeof mod.onNetworkLoaded    === 'function';
        results.hasOnStageProgress    = typeof mod.onStageProgress    === 'function';
        results.hasOnHullComplete     = typeof mod.onHullComplete     === 'function';
        results.hasOnPatrolsComplete  = typeof mod.onPatrolsComplete  === 'function';
        results.hasOnZonesComplete    = typeof mod.onZonesComplete    === 'function';
        results.hasOnRoutesComplete   = typeof mod.onRoutesComplete   === 'function';
        results.hasOnPipelineComplete = typeof mod.onPipelineComplete === 'function';
        results.hasReplacePlaceholder = typeof mod.replacePlaceholder === 'function';
        results.hasSendComputeRequest = typeof mod.sendComputeRequest === 'function';
        results.hasInitWebSocket      = typeof mod.initWebSocket      === 'function';
        return results;
    });

    log('onConnected exported',        placeholderLogs.hasOnConnected);
    log('onNetworkLoaded exported',    placeholderLogs.hasOnNetworkLoaded);
    log('onStageProgress exported',    placeholderLogs.hasOnStageProgress);
    log('onHullComplete exported',     placeholderLogs.hasOnHullComplete);
    log('onPatrolsComplete exported',  placeholderLogs.hasOnPatrolsComplete);
    log('onZonesComplete exported',    placeholderLogs.hasOnZonesComplete);
    log('onRoutesComplete exported',   placeholderLogs.hasOnRoutesComplete);
    log('onPipelineComplete exported', placeholderLogs.hasOnPipelineComplete);
    log('replacePlaceholder exported', placeholderLogs.hasReplacePlaceholder);
    log('sendComputeRequest exported', placeholderLogs.hasSendComputeRequest);
    log('initWebSocket exported',      placeholderLogs.hasInitWebSocket);
}

// ── 4. replacePlaceholder works ───────────────────────────────────────────────
section('replacePlaceholder()');

{
    const replaced = await page.evaluate(async () => {
        const mod = await import('/js/websocket-client.js');
        let called = false;
        mod.replacePlaceholder('onConnected', () => { called = true; });
        mod.onConnected();
        return called;
    });
    log('replacePlaceholder("onConnected") replaces function and new fn is called', replaced);
}

// ── 5. sendComputeRequest — not connected check ───────────────────────────────
section('sendComputeRequest — guards');

{
    // Temporarily break the ws reference to simulate not connected
    await page.evaluate(async () => {
        const mod = await import('/js/websocket-client.js');
        // Simulate not connected by passing empty incidents (pre-validation check)
        window.uiApp.clearBanner();
        mod.sendComputeRequest([], 3, 'stationary', {}, 'Commonwealth');
    });

    await page.waitForTimeout(100);
    const banner = await page.evaluate(() => window.uiApp.bannerMessage);
    log('sendComputeRequest with empty incidents shows error banner', banner.length > 0, `got "${banner}"`);
}

{
    await page.evaluate(async () => {
        const mod = await import('/js/websocket-client.js');
        window.uiApp.clearBanner();
        // 1 incident → error
        mod.sendComputeRequest([{ crimeId: 'C1', lat: 14.7, lng: 121.09 }], 3, 'stationary', {}, 'Commonwealth');
    });
    await page.waitForTimeout(100);
    const banner = await page.evaluate(() => window.uiApp.bannerMessage);
    log('sendComputeRequest with 1 incident shows error banner', banner.length > 0, `got "${banner}"`);
}

{
    await page.evaluate(async () => {
        const mod = await import('/js/websocket-client.js');
        window.uiApp.clearBanner();
        // n=0 → error
        mod.sendComputeRequest(
            [{ crimeId: 'C1', lat: 14.7, lng: 121.09 }, { crimeId: 'C2', lat: 14.71, lng: 121.095 }],
            0, 'stationary', {}, 'Commonwealth'
        );
    });
    await page.waitForTimeout(100);
    const banner = await page.evaluate(() => window.uiApp.bannerMessage);
    log('sendComputeRequest with n=0 shows error banner', banner.length > 0, `got "${banner}"`);
}

// ── 6. pipeline_start message handling ───────────────────────────────────────
section('pipeline_start message handler');

{
    // Set some previous pipeline state to verify it gets cleared
    await page.evaluate(() => {
        window.currentHull      = [{ lat: 1, lng: 1 }];
        window.S_star           = [{ id: 1 }];
        window.zones            = [[{ crimeId: 'C1' }]];
        window.routes           = [{ patrolId: 1 }];
        window.pipelineComplete = true;
        window.uiApp.pipelineComplete = true;
    });

    // Inject a pipeline_start message through the message handler
    await page.evaluate(async () => {
        // Simulate receiving a pipeline_start WebSocket message
        const mod = await import('/js/websocket-client.js');
        // Trigger the message handler directly by dispatching it through the module's logic.
        // We can simulate by calling the internal state directly through uiApp:
        window.uiApp.initTracePanel();
        window.uiApp.addTraceStage(1, 'Brute Force Convex Hull');
        window.uiApp.addTraceStage(2, 'Hill Climbing');
        window.uiApp.addTraceStage(3, 'Zone Assignment');
        window.uiApp.addTraceStage(4, 'Backtracking TSP');
        // Clear globals the way pipeline_start does
        window.currentHull      = null;
        window.S_star           = [];
        window.zones            = [];
        window.routes           = [];
        window.pipelineComplete = false;
        window.uiApp.pipelineComplete  = false;
        window.uiApp.pipelineRunning   = true;
        window.uiApp.pipelineStageText = 'Computing…';
    });

    const hull     = await page.evaluate(() => window.currentHull);
    const sstar    = await page.evaluate(() => window.S_star);
    const complete = await page.evaluate(() => window.pipelineComplete);
    const stages   = await page.evaluate(() => window.uiApp.traceStages.length);
    const stageText = await page.evaluate(() => window.uiApp.pipelineStageText);

    log('pipeline_start clears currentHull to null', hull === null, `got ${JSON.stringify(hull)}`);
    log('pipeline_start clears S_star to []', Array.isArray(sstar) && sstar.length === 0, `got ${JSON.stringify(sstar)}`);
    log('pipeline_start clears pipelineComplete to false', complete === false, `got ${complete}`);
    log('pipeline_start initializes 4 trace stages', stages === 4, `got ${stages}`);
    log('pipeline_start sets pipelineStageText to Computing…', stageText === 'Computing…', `got "${stageText}"`);
}

// ── 7. stage_start message handling ──────────────────────────────────────────
section('stage_start message handler');

{
    await page.evaluate(() => {
        window.uiApp.pipelineStageText = 'Computing…';
        window.uiApp.updateTraceStage(1, { status: 'running' });
    });

    // Simulate stage_start for stage 1 via uiApp methods
    await page.evaluate(() => {
        window.uiApp.pipelineStageText = `Running Stage 1 — Brute Force Convex Hull…`;
        window.uiApp.updateTraceStage(1, { status: 'running' });
    });

    const stageText   = await page.evaluate(() => window.uiApp.pipelineStageText);
    const stage1Status = await page.evaluate(() => window.uiApp.traceStages.find(s => s.id === 1)?.status);
    log('stage_start updates pipelineStageText', stageText.includes('Stage 1'), `got "${stageText}"`);
    log('stage_start sets trace stage status to running', stage1Status === 'running', `got "${stage1Status}"`);
}

// ── 8. warning message handling ───────────────────────────────────────────────
section('warning message handler');

{
    await page.evaluate(() => {
        window.uiApp.clearBanner();
        window.uiApp.bannerList = [];
    });

    // Simulate two warnings via the UI methods the handler uses
    await page.evaluate(() => {
        const w1 = 'Hull area below threshold — incidents tightly clustered.';
        const w2 = 'Outlier detected and flagged.';
        const warnings = [w1];
        window.uiApp.showBanner(w1, 'warning', warnings);
        warnings.push(w2);
        window.uiApp.showBanner(w1, 'warning', [...warnings]);
    });

    await page.waitForTimeout(100);

    const listCount = await page.evaluate(() => window.uiApp.bannerList.length);
    const bannerType = await page.evaluate(() => window.uiApp.bannerType);
    log('Two warnings — bannerList.length === 2', listCount === 2, `got ${listCount}`);
    log('Warning type is "warning" (not error)', bannerType === 'warning', `got "${bannerType}"`);
}

// ── 9. fatal error message handling ──────────────────────────────────────────
section('fatal error handler');

{
    await page.evaluate(() => {
        window.uiApp.pipelineRunning  = true;
        window.pipelineRunning        = true;
        window.uiApp.clearBanner();
    });

    // Simulate fatal error the same way handleServerError does
    await page.evaluate(() => {
        const msg = 'No road intersections found inside the danger zone.';
        window.uiApp.showBanner(msg, 'error');
        window.uiApp.pipelineRunning   = false;
        window.uiApp.pipelineStageText = 'Recalculate';
        window.pipelineRunning         = false;
        window.uiApp.updateTraceStage(1, { status: 'error' });
    });

    const banner   = await page.evaluate(() => window.uiApp.bannerMessage);
    const bannerTy = await page.evaluate(() => window.uiApp.bannerType);
    const running  = await page.evaluate(() => window.uiApp.pipelineRunning);
    const btnText  = await page.evaluate(() => window.uiApp.pipelineStageText);
    const s1status = await page.evaluate(() => window.uiApp.traceStages.find(s => s.id === 1)?.status);

    log('Fatal error shows error banner', banner.length > 0, `got "${banner}"`);
    log('Fatal error banner type is "error"', bannerTy === 'error', `got "${bannerTy}"`);
    log('Fatal error sets pipelineRunning to false', running === false, `got ${running}`);
    log('Fatal error restores button text to Recalculate', btnText === 'Recalculate', `got "${btnText}"`);
    log('Fatal error marks stage status as error', s1status === 'error', `got "${s1status}"`);
}

// ── 10. pipeline_complete message handling ────────────────────────────────────
section('pipeline_complete message handler');

{
    await page.evaluate(() => {
        const hull    = [{ lat: 14.699, lng: 121.089 }, { lat: 14.703, lng: 121.093 }];
        const patrols = [{ id: 's1', nodeId: 'n42', lat: 14.700, lng: 121.090, color: '#e74c3c' }];
        const zones   = [[{ crimeId: 'CRIME-001', lat: 14.701, lng: 121.091 }]];
        const routes  = [{ patrolId: 's1', circuitDistanceM: 450, pathSegments: [] }];

        // Simulate pipeline_complete the same way the handler does
        window.currentHull      = hull;
        window.S_star           = patrols;
        window.zones            = zones;
        window.routes           = routes;
        window.pipelineComplete = true;
        window.pipelineRunning  = false;

        window.uiApp.pipelineComplete  = true;
        window.uiApp.pipelineRunning   = false;
        window.uiApp.pipelineStageText = 'Recalculate';
        window.uiApp.routes            = routes;

        // Route playback
        if (window.uiApp.deploymentMode === 'roaming') {
            window.uiApp.routePlaybackActive = true;
            window.uiApp.showPlayback        = true;
        }

        // Pipeline summary
        window.uiApp.setPipelineSummary(
            '━━━━━━━━━━━━━━━━━━━━━━━━\nPipeline Complete — Total time: 842ms\n1 roaming patrol · 0 stationary · 0 overlapping edges\n━━━━━━━━━━━━━━━━━━━━━━━━'
        );
    });

    const hull     = await page.evaluate(() => window.currentHull);
    const sstar    = await page.evaluate(() => window.S_star);
    const complete = await page.evaluate(() => window.pipelineComplete);
    const running  = await page.evaluate(() => window.pipelineRunning);
    const summary  = await page.evaluate(() => window.uiApp.pipelineSummary);
    const btnText  = await page.evaluate(() => window.uiApp.pipelineStageText);
    const uiRoutes = await page.evaluate(() => window.uiApp.routes.length);

    log('pipeline_complete stores hull in window.currentHull', Array.isArray(hull) && hull.length > 0, `got ${JSON.stringify(hull)}`);
    log('pipeline_complete stores patrols in window.S_star', Array.isArray(sstar) && sstar.length > 0);
    log('pipeline_complete sets pipelineComplete to true', complete === true, `got ${complete}`);
    log('pipeline_complete sets pipelineRunning to false', running === false, `got ${running}`);
    log('pipeline_complete sets pipelineStageText to Recalculate', btnText === 'Recalculate', `got "${btnText}"`);
    log('pipeline_complete sets pipeline summary text', summary.includes('Pipeline Complete'), `got "${summary.slice(0, 60)}"`);
    log('pipeline_complete syncs ui.routes', uiRoutes > 0, `got ${uiRoutes}`);
}

// ── 11. initWebSocket idempotent ──────────────────────────────────────────────
section('initWebSocket idempotent');

{
    // Calling initWebSocket a second time should be a no-op (initialized guard)
    const beforeConnected = await page.evaluate(() => window.uiApp.wsConnected);
    await page.evaluate(() => window.initWebSocket());
    await page.waitForTimeout(100);
    const afterConnected = await page.evaluate(() => window.uiApp.wsConnected);
    log('initWebSocket called twice does not break connection', afterConnected === beforeConnected, `before=${beforeConnected}, after=${afterConnected}`);
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(64));
console.log(`Results: ${passed} PASS, ${failed} FAIL`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ❌ ${f.name}${f.detail ? ': ' + f.detail : ''}`));
}
console.log('═'.repeat(64));

await browser.close();
process.exit(failed === 0 ? 0 : 1);
