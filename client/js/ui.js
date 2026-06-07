// PatrolPoint V2 — ui.js
// Alpine.js global component patrolPointApp().
// All reactive data and method stubs for the control panel, modals, and trace panel.
// Implemented progressively across Parts 7–11. Stubs console.log for now.

document.addEventListener('alpine:init', () => {
    Alpine.data('patrolPointApp', () => ({

        // ── WebSocket connection state ────────────────────────────────────────
        // wsConnected defaults true in Session 1 so the layout is visible.
        // Part 8 will set it false initially and true on connection.
        wsConnected:   true,
        wsStatusText:  'Connecting to server…',

        // ── Barangay ─────────────────────────────────────────────────────────
        selectedBarangay: 'Commonwealth',
        barangayOptions:  ['Commonwealth'],
        networkInfo:      '',    // e.g. "3613 nodes · 3971 edges · cached"
        nMax:             null,  // soft cap = floor(sqrt(intersectionCount))

        // ── Inputs ───────────────────────────────────────────────────────────
        nPatrols:        3,
        nPatrolsError:   '',
        deploymentMode:  'stationary',   // 'stationary' | 'roaming'

        // ── Pipeline state ───────────────────────────────────────────────────
        pipelineRunning:   false,
        pipelineComplete:  false,
        pipelineStageText: 'Running…',
        P:                 [],   // reactive mirror of window.P for templates
        routes:            [],   // reactive mirror of window.routes for playback select

        // ── Warning/error banner ──────────────────────────────────────────────
        bannerMessage: '',
        bannerType:    'warning',   // 'warning' | 'error'
        bannerList:    [],          // multiple warnings consolidated into one banner

        // ── Algorithm trace panel ─────────────────────────────────────────────
        showTracePanel:  false,
        traceStages:     [],   // {id, name, status, summary, fullLog, expanded, runtimeMs}
        pipelineSummary: '',

        // ── Panels / modals ───────────────────────────────────────────────────
        showSettings:      false,
        showAuth:          false,
        showSessions:      false,
        showComparison:    false,
        showImport:        false,
        showPlayback:      false,
        showSessionsPanel: false,  // collapsible inside control panel

        // ── Import coordinates ────────────────────────────────────────────────
        importText:    '',
        importMessage: '',

        // ── Auth ──────────────────────────────────────────────────────────────
        authMode: 'login',   // 'login' | 'register'
        authForm: { username: '', password: '', displayName: '' },
        authError:   '',
        currentUser: null,   // { id, username, displayName, barangay }
        sessions:    [],     // list from GET /api/sessions

        // ── Undo / redo stacks ────────────────────────────────────────────────
        undoStack: [],   // {type, data} — length exposed for button :disabled binding
        redoStack: [],

        // ── Display preferences ───────────────────────────────────────────────
        darkMode:          false,
        animationsEnabled: true,
        osmGraphMode:      false,

        // ── Algorithm comparison mode ─────────────────────────────────────────
        comparisonModeActive: false,
        comparisonRunA:       null,   // stored pipeline result object
        comparisonRunB:       null,
        showRunA:             true,
        showRunB:             true,

        // ── Route playback ────────────────────────────────────────────────────
        routePlaybackActive: false,
        playbackPatrolIndex: 0,
        playbackSpeed:       1,

        // ── Settings draft (mirrors CONFIG sent to backend) ───────────────────
        settingsDraft: {
            hillClimbing: {
                restarts:               10,
                maxIterations:          500,
                radiusMultiplier:       2,
                adaptiveMaxRestarts:    30,
                synchronousMode:        false
            },
            convexHull: {
                areaThresholdDivisor:   100,
                outlierMultiplier:      2.5,
                includeOutliers:        false
            },
            tsp: {
                maxCrimeNodesPerZone:                10,
                nearestNeighborFallbackThreshold:    12
            },
            display: {
                showZoneLines:          true,
                showRouteArrows:        true,
                showOverlapColoring:    true,
                showCoverageRadius:     false,
                animationsEnabled:      true
            }
        },

        // ── Lifecycle ─────────────────────────────────────────────────────────
        init() {
            // Sync display preferences from localStorage
            this.darkMode = localStorage.getItem('patrolpoint-dark-mode') === 'true';
            this.animationsEnabled = localStorage.getItem('patrolpoint-animations') !== 'false';
            this.settingsDraft.display.animationsEnabled = this.animationsEnabled;

            // Apply dark mode immediately (main.js DOMContentLoaded also does this,
            // but Alpine init can fire slightly after — belt-and-suspenders)
            if (this.darkMode) {
                document.documentElement.classList.add('dark');
            }

            // Restore auth token and user info if previously logged in
            const savedToken = localStorage.getItem('patrolpoint-token');
            if (savedToken) {
                window.authToken = savedToken;
                this._restoreSession(savedToken);
            }

            // Global keyboard shortcuts (only when textarea/input not focused)
            window.addEventListener('keydown', (e) => {
                const tag = e.target.tagName;
                if (tag === 'TEXTAREA' || tag === 'INPUT') return;

                if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
                    e.preventDefault();
                    this.undo();
                }
                if (e.ctrlKey && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
                    e.preventDefault();
                    this.redo();
                }
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    if (!this.pipelineRunning && this.wsConnected) this.recalculate();
                }
            });

            // Warn before unloading if unsaved data exists
            window.addEventListener('beforeunload', (e) => {
                if (this.P.length > 0 || this.pipelineComplete) {
                    e.preventDefault();
                    e.returnValue = 'You have unsaved patrol deployment data. Leave anyway?';
                }
            });

            // Wire map and WebSocket (stubs until Parts 8–9)
            if (typeof initMap === 'function')       initMap(this);
            if (typeof initWebSocket === 'function') initWebSocket(this);
        },

        // ── Auth helpers ──────────────────────────────────────────────────────

        async _restoreSession(token) {
            try {
                const res = await fetch('/api/auth/me', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    this.currentUser = data;
                    window.currentUser = data;
                }
            } catch (_) { /* silently ignore — token may be expired */ }
        },

        // ── Input validation ──────────────────────────────────────────────────

        validateNPatrols() {
            const v = this.nPatrols;
            if (!Number.isInteger(v) || v <= 0) {
                this.nPatrolsError = 'Must be a positive whole number.';
            } else {
                this.nPatrolsError = '';
            }
        },

        // ── Pipeline ──────────────────────────────────────────────────────────

        recalculate() {
            this.validateNPatrols();
            if (this.nPatrolsError) return;
            if (this.P.length === 0) {
                this.showBanner('No incident coordinates plotted. Please click the map to add incident coordinates.', 'error');
                return;
            }
            if (this.P.length === 1) {
                this.showBanner('At least 2 incident coordinates are needed. Please plot more points.', 'error');
                return;
            }
            // WebSocket compute request (wired in Part 8)
            if (typeof sendComputeRequest === 'function') {
                sendComputeRequest(this.P, this.nPatrols, this.deploymentMode, this.settingsDraft, this.selectedBarangay);
            } else {
                console.log('[ui.js] recalculate() — sendComputeRequest not yet implemented (Part 8)');
            }
        },

        // ── Banner helpers ────────────────────────────────────────────────────

        showBanner(message, type = 'warning', list = []) {
            this.bannerMessage = message;
            this.bannerType = type;
            this.bannerList = list.length ? list : [message];
        },

        clearBanner() {
            this.bannerMessage = '';
            this.bannerList = [];
        },

        // ── Dark mode ─────────────────────────────────────────────────────────

        toggleDarkMode() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('dark', this.darkMode);
            localStorage.setItem('patrolpoint-dark-mode', this.darkMode);
            window.darkMode = this.darkMode;
            // Map tile layer switch wired in Part 9
            if (typeof onDarkModeChange === 'function') onDarkModeChange(this.darkMode);
        },

        // ── OSM graph mode ────────────────────────────────────────────────────

        toggleOsmGraph() {
            this.osmGraphMode = !this.osmGraphMode;
            window.osmGraphMode = this.osmGraphMode;
            if (typeof toggleOsmGraphMode === 'function') {
                toggleOsmGraphMode(this.osmGraphMode);
            } else {
                console.log('[ui.js] toggleOsmGraph() — toggleOsmGraphMode not yet implemented (Part 9)');
            }
        },

        // ── Map view ──────────────────────────────────────────────────────────

        resetView() {
            if (typeof mapResetView === 'function') {
                mapResetView();
            } else {
                console.log('[ui.js] resetView() — mapResetView not yet implemented (Part 9)');
            }
        },

        // ── Barangay selection ────────────────────────────────────────────────

        onBarangayChange() {
            window.currentBarangay = this.selectedBarangay;
            if (typeof loadBarangayNetwork === 'function') {
                loadBarangayNetwork(this.selectedBarangay);
            } else {
                console.log('[ui.js] onBarangayChange() — loadBarangayNetwork not yet implemented (Part 8)');
            }
        },

        // ── Reset ─────────────────────────────────────────────────────────────

        confirmReset() {
            if (!confirm('Reset will clear all incident coordinates and results. Continue?')) return;

            // Push to undo stack before clearing (so reset can be undone)
            if (this.P.length > 0) {
                this._pushUndo({ type: 'reset', data: { previousP: [...this.P] } });
            }

            this.P = [];
            window.P = [];
            window.crimeIdCounter = 0;
            this.pipelineComplete = false;
            window.pipelineComplete = false;
            this.clearBanner();
            this.traceStages = [];
            this.pipelineSummary = '';

            if (typeof clearAllMapResults === 'function') {
                clearAllMapResults();
            } else {
                console.log('[ui.js] confirmReset() — clearAllMapResults not yet implemented (Part 9)');
            }
        },

        // ── Undo / redo ───────────────────────────────────────────────────────

        _pushUndo(action) {
            this.undoStack.push(action);
            window.undoStack = this.undoStack;
            if (this.undoStack.length > 50) this.undoStack.shift();
            // Any new action clears the redo stack
            this.redoStack = [];
            window.redoStack = [];
        },

        undo() {
            if (this.undoStack.length === 0) return;
            const action = this.undoStack.pop();
            this.redoStack.push(action);
            window.undoStack = this.undoStack;
            window.redoStack = this.redoStack;
            if (typeof applyUndo === 'function') {
                applyUndo(action, this);
            } else {
                console.log('[ui.js] undo() — applyUndo not yet implemented (Part 9)');
            }
        },

        redo() {
            if (this.redoStack.length === 0) return;
            const action = this.redoStack.pop();
            this.undoStack.push(action);
            window.undoStack = this.undoStack;
            window.redoStack = this.redoStack;
            if (typeof applyRedo === 'function') {
                applyRedo(action, this);
            } else {
                console.log('[ui.js] redo() — applyRedo not yet implemented (Part 9)');
            }
        },

        // ── Import coordinates ────────────────────────────────────────────────

        importCoordinates() {
            if (!this.importText.trim()) return;

            const lines = this.importText.split('\n');
            const valid = [];
            let skipped = 0;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(',');
                if (parts.length !== 2) { skipped++; continue; }
                const lat = parseFloat(parts[0].trim());
                const lng = parseFloat(parts[1].trim());
                if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                    skipped++;
                    continue;
                }
                valid.push({ lat, lng });
            }

            if (valid.length === 0) {
                this.importMessage = 'No valid coordinates found.';
                return;
            }

            const replacingCount = this.P.length;
            if (replacingCount > 0) {
                const ok = confirm(
                    `Importing will replace ${replacingCount} existing incident point${replacingCount !== 1 ? 's' : ''}. Continue?`
                );
                if (!ok) return;
            }

            if (typeof importCrimeNodes === 'function') {
                importCrimeNodes(valid, this);
            } else {
                console.log('[ui.js] importCoordinates() — importCrimeNodes not yet implemented (Part 9)');
            }

            this.importText = '';
            const skippedMsg = skipped ? `, ${skipped} line${skipped !== 1 ? 's' : ''} skipped` : '';
            this.importMessage = `${valid.length} point${valid.length !== 1 ? 's' : ''} imported successfully${skippedMsg}.`;
            setTimeout(() => { this.importMessage = ''; }, 3000);
        },

        // ── Settings ──────────────────────────────────────────────────────────

        applySettings() {
            // Sync animation preference back to reactive state and localStorage
            this.animationsEnabled = this.settingsDraft.display.animationsEnabled;
            window.animationsEnabled = this.animationsEnabled;
            localStorage.setItem('patrolpoint-animations', this.animationsEnabled);

            if (typeof applyConfig === 'function') {
                applyConfig(this.settingsDraft);
            } else {
                console.log('[ui.js] applySettings() — applyConfig not yet implemented (Part 8)');
            }
            this.showSettings = false;
        },

        resetSettingsToDefaults() {
            this.settingsDraft = {
                hillClimbing: {
                    restarts:               10,
                    maxIterations:          500,
                    radiusMultiplier:       2,
                    adaptiveMaxRestarts:    30,
                    synchronousMode:        false
                },
                convexHull: {
                    areaThresholdDivisor:   100,
                    outlierMultiplier:      2.5,
                    includeOutliers:        false
                },
                tsp: {
                    maxCrimeNodesPerZone:                10,
                    nearestNeighborFallbackThreshold:    12
                },
                display: {
                    showZoneLines:          true,
                    showRouteArrows:        true,
                    showOverlapColoring:    true,
                    showCoverageRadius:     false,
                    animationsEnabled:      true
                }
            };
        },

        // ── Auth ──────────────────────────────────────────────────────────────

        async submitAuth() {
            this.authError = '';
            const endpoint = this.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.authForm)
                });
                const data = await res.json();
                if (!res.ok) {
                    this.authError = data.error || 'Request failed.';
                    return;
                }
                if (this.authMode === 'login') {
                    window.authToken = data.token;
                    this.currentUser = data.user;
                    window.currentUser = data.user;
                    localStorage.setItem('patrolpoint-token', data.token);
                    this.showAuth = false;
                    this.loadSessions();
                } else {
                    // Successful registration — switch to login view
                    this.authMode = 'login';
                    this.authError = '';
                    this.authForm.password = '';
                }
            } catch (_) {
                this.authError = 'Connection error. Is the server running?';
            }
        },

        logout() {
            window.authToken = null;
            window.currentUser = null;
            this.currentUser = null;
            this.sessions = [];
            this.showSessionsPanel = false;
            localStorage.removeItem('patrolpoint-token');
        },

        // ── Sessions ──────────────────────────────────────────────────────────

        async loadSessions() {
            if (!window.authToken) return;
            try {
                const res = await fetch('/api/sessions', {
                    headers: { Authorization: `Bearer ${window.authToken}` }
                });
                if (res.ok) this.sessions = await res.json();
            } catch (_) { /* silently ignore */ }
        },

        async loadSession(id) {
            if (!window.authToken) return;
            try {
                const res = await fetch(`/api/sessions/${id}`, {
                    headers: { Authorization: `Bearer ${window.authToken}` }
                });
                if (!res.ok) return;
                const session = await res.json();
                if (typeof renderSessionResults === 'function') {
                    renderSessionResults(session, this);
                } else {
                    console.log('[ui.js] loadSession() — renderSessionResults not yet implemented (Part 9)');
                }
                this.showSessions = false;
            } catch (_) { /* silently ignore */ }
        },

        async deleteSession(id) {
            if (!confirm('Delete this session?')) return;
            if (!window.authToken) return;
            try {
                await fetch(`/api/sessions/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${window.authToken}` }
                });
                this.sessions = this.sessions.filter(s => s.id !== id);
            } catch (_) { /* silently ignore */ }
        },

        async saveCurrentSession(name) {
            if (!window.authToken || !window.pipelineComplete) return;
            try {
                const body = {
                    session_name:    name || 'Untitled Session',
                    barangay_name:   this.selectedBarangay,
                    n_patrols:       this.nPatrols,
                    deployment_mode: this.deploymentMode,
                    incidents:       window.P,
                    config:          this.settingsDraft,
                    results: {
                        hull:    window.currentHull,
                        patrols: window.S_star,
                        zones:   window.zones,
                        routes:  window.routes
                    },
                    trace:           this.traceStages,
                    total_runtime_ms: null
                };
                const res = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${window.authToken}`
                    },
                    body: JSON.stringify(body)
                });
                if (res.ok) await this.loadSessions();
            } catch (_) { /* silently ignore */ }
        },

        // ── Export ────────────────────────────────────────────────────────────

        async exportResults(format) {
            if (!window.authToken) {
                this.showBanner('Sign in to export results.', 'warning');
                return;
            }
            try {
                const res = await fetch(`/api/export/${format}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization:  `Bearer ${window.authToken}`
                    },
                    body: JSON.stringify({
                        results: {
                            hull:    window.currentHull,
                            patrols: window.S_star,
                            zones:   window.zones,
                            routes:  window.routes
                        }
                    })
                });
                if (!res.ok) {
                    this.showBanner('Export failed. Please try again.', 'error');
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `patrolpoint-deployment.${format}`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (_) {
                this.showBanner('Export failed.', 'error');
            }
        },

        // ── Route playback ────────────────────────────────────────────────────

        playbackPlay() {
            if (typeof startRoutePlayback === 'function') {
                startRoutePlayback(this.playbackPatrolIndex, this.playbackSpeed);
            } else {
                console.log('[ui.js] playbackPlay() — startRoutePlayback not yet implemented (Part 10)');
            }
        },

        playbackStop() {
            if (typeof stopRoutePlayback === 'function') {
                stopRoutePlayback();
            } else {
                console.log('[ui.js] playbackStop() — stopRoutePlayback not yet implemented (Part 10)');
            }
        },

        // ── Algorithm comparison mode ─────────────────────────────────────────

        storeComparisonRunA() {
            if (!window.pipelineComplete) return;
            this.comparisonRunA = {
                barangay:        this.selectedBarangay,
                patrols:         window.S_star ? [...window.S_star] : [],
                mode:            this.deploymentMode,
                minPairwiseDist: null,   // filled by websocket-client in Part 8
                totalRuntimeMs:  null,
                config:          JSON.parse(JSON.stringify(this.settingsDraft))
            };
            this.comparisonModeActive = true;
            window.comparisonResultA = this.comparisonRunA;
            window.comparisonModeActive = true;
            if (typeof renderComparisonOverlay === 'function') renderComparisonOverlay('A', this.comparisonRunA);
        },

        storeComparisonRunB() {
            if (!window.pipelineComplete) return;
            this.comparisonRunB = {
                barangay:        this.selectedBarangay,
                patrols:         window.S_star ? [...window.S_star] : [],
                mode:            this.deploymentMode,
                minPairwiseDist: null,
                totalRuntimeMs:  null,
                config:          JSON.parse(JSON.stringify(this.settingsDraft))
            };
            window.comparisonResultB = this.comparisonRunB;
            if (typeof renderComparisonOverlay === 'function') renderComparisonOverlay('B', this.comparisonRunB);
        },

        exitComparisonMode() {
            this.comparisonRunA = null;
            this.comparisonRunB = null;
            this.comparisonModeActive = false;
            this.showRunA = true;
            this.showRunB = true;
            window.comparisonResultA = null;
            window.comparisonResultB = null;
            window.comparisonModeActive = false;
            if (typeof clearComparisonOverlay === 'function') clearComparisonOverlay();
        },

        // ── Trace panel helpers (called by websocket-client.js) ───────────────

        initTracePanel() {
            this.traceStages = [];
            this.pipelineSummary = '';
        },

        addTraceStage(id, name) {
            this.traceStages.push({
                id,
                name,
                status:    'running',
                summary:   '',
                fullLog:   '',
                expanded:  true,
                runtimeMs: null
            });
        },

        updateTraceStage(id, { status, summary, fullLog, runtimeMs }) {
            const stage = this.traceStages.find(s => s.id === id);
            if (!stage) return;
            if (status    !== undefined) stage.status    = status;
            if (summary   !== undefined) stage.summary   = summary;
            if (fullLog   !== undefined) stage.fullLog   = fullLog;
            if (runtimeMs !== undefined) stage.runtimeMs = runtimeMs;
        },

        setPipelineSummary(text) {
            this.pipelineSummary = text;
            // Auto-scroll trace panel to bottom
            this.$nextTick(() => {
                const el = document.getElementById('trace-content');
                if (el) el.scrollTop = el.scrollHeight;
            });
        }

    }));
});
