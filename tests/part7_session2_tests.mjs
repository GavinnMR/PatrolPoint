// Part 7 Session 2 — Interactive Feature Tests
// Tests all ui.js interactive features introduced in Session 2.
// Run with: node tests/part7_session2_tests.mjs
//
// Requires server running: npm start
// Auth/Export tests use Playwright route mocking (no real DB needed).

import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const TEST_USER = 'testuser_p7s2';

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

// ── Setup ─────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Mock auth and export API routes so tests pass without a real DB
// Playwright route patterns must match the full absolute URL — use ** prefix.
await page.route('**/api/auth/register', async route => {
    await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Account created successfully' })
    });
});

await page.route('**/api/auth/login', async route => {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            token: 'fake.jwt.token',
            user: { id: 1, username: TEST_USER, displayName: 'Test User', barangay: 'Commonwealth' }
        })
    });
});

await page.route('**/api/auth/me', async route => {
    await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No token' })
    });
});

await page.route('**/api/sessions**', async route => {
    if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":1}' });
    }
});

// PDF export mock — return minimal valid PDF bytes
await page.route('**/api/export/pdf', async route => {
    const pdfBytes = '%PDF-1.4 mock pdf content for test';
    await route.fulfill({
        status: 200,
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="PatrolPoint-Deployment-Plan.pdf"'
        },
        body: pdfBytes
    });
});

// CSV export mock
await page.route('**/api/export/csv', async route => {
    await route.fulfill({
        status: 200,
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="PatrolPoint-Deployment.csv"'
        },
        body: 'patrolId,lat,lng\n1,14.701,121.091\n'
    });
});

page.on('console', () => {});

await page.goto(BASE);

try {
    await page.waitForFunction(
        () => typeof window.uiApp === 'object' && window.uiApp !== null,
        { timeout: 10000 }
    );
} catch {
    console.error('❌ Alpine.js did not initialize — is the server running at', BASE, '?');
    await browser.close();
    process.exit(1);
}

console.log('✓ App loaded. Alpine.js initialized. API routes mocked.\n');

// ── SETTINGS ─────────────────────────────────────────────────────────────────
section('Settings');

// 1. Change restarts to 20 → Apply → reopen → verify 20
{
    await page.evaluate(() => { window.uiApp.openSettings(); });
    await page.evaluate(() => { window.uiApp.settingsDraft.hillClimbing.restarts = 20; });
    await page.evaluate(() => { window.uiApp.applySettings(); });
    await page.evaluate(() => { window.uiApp.openSettings(); });
    const v = await page.evaluate(() => window.uiApp.settingsDraft.hillClimbing.restarts);
    log('Change restarts 10→20, Apply, reopen — shows 20', v === 20, `got ${v}`);
    await page.evaluate(() => { window.uiApp.showSettings = false; });
}

// 2. Reset to Defaults — verify all values restored in draft
{
    await page.evaluate(() => { window.uiApp.openSettings(); });
    await page.evaluate(() => { window.uiApp.settingsDraft.hillClimbing.restarts = 99; });
    await page.evaluate(() => { window.uiApp.resetSettingsToDefaults(); });
    const r = await page.evaluate(() => window.uiApp.settingsDraft.hillClimbing.restarts);
    const m = await page.evaluate(() => window.uiApp.settingsDraft.hillClimbing.maxIterations);
    const d = await page.evaluate(() => window.uiApp.settingsDraft.convexHull.outlierMultiplier);
    log('Reset to Defaults — restarts back to 10', r === 10, `got ${r}`);
    log('Reset to Defaults — maxIterations back to 500', m === 500, `got ${m}`);
    log('Reset to Defaults — outlierMultiplier back to 2.5', d === 2.5, `got ${d}`);
    await page.evaluate(() => { window.uiApp.showSettings = false; });
}

// 3. Cancel after changing a value — value unchanged on reopen
{
    // activeConfig.restarts is still 20 from test 1
    await page.evaluate(() => { window.uiApp.openSettings(); });
    await page.evaluate(() => { window.uiApp.settingsDraft.hillClimbing.restarts = 55; });
    await page.evaluate(() => { window.uiApp.showSettings = false; }); // Cancel
    await page.evaluate(() => { window.uiApp.openSettings(); });
    const v = await page.evaluate(() => window.uiApp.settingsDraft.hillClimbing.restarts);
    log('Cancel — reopens with activeConfig value (20, unchanged)', v === 20, `got ${v}`);
    await page.evaluate(() => { window.uiApp.showSettings = false; });
}

