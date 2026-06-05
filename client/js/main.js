// PatrolPoint V2 — main.js
// Entry point. Global state and Alpine.js component defined here.
// Map, WebSocket, and animation logic live in their own modules.

// ── Global state ────────────────────────────────────────────────────────────

let P = [];
let crimeIdCounter = 0;
let crimeMarkers = {};

let currentHull = null;
let S_star = [];
let zones = [];
let routes = [];
let pipelineComplete = false;

let hullPolygon = null;
let patrolMarkers = {};
let patrolRoutes = {};
let zoneLines = [];
let overlapOverlay = [];
let nearestHighlights = [];
let barangayMask = null;
let osmGraphLayers = [];

let nodeMap = {};
let adjacencyList = {};
let intersectionNodeIds = [];
let barangayBoundary = [];
let currentBarangay = 'Commonwealth';

let pipelineRunning = false;
let undoStack = [];
let redoStack = [];
let darkMode = false;
let animationsEnabled = true;
let osmGraphMode = false;

let authToken = null;
let currentUser = null;

let comparisonModeActive = false;
let comparisonResultA = null;
let comparisonResultB = null;

const PATROL_COLORS = [
    '#e74c3c','#3498db','#2ecc71','#f39c12',
    '#9b59b6','#1abc9c','#e67e22','#34495e',
    '#e91e63','#00bcd4'
];

// ── Alpine.js component ──────────────────────────────────────────────────────