// Reset activeConfig back to defaults for clean state
await page.evaluate(() => {
    window.uiApp.openSettings();
    window.uiApp.resetSettingsToDefaults();
    window.uiApp.applySettings();
});

// ── UNDO / REDO ───────────────────────────────────────────────────────────────
section('Undo / Redo');

await page.evaluate(() => {
    window.P = []; window.crimeIdCounter = 0;
    window.uiApp.P = [];
    window.uiApp.undoStack = []; window.undoStack = [];
    window.uiApp.redoStack = []; window.redoStack = [];
});

// 4. Add 3 crime nodes — Undo button enables
await page.evaluate(() => {
    window.uiApp.addCrimeNode(14.7000, 121.0900);
    window.uiApp.addCrimeNode(14.7010, 121.0910);
    window.uiApp.addCrimeNode(14.7020, 121.0920);
});
{
    const stackLen = await page.evaluate(() => window.uiApp.undoStack.length);
    const pLen    = await page.evaluate(() => window.uiApp.P.length);
    const undoDisabled = await page.evaluate(() => {
        const btn = document.querySelector('button[\\@click="undo()"]');
        return btn ? btn.disabled : null;
    });
    log('Add 3 nodes — undoStack.length === 3', stackLen === 3, `got ${stackLen}`);
    log('Add 3 nodes — P.length === 3', pLen === 3, `got ${pLen}`);
    log('Undo button enabled after adds', undoDisabled === false, `disabled=${undoDisabled}`);
}

// 5. Ctrl+Z — last node removed
await page.evaluate(() => window.uiApp.undo());
{
    const pLen    = await page.evaluate(() => window.uiApp.P.length);
    const redoLen = await page.evaluate(() => window.uiApp.redoStack.length);
    log('Ctrl+Z — P.length 3→2', pLen === 2, `got ${pLen}`);
    log('Ctrl+Z — redoStack gets 1 entry', redoLen === 1, `got ${redoLen}`);
}

// 6. Ctrl+Z again — second node removed
await page.evaluate(() => window.uiApp.undo());
{
    const pLen = await page.evaluate(() => window.uiApp.P.length);
    log('Second Ctrl+Z — P.length→1', pLen === 1, `got ${pLen}`);
}

// 7. Ctrl+Shift+Z — node restored
await page.evaluate(() => window.uiApp.redo());
{
    const pLen    = await page.evaluate(() => window.uiApp.P.length);
    const redoLen = await page.evaluate(() => window.uiApp.redoStack.length);
    log('Ctrl+Shift+Z — P.length restored to 2', pLen === 2, `got ${pLen}`);
    log('Redo — redoStack decreases to 1', redoLen === 1, `got ${redoLen}`);
}

// 8. Redo button disables after adding a new crime node
await page.evaluate(() => window.uiApp.addCrimeNode(14.7030, 121.0930));
{
    const redoLen = await page.evaluate(() => window.uiApp.redoStack.length);
    const redoDisabled = await page.evaluate(() => {
        const btn = document.querySelector('button[\\@click="redo()"]');
        return btn ? btn.disabled : null;
    });
    log('New add clears redoStack — length 0', redoLen === 0, `got ${redoLen}`);
    log('Redo button disabled after new add', redoDisabled === true, `disabled=${redoDisabled}`);
}

// ── UNIQUE CRIME IDs ──────────────────────────────────────────────────────────
section('Unique Crime IDs');

await page.evaluate(() => {
    window.P = []; window.crimeIdCounter = 0;
    window.uiApp.P = [];
    window.uiApp.undoStack = []; window.undoStack = [];
    window.uiApp.redoStack = []; window.redoStack = [];
});

// 9. First node → CRIME-001
{
    const id = await page.evaluate(() => window.uiApp.addCrimeNode(14.7000, 121.0900));
    log('First addCrimeNode → CRIME-001', id === 'CRIME-001', `got ${id}`);
}
// 10. Second node → CRIME-002
{
    const id = await page.evaluate(() => window.uiApp.addCrimeNode(14.7010, 121.0910));
    log('Second addCrimeNode → CRIME-002', id === 'CRIME-002', `got ${id}`);
}
// 11. Remove CRIME-001, add new → CRIME-003
{
    await page.evaluate(() => window.uiApp.removeCrimeNode('CRIME-001'));
    const id = await page.evaluate(() => window.uiApp.addCrimeNode(14.7020, 121.0920));
    const hasCrime001 = await page.evaluate(() => window.P.some(p => p.crimeId === 'CRIME-001'));
    log('After removing CRIME-001, new node → CRIME-003', id === 'CRIME-003', `got ${id}`);
    log('CRIME-001 no longer in P', !hasCrime001, `found=${hasCrime001}`);
}

// ── BULK IMPORT ───────────────────────────────────────────────────────────────
section('Bulk Import');

await page.evaluate(() => {
    window.P = []; window.crimeIdCounter = 0;
    window.uiApp.P = [];
    window.uiApp.undoStack = []; window.undoStack = [];
    window.uiApp.redoStack = []; window.redoStack = [];
    window.uiApp.importText = '';
    window.uiApp.importMessage = '';
    window.uiApp.clearBanner();
    // Override confirm to auto-accept for all import tests
    window.confirm = () => true;
});

// 12. 3 valid coordinates — P updated, textarea cleared, success message
{
    await page.evaluate(() => window.uiApp.addCrimeNode(14.7000, 121.0900)); // existing = 1
    await page.evaluate(() => {
        window.uiApp.importText = '14.7010, 121.0910\n14.7020, 121.0920\n14.7030, 121.0930';
        window.uiApp.importMessage = '';
    });
    await page.evaluate(() => window.uiApp.importCoordinates());
    const pLen       = await page.evaluate(() => window.uiApp.P.length);
    const importText = await page.evaluate(() => window.uiApp.importText);
    const msg        = await page.evaluate(() => window.uiApp.importMessage);
    log('Bulk import 3 valid — P has 3 points', pLen === 3, `got ${pLen}`);
    log('Bulk import — textarea cleared', importText === '', `got "${importText}"`);
    log('Bulk import — success message shown', msg.includes('3') && msg.includes('imported'), `got "${msg}"`);
}

// 13. 1 invalid + 2 valid → "2 imported, 1 skipped"
{
    await page.evaluate(() => {
        window.P = []; window.crimeIdCounter = 0; window.uiApp.P = [];
        window.uiApp.importText = 'not_valid_line\n14.7010, 121.0910\n14.7020, 121.0920';
        window.uiApp.importMessage = '';
    });
    await page.evaluate(() => window.uiApp.importCoordinates());
    const msg  = await page.evaluate(() => window.uiApp.importMessage);
    const pLen = await page.evaluate(() => window.uiApp.P.length);
    log('Mixed import — 2 points in P', pLen === 2, `got ${pLen}`);
    log('Mixed import — reports 2 imported + 1 skipped', msg.includes('2') && msg.toLowerCase().includes('skip'), `got "${msg}"`);
}