document.addEventListener('alpine:init', () => {
    Alpine.data('patrolPointApp', () => ({
        // Connection
        wsConnected: false,
        wsStatusText: 'Connecting to server...',

        // Barangay
        selectedBarangay: 'Commonwealth',
        barangayOptions: ['Commonwealth'],
        networkInfo: '',
        nMax: null,

        // Inputs
        nPatrols: 3,
        nPatrolsError: '',
        deploymentMode: 'stationary',

        // Pipeline state
        pipelineRunning: false,
        pipelineComplete: false,
        pipelineStageText: 'Running...',
        P: [],

        // Banner
        bannerMessage: '',
        bannerType: 'warning',
        bannerList: [],

        // Trace panel
        showTracePanel: false,
        traceStages: [],
        pipelineSummary: '',

        // Panels/modals
        showSettings: false,
        showAuth: false,
        showSessions: false,
        showImport: false,
        showPlayback: false,

        // Import
        importText: '',
        importMessage: '',

        // Auth
        authMode: 'login',
        authForm: { username: '', password: '', displayName: '' },
        authError: '',
        currentUser: null,
        sessions: [],

        // Undo/redo
        undoStack: [],
        redoStack: [],

        // Dark mode / animations
        darkMode: false,
        animationsEnabled: true,
        osmGraphMode: false,

        // Comparison mode
        comparisonModeActive: false,

        // Playback
        routes: [],
        routePlaybackActive: false,
        playbackPatrolIndex: 0,
        playbackSpeed: 1,

        // Settings draft (mirrors CONFIG)
        settingsDraft: {
            hillClimbing: { restarts: 10, maxIterations: 500, radiusMultiplier: 2, adaptiveMaxRestarts: 30, synchronousMode: false },
            convexHull: { areaThresholdDivisor: 100, outlierMultiplier: 2.5, includeOutliers: false },
            tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12 },
            display: { showZoneLines: true, showRouteArrows: true, showOverlapColoring: true, showCoverageRadius: false, animationsEnabled: true }
        },

        init() {
            this.darkMode = localStorage.getItem('patrolpoint-dark-mode') === 'true';
            this.animationsEnabled = localStorage.getItem('patrolpoint-animations') !== 'false';
            if (this.darkMode) document.documentElement.classList.add('dark');

            // Keyboard shortcuts
            window.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
                if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); this.undo(); }
                if (e.ctrlKey && e.shiftKey && e.key === 'Z') { e.preventDefault(); this.redo(); }
                if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (!this.pipelineRunning) this.recalculate(); }
            });

            // Beforeunload warning
            window.addEventListener('beforeunload', (e) => {
                if (this.P.length > 0 || this.pipelineComplete) {
                    e.preventDefault();
                    e.returnValue = 'You have unsaved patrol deployment data. Leave anyway?';
                }
            });

            // Init map and WebSocket (wired in later build steps — stubs for now)
            if (typeof initMap === 'function') initMap(this);
            if (typeof initWebSocket === 'function') initWebSocket(this);
        },

        validateNPatrols() {
            const v = this.nPatrols;
            if (!Number.isInteger(v) || v <= 0) {
                this.nPatrolsError = 'Must be a positive whole number.';
            } else {
                this.nPatrolsError = '';
            }
        },

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
            if (typeof sendComputeRequest === 'function') {
                sendComputeRequest(this.P, this.nPatrols, this.deploymentMode, this.settingsDraft, this.selectedBarangay);
            }
        },

        showBanner(message, type = 'warning', list = []) {
            this.bannerMessage = message;
            this.bannerType = type;
            this.bannerList = list.length ? list : [message];
        },

        clearBanner() {
            this.bannerMessage = '';
            this.bannerList = [];
        },

        toggleDarkMode() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('dark', this.darkMode);
            localStorage.setItem('patrolpoint-dark-mode', this.darkMode);
            if (typeof onDarkModeChange === 'function') onDarkModeChange(this.darkMode);
        },

        toggleOsmGraph() {
            this.osmGraphMode = !this.osmGraphMode;
            if (typeof toggleOsmGraphMode === 'function') toggleOsmGraphMode(this.osmGraphMode);
        },

        resetView() {
            if (typeof mapResetView === 'function') mapResetView();
        },

        onBarangayChange() {
            if (typeof loadBarangayNetwork === 'function') loadBarangayNetwork(this.selectedBarangay);
        },

        confirmReset() {
            if (!confirm('Reset will clear all incident coordinates and results. Continue?')) return;
            this.P = [];
            crimeIdCounter = 0;
            this.pipelineComplete = false;
            this.undoStack = [];
            this.redoStack = [];
            this.clearBanner();
            this.traceStages = [];
            this.pipelineSummary = '';
            if (typeof clearAllMapResults === 'function') clearAllMapResults();
        },

        undo() {
            if (this.undoStack.length === 0) return;
            const action = this.undoStack.pop();
            this.redoStack.push(action);
            if (typeof applyUndo === 'function') applyUndo(action, this);
        },

        redo() {
            if (this.redoStack.length === 0) return;
            const action = this.redoStack.pop();
            this.undoStack.push(action);
            if (typeof applyRedo === 'function') applyRedo(action, this);
        },

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
                if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) { skipped++; continue; }
                valid.push({ lat, lng });
            }
            if (valid.length === 0) {
                this.importMessage = 'No valid coordinates found.';
                return;
            }
            const confirmMsg = this.P.length > 0
                ? `Importing will replace ${this.P.length} existing incident point${this.P.length !== 1 ? 's' : ''}. Continue?`
                : null;
            if (confirmMsg && !confirm(confirmMsg)) return;
            if (typeof importCrimeNodes === 'function') importCrimeNodes(valid, this);
            this.importText = '';
            this.importMessage = `${valid.length} point${valid.length !== 1 ? 's' : ''} imported successfully${skipped ? `, ${skipped} line${skipped !== 1 ? 's' : ''} skipped` : ''}.`;
            setTimeout(() => { this.importMessage = ''; }, 3000);
        },

        applySettings() {
            if (typeof applyConfig === 'function') applyConfig(this.settingsDraft);
            this.showSettings = false;
        },

        resetSettingsToDefaults() {
            this.settingsDraft = {
                hillClimbing: { restarts: 10, maxIterations: 500, radiusMultiplier: 2, adaptiveMaxRestarts: 30, synchronousMode: false },
                convexHull: { areaThresholdDivisor: 100, outlierMultiplier: 2.5, includeOutliers: false },
                tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12 },
                display: { showZoneLines: true, showRouteArrows: true, showOverlapColoring: true, showCoverageRadius: false, animationsEnabled: true }
            };
        },

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
                if (!res.ok) { this.authError = data.error || 'Request failed.'; return; }
                if (this.authMode === 'login') {
                    authToken = data.token;
                    this.currentUser = data.user;
                    localStorage.setItem('patrolpoint-token', authToken);
                    this.showAuth = false;
                    this.loadSessions();
                } else {
                    this.authMode = 'login';
                    this.authError = '';
                }
            } catch (e) {
                this.authError = 'Connection error.';
            }
        },

        logout() {
            authToken = null;
            this.currentUser = null;
            this.sessions = [];
            localStorage.removeItem('patrolpoint-token');
        },

        async loadSessions() {
            if (!authToken) return;
            try {
                const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${authToken}` } });
                if (res.ok) this.sessions = await res.json();
            } catch (e) { /* silently ignore */ }
        },

        async loadSession(id) {
            if (!authToken) return;
            try {
                const res = await fetch(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${authToken}` } });
                if (!res.ok) return;
                const session = await res.json();
                if (typeof renderSessionResults === 'function') renderSessionResults(session, this);
                this.showSessions = false;
            } catch (e) { /* silently ignore */ }
        },

        async deleteSession(id) {
            if (!confirm('Delete this session?')) return;
            if (!authToken) return;
            try {
                await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
                this.sessions = this.sessions.filter(s => s.id !== id);
            } catch (e) { /* silently ignore */ }
        },

        async exportResults(format) {
            if (!authToken) { this.showBanner('Sign in to export results.', 'warning'); return; }
            try {
                const res = await fetch(`/api/export/${format}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                    body: JSON.stringify({ results: { hull: currentHull, patrols: S_star, zones, routes } })
                });
                if (!res.ok) return;
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `patrolpoint-deployment.${format}`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (e) { this.showBanner('Export failed.', 'error'); }
        },

        playbackPlay() { if (typeof startRoutePlayback === 'function') startRoutePlayback(this.playbackPatrolIndex, this.playbackSpeed); },
        playbackStop() { if (typeof stopRoutePlayback === 'function') stopRoutePlayback(); }
    }));
});