// 14. Outside Commonwealth bbox — warning shown but import proceeds
{
    await page.evaluate(() => {
        // Mock a tight nodeMap so 10°N, 123°E is clearly outside bbox
        window.nodeMap = {
            'n0': { lat: 14.695, lng: 121.085 },
            'n1': { lat: 14.715, lng: 121.105 }
        };
        window.P = []; window.crimeIdCounter = 0; window.uiApp.P = [];
        window.uiApp.importText = '10.0000, 123.0000';
        window.uiApp.importMessage = '';
        window.uiApp.clearBanner();
    });
    await page.evaluate(() => window.uiApp.importCoordinates());
    const banner = await page.evaluate(() => window.uiApp.bannerMessage);
    const pLen   = await page.evaluate(() => window.uiApp.P.length);
    log('Outside-bbox import — warning banner shown', banner.toLowerCase().includes('outside') || banner.toLowerCase().includes('barangay'), `got "${banner}"`);
    log('Outside-bbox import — point still imported', pLen === 1, `got ${pLen}`);
    await page.evaluate(() => { window.nodeMap = {}; });
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
section('Auth (API mocked — verifies client-side behavior)');

// 15. Register → success message, switch to login tab
{
    await page.evaluate(({ u }) => {
        window.uiApp.showAuth = true;
        window.uiApp.authMode = 'register';
        window.uiApp.authError = '';
        window.uiApp.authSuccess = '';
        window.uiApp.authForm = { username: u, password: 'TestPass123!', displayName: 'Test User' };
    }, { u: TEST_USER });

    await page.evaluate(() => window.uiApp.submitAuth());
    await page.waitForFunction(
        () => window.uiApp.authMode === 'login' || window.uiApp.authError !== '',
        { timeout: 8000 }
    );

    const mode    = await page.evaluate(() => window.uiApp.authMode);
    const err     = await page.evaluate(() => window.uiApp.authError);
    const success = await page.evaluate(() => window.uiApp.authSuccess);
    log('Register — switches to login tab', mode === 'login', `mode=${mode}, err="${err}"`);
    log('Register — success message shown', success.toLowerCase().includes('success') || success.toLowerCase().includes('created'), `got "${success}"`);
}

// 16. Login → username in control panel
{
    await page.evaluate(({ u }) => {
        window.uiApp.authMode = 'login';
        window.uiApp.authForm = { username: u, password: 'TestPass123!', displayName: '' };
        window.uiApp.authError = '';
        window.uiApp.authSuccess = '';
    }, { u: TEST_USER });

    await page.evaluate(() => window.uiApp.submitAuth());
    await page.waitForFunction(
        () => window.uiApp.currentUser !== null || window.uiApp.authError !== '',
        { timeout: 8000 }
    );

    const user      = await page.evaluate(() => window.uiApp.currentUser);
    const showAuth  = await page.evaluate(() => window.uiApp.showAuth);
    const panelText = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('span')];
        return spans.find(s => s.textContent.includes('Signed in as'))?.textContent?.trim() || '';
    });

    log('Login — currentUser set', user !== null && user.username === TEST_USER, `user=${JSON.stringify(user)}`);
    log('Login — modal closes on success', showAuth === false, `showAuth=${showAuth}`);
    log('Login — username shown in control panel', panelText.includes(TEST_USER), `got "${panelText}"`);
}

// 17. Logout → username gone, Sessions button hidden
{
    await page.evaluate(() => window.uiApp.logout());
    await page.waitForTimeout(150);

    const user            = await page.evaluate(() => window.uiApp.currentUser);
    const token           = await page.evaluate(() => window.authToken);
    const panelText       = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('span')];
        return spans.find(s => s.textContent.includes('Signed in as'))?.textContent?.trim() || '';
    });
    const sessionsVisible = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sessions');
        return btn ? btn.offsetParent !== null : null;
    });

    log('Logout — currentUser null', user === null, `got ${JSON.stringify(user)}`);
    log('Logout — authToken cleared', token === null, `got ${token}`);
    log('Logout — username gone from panel', !panelText.includes(TEST_USER), `got "${panelText}"`);
    log('Logout — Sessions button hidden', sessionsVisible === false || sessionsVisible === null, `visible=${sessionsVisible}`);
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
section('Export (API mocked — verifies client-side behavior)');

// 18. Disabled before pipeline runs
{
    const pipelineComplete = await page.evaluate(() => window.uiApp.pipelineComplete);
    const exportDisabled   = await page.evaluate(() => {
        // The export dropdown button has :disabled="!pipelineComplete"
        const buttons = [...document.querySelectorAll('button')];
        const exportBtn = buttons.find(b => {
            const path = b.querySelector('svg path');
            return path && path.getAttribute('d')?.includes('16v1a3 3 0 003 3h10');
        });
        return exportBtn ? exportBtn.disabled : null;
    });
    log('Export button disabled before pipeline runs', !pipelineComplete && exportDisabled === true,
        `pipelineComplete=${pipelineComplete}, exportDisabled=${exportDisabled}`);
}

// 19 & 20. PDF and CSV download — re-login via mock, then set pipelineComplete
{
    // Login via mock
    await page.evaluate(({ u }) => {
        window.uiApp.authMode = 'login';
        window.uiApp.authForm = { username: u, password: 'TestPass123!', displayName: '' };
        window.uiApp.authError = '';
    }, { u: TEST_USER });
    await page.evaluate(() => window.uiApp.submitAuth());
    await page.waitForFunction(
        () => window.uiApp.currentUser !== null || window.uiApp.authError !== '',
        { timeout: 8000 }
    );

    // Mock pipeline results
    await page.evaluate(() => {
        window.uiApp.pipelineComplete = true;
        window.pipelineComplete       = true;
        window.S_star  = [{ id: 1, lat: 14.7010, lng: 121.0910 }];
        window.zones   = [[{ crimeId: 'CRIME-001', lat: 14.7000, lng: 121.0900 }]];
        window.routes  = [];
        window.currentHull = [
            { lat: 14.699, lng: 121.089 }, { lat: 14.703, lng: 121.089 },
            { lat: 14.703, lng: 121.093 }, { lat: 14.699, lng: 121.093 }
        ];
    });

    // PDF
    const pdfPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => window.uiApp.exportResults('pdf'));
    const pdfDl = await pdfPromise;
    log('Export PDF — download triggered', pdfDl !== null,
        pdfDl ? pdfDl.suggestedFilename() : 'no download event');

    // CSV
    const csvPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => window.uiApp.exportResults('csv'));
    const csvDl = await csvPromise;
    log('Export CSV — download triggered', csvDl !== null,
        csvDl ? csvDl.suggestedFilename() : 'no download event');

    await page.evaluate(() => {
        window.uiApp.pipelineComplete = false;
        window.pipelineComplete = false;
    });
}

// ── WARNING BANNER CONSOLIDATION ──────────────────────────────────────────────
section('Warning Banner Consolidation');

// 21. Two simultaneous warnings → single banner with <ul> list format
{
    await page.evaluate(() => window.uiApp.clearBanner());
    await page.evaluate(() => {
        window.uiApp.showBanner(
            '2 coordinates fall outside Barangay Commonwealth.',
            'warning',
            [
                '2 coordinates fall outside Barangay Commonwealth. These points may produce no valid patrol positions.',
                '1 point flagged as potential outlier (orange markers).'
            ]
        );
    });
    await page.waitForTimeout(100);

    const listCount = await page.evaluate(() => window.uiApp.bannerList.length);
    const bannerMsg = await page.evaluate(() => window.uiApp.bannerMessage);
    const hasUl     = await page.evaluate(() => {
        // Look for the visible banner element containing a <ul>
        const allDivs = [...document.querySelectorAll('div')];
        const banner = allDivs.find(d =>
            d.classList.contains('border-yellow-300') ||
            d.classList.contains('border-red-300')
        );
        return banner ? banner.querySelector('ul') !== null : false;
    });

    log('Two warnings — bannerList.length === 2', listCount === 2, `got ${listCount}`);
    log('Two warnings — banner renders <ul> list format', hasUl, 'no <ul> found');
    log('Two warnings — single bannerMessage (not two)', bannerMsg.length > 0, `got "${bannerMsg}"`);
}

// 22. Bulk import live trigger of both warnings simultaneously
//     (4 clustered inside bbox + 1 far outside as outlier)
{
    await page.evaluate(() => {
        window.nodeMap = {
            'n0': { lat: 14.698, lng: 121.088 },
            'n1': { lat: 14.712, lng: 121.102 }
        };
        window.P = []; window.crimeIdCounter = 0; window.uiApp.P = [];
        window.uiApp.clearBanner();
        // 4 clustered inside + 1 far outside bbox (10°N) — far enough to be flagged as outlier
        window.uiApp.importText = [
            '14.7010, 121.0910',
            '14.7015, 121.0915',
            '14.7020, 121.0920',
            '14.7025, 121.0925',
            '10.0000, 123.0000'   // outside bbox AND outlier
        ].join('\n');
        window.uiApp.importMessage = '';
        window.uiApp.bannerMessage = '';
        window.uiApp.bannerList = [];
    });

    await page.evaluate(() => window.uiApp.importCoordinates());

    const listCount = await page.evaluate(() => window.uiApp.bannerList.length);
    const pLen      = await page.evaluate(() => window.uiApp.P.length);
    log('Bulk import two-warning trigger — bannerList.length >= 2', listCount >= 2,
        `got ${listCount} (expect bbox + outlier warning)`);
    log('Bulk import two-warning — import still proceeded (P has 5)', pLen === 5, `got ${pLen}`);

    await page.evaluate(() => { window.nodeMap = {}; });
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
