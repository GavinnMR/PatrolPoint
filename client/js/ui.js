// PatrolPoint V2 — ui.js
// Alpine.js global component patrolPointApp().
// Implements all interactive features from SPEC.md Sections 20 and 23.
// Map rendering lives in map.js (Part 9). WebSocket lives in websocket-client.js (Part 8).

// Module-level Haversine used by importCoordinates() outlier detection.
// Parameters always lat1, lng1, lat2, lng2 — lat before lng, never swapped.
function _haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Algorithm descriptions shown in the trace panel — educational, not data-driven.
const STAGE_INFO = {
    1: {
        description: 'Finds the smallest convex polygon enclosing all plotted crime incidents. This polygon defines the operational danger zone — all patrols and routes are constrained within it.',
        algorithmNote: 'For every directed pair of points (A→B), checks whether all remaining points lie to the left of the line. If yes, A→B is a valid hull edge. Valid edges are chained into an ordered polygon. Time complexity: O(n³) — tractable at n ≤ 30 incidents. Outliers are detected by mean distance from centroid before hull computation begins.'
    },
    2: {
        description: 'Places n patrol units at road intersection nodes inside the danger zone, maximizing the minimum pairwise distance between any two patrols.',
        algorithmNote: 'Each patrol iteratively moves to the neighbor intersection within radius R that most improves the global minimum pairwise distance (the objective). Multiple random restarts avoid local optima. When all patrols are stuck with no valid neighbors, R expands by 50% and the search resumes. The best result across all restarts becomes S★.'
    },
    3: {
        description: 'Assigns each crime incident to its nearest patrol using shortest road-network distance, forming n distinct patrol responsibility zones.',
        algorithmNote: 'Each incident snaps silently to the nearest road intersection inside the hull. Dijkstra runs once per snapped node — a single source gives distances to all patrol positions simultaneously. The incident is assigned to the patrol with minimum road distance; straight-line Haversine is the fallback only when road distances are unavailable.'
    },
    4: {
        description: 'Computes the optimal closed-loop visiting circuit for each patrol through its assigned incidents. Routes follow actual road edges — never straight lines through buildings.',
        algorithmNote: 'Backtracking explores all k! visiting permutations. Branch-and-bound pruning cuts any partial path whose accumulated distance already exceeds the current best complete circuit. Dijkstra paths between waypoints are cached — each node pair is computed at most once and reused across all patrol zones in the same pipeline run.'
    }
};

document.addEventListener('alpine:init', () => {
    Alpine.data('patrolPointApp', () => ({

        // ── WebSocket connection state ────────────────────────────────────────
        wsConnected:   true,
        wsStatusText:  'Connecting to server…',

        // ── Barangay ─────────────────────────────────────────────────────────
        selectedBarangay:     'Commonwealth',
        barangayOptions:      ['Commonwealth'],
        barangayQuery:        'Commonwealth',   // combobox input text
        barangayDropdownOpen: false,
        networkInfo:          '',    // e.g. "3613 nodes · 3971 edges · cached"
        nMax:                 null,  // soft cap = floor(sqrt(intersectionCount))

        get barangayFiltered() {
            const q = this.barangayQuery.toLowerCase();
            return this.barangayOptions.filter(b => b.toLowerCase().includes(q));
        },

        selectBarangay(b) {
            this.selectedBarangay = b;
            this.barangayQuery    = b;
            this.barangayDropdownOpen = false;
            this.onBarangayChange();
        },

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
        bannerCollapsed: false,

        // ── Algorithm trace panel ─────────────────────────────────────────────
        showTracePanel:      false,
        traceStages:         [],   // {id, name, description, algorithmNote, status, summary, metrics, fullLog, expanded, runtimeMs}
        pipelineSummary:     '',
        pipelineSummaryData: null, // structured summary for rich display

        // ── Panels / modals ───────────────────────────────────────────────────
        showSettings:      false,
        showComparison:    false,
        showImport:        false,
        showPlayback:      false,

        // ── Import coordinates ────────────────────────────────────────────────
        importText:    '',
        importMessage: '',

        // ── Undo / redo stacks ────────────────────────────────────────────────
        undoStack: [],   // {type, data, timestamp} — length exposed for :disabled binding
        redoStack: [],

        // ── Display preferences ───────────────────────────────────────────────
        darkMode:          false,
        animationsEnabled: true,
        osmGraphMode:      false,

        // ── Algorithm comparison mode ─────────────────────────────────────────
        comparisonModeActive: false,
        comparisonRunA:       null,
        comparisonRunB:       null,
        showRunA:             true,
        showRunB:             true,

        // ── Verification report ───────────────────────────────────────────────
        verificationReport: null,

        // ── Route playback ────────────────────────────────────────────────────
        routePlaybackActive: false,
        playbackPatrolId:    '',
        playbackSpeed:       1,
        playbackProgress:    0,

        // ── Mobile bottom sheet ───────────────────────────────────────────────
        mobileSheetHeight: 40,   // percent of viewport height — 40% collapsed, 80% expanded
        isMobile:          false,
        _dragStartY:       0,
        _dragStartHeight:  40,

        // ── Active config (currently applied, sent to backend on compute) ─────
        activeConfig: {
            candidateNodes:     'all',
            hillClimbing: {
                restarts:               50,
                maxIterations:          500,
                radiusMultiplier:       2,
                synchronousMode:        false
            },
            convexHull: {
                areaThresholdDivisor:   100,
                outlierMultiplier:      2.5,
                includeOutliers:        true
            },
            tsp: {
                maxCrimeNodesPerZone:                10,
                nearestNeighborFallbackThreshold:    12,
                hullExteriorPenalty:                 1
            },
            zoneAssignment: {
                strongRebalancing:      false
            },
            display: {
                showZoneLines:          true,
                showRouteArrows:        true,
                showOverlapColoring:    true,
                showCoverageRadius:     false,
                animationsEnabled:      true
            }
        },

        // ── Settings draft (editable copy shown in modal) ─────────────────────
        settingsDraft: {
            candidateNodes:     'all',
            hillClimbing: {
                restarts:               50,
                maxIterations:          500,
                radiusMultiplier:       2,
                synchronousMode:        false
            },
            convexHull: {
                areaThresholdDivisor:   100,
                outlierMultiplier:      2.5,
                includeOutliers:        true
            },
            tsp: {
                maxCrimeNodesPerZone:                10,
                nearestNeighborFallbackThreshold:    12,
                hullExteriorPenalty:                 1
            },
            zoneAssignment: {
                strongRebalancing:      false
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
            // Load persisted display preferences
            this.darkMode = localStorage.getItem('patrolpoint-dark-mode') === 'true';
            this.animationsEnabled = localStorage.getItem('patrolpoint-animations') !== 'false';
            this.settingsDraft.display.animationsEnabled = this.animationsEnabled;
            this.activeConfig.display.animationsEnabled = this.animationsEnabled;

            if (this.darkMode) {
                document.documentElement.classList.add('dark');
            }

            // Global keyboard shortcuts — only when textarea/input not focused
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

            // Mobile detection — check on init and on resize
            this.isMobile = window.innerWidth < 768;
            window.addEventListener('resize', () => {
                this.isMobile = window.innerWidth < 768;
            });

            // Watch showRunA/showRunB toggles to show/hide comparison layers
            this.$watch('showRunA', (val) => {
                if (typeof showComparisonRunA === 'function') showComparisonRunA(val);
            });
            this.$watch('showRunB', (val) => {
                if (typeof showComparisonRunB === 'function') showComparisonRunB(val);
            });

            // Expose Alpine component instance globally so map.js can call methods
            window.uiApp = this;

            // Populate barangay dropdown from manifest
            fetch('/data/barangays/manifest.json')
                .then(r => r.json())
                .then(manifest => {
                    window.barangayManifest = manifest;
                    const names = Object.keys(manifest).filter(n => !manifest[n].hidden).sort((a, b) => a.localeCompare(b));
                    this.barangayOptions = names;
                    if (!names.includes(this.selectedBarangay)) {
                        this.selectedBarangay = names[0] || 'Commonwealth';
                    }
                    this.barangayQuery = this.selectedBarangay;
                })
                .catch(() => { /* keep default ['Commonwealth'] */ });

            if (typeof initMap === 'function')       initMap(this);
            if (typeof initWebSocket === 'function') initWebSocket(this);
        },

        // ── Crime node management (public — called by map.js click/drag handlers) ──

        // Called by map.js when user clicks map to add an incident.
        addCrimeNode(lat, lng) {
            // Boundary check — reject points outside barangay
            if (typeof window.isInsideBarangay === 'function' && !window.isInsideBarangay(lat, lng)) {
                return null;
            }
            window.crimeIdCounter++;
            const crimeId = 'CRIME-' + String(window.crimeIdCounter).padStart(3, '0');
            const point = { crimeId, lat, lng };
            window.P.push(point);
            this.P = [...window.P];
            this._pushUndo({ type: 'add_crime', data: { crimeId, lat, lng }, timestamp: Date.now() });
            if (typeof plotCrimeMarker === 'function') plotCrimeMarker(point);
            return crimeId;
        },

        // Called by map.js when user clicks an existing marker to remove it.
        removeCrimeNode(crimeId) {
            const point = window.P.find(p => p.crimeId === crimeId);
            if (!point) return;
            window.P = window.P.filter(p => p.crimeId !== crimeId);
            this.P = [...window.P];
            this._pushUndo({ type: 'remove_crime', data: { crimeId, lat: point.lat, lng: point.lng }, timestamp: Date.now() });
            if (typeof removeCrimeMarker === 'function') removeCrimeMarker(crimeId);
        },

        // Called by map.js after a drag completes with validated new position.
        dragCrimeNode(crimeId, oldLat, oldLng, newLat, newLng) {
            const point = window.P.find(p => p.crimeId === crimeId);
            if (!point) return;
            point.lat = newLat;
            point.lng = newLng;
            this.P = [...window.P];
            this._pushUndo({ type: 'drag_crime', data: { crimeId, oldLat, oldLng, newLat, newLng }, timestamp: Date.now() });
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
            // Clear any banner from a previous run before starting the new one
            this.clearBanner();

            if (typeof sendComputeRequest === 'function') {
                sendComputeRequest(this.P, this.nPatrols, this.deploymentMode, this.activeConfig, this.selectedBarangay);
            } else {
                console.log('[ui.js] recalculate() — sendComputeRequest not yet implemented (Part 8)');
            }
        },

        // ── Banner helpers ────────────────────────────────────────────────────

        showBanner(message, type = 'warning', list = []) {
            this.bannerMessage = message;
            this.bannerType = type;
            this.bannerList = list.length ? list : [message];
            this.bannerCollapsed = false;
        },

        clearBanner() {
            this.bannerMessage = '';
            this.bannerList = [];
            this.bannerCollapsed = false;
        },

        // ── Dark mode ─────────────────────────────────────────────────────────

        toggleDarkMode() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('dark', this.darkMode);
            localStorage.setItem('patrolpoint-dark-mode', this.darkMode);
            window.darkMode = this.darkMode;
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

        resetRoadGraph() {
            if (!window.removedNodes || window.removedNodes.size === 0) return;
            if (!confirm(`Restore ${window.removedNodes.size} removed road node(s) to the graph?`)) return;
            if (typeof resetRemovedNodes === 'function') resetRemovedNodes();
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
            const barangay = this.selectedBarangay;
            window.currentBarangay = barangay;

            // Clear all crime nodes and pipeline state for the new barangay
            this.P = [];
            window.P = [];
            window.crimeIdCounter = 0;
            this.undoStack = [];
            this.redoStack = [];
            window.undoStack = [];
            window.redoStack = [];
            this.pipelineComplete = false;
            window.pipelineComplete = false;
            this.clearBanner();
            this.traceStages = [];
            this.pipelineSummary = '';
            this.pipelineSummaryData = null;
            this.networkInfo = '';

            if (typeof clearAllMapResults === 'function') clearAllMapResults();
            if (typeof loadBarangayNetwork === 'function') loadBarangayNetwork(barangay);

            // Request new network from server — responds with network_loaded (boundary + metadata)
            if (typeof sendInitRequest === 'function') {
                sendInitRequest(barangay);
            }
        },

        // ── Reset ─────────────────────────────────────────────────────────────

        confirmReset() {
            if (!confirm('Reset will clear all incident coordinates and results. Continue?')) return;

            if (this.P.length > 0) {
                this._pushUndo({
                    type: 'reset',
                    data: { previousP: [...this.P], previousCounter: window.crimeIdCounter },
                    timestamp: Date.now()
                });
            }

            this.P = [];
            window.P = [];
            window.crimeIdCounter = 0;
            this.pipelineComplete = false;
            window.pipelineComplete = false;
            this.clearBanner();
            this.traceStages = [];
            this.pipelineSummary = '';
            this.pipelineSummaryData = null;

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
            // Any new user action invalidates the redo stack
            this.redoStack = [];
            window.redoStack = [];
        },

        undo() {
            if (this.undoStack.length === 0) return;
            const action = this.undoStack.pop();
            this.redoStack.push(action);
            window.undoStack = this.undoStack;
            window.redoStack = this.redoStack;
            this._applyAction(action, true);
        },

        redo() {
            if (this.redoStack.length === 0) return;
            const action = this.redoStack.pop();
            this.undoStack.push(action);
            window.undoStack = this.undoStack;
            window.redoStack = this.redoStack;
            this._applyAction(action, false);
        },

        // inverse=true → undo (reverse the action); inverse=false → redo (re-apply it)
        _applyAction(action, inverse) {
            switch (action.type) {

                case 'add_crime':
                    if (inverse) {
                        // Undo: remove the added point
                        window.P = window.P.filter(p => p.crimeId !== action.data.crimeId);
                        this.P = [...window.P];
                        if (typeof removeCrimeMarker === 'function') removeCrimeMarker(action.data.crimeId);
                    } else {
                        // Redo: add the point back
                        const pt = { crimeId: action.data.crimeId, lat: action.data.lat, lng: action.data.lng };
                        window.P.push(pt);
                        this.P = [...window.P];
                        if (typeof plotCrimeMarker === 'function') plotCrimeMarker(pt);
                    }
                    break;

                case 'remove_crime':
                    if (inverse) {
                        // Undo: restore the removed point
                        const pt = { crimeId: action.data.crimeId, lat: action.data.lat, lng: action.data.lng };
                        window.P.push(pt);
                        this.P = [...window.P];
                        if (typeof plotCrimeMarker === 'function') plotCrimeMarker(pt);
                    } else {
                        // Redo: remove the point again
                        window.P = window.P.filter(p => p.crimeId !== action.data.crimeId);
                        this.P = [...window.P];
                        if (typeof removeCrimeMarker === 'function') removeCrimeMarker(action.data.crimeId);
                    }
                    break;

                case 'drag_crime': {
                    const pt = window.P.find(p => p.crimeId === action.data.crimeId);
                    if (!pt) break;
                    if (inverse) {
                        pt.lat = action.data.oldLat;
                        pt.lng = action.data.oldLng;
                        if (typeof moveCrimeMarker === 'function') moveCrimeMarker(action.data.crimeId, action.data.oldLat, action.data.oldLng);
                    } else {
                        pt.lat = action.data.newLat;
                        pt.lng = action.data.newLng;
                        if (typeof moveCrimeMarker === 'function') moveCrimeMarker(action.data.crimeId, action.data.newLat, action.data.newLng);
                    }
                    this.P = [...window.P];
                    break;
                }

                case 'bulk_import':
                    if (inverse) {
                        // Undo: restore the previous set of points
                        window.P = [...action.data.previousP];
                        this.P = [...window.P];
                        if (action.data.previousCounter !== undefined) {
                            window.crimeIdCounter = action.data.previousCounter;
                        }
                        if (typeof restoreCrimeMarkers === 'function') {
                            restoreCrimeMarkers(window.P);
                        } else {
                            console.log('[ui.js] undo bulk_import — restoreCrimeMarkers not yet implemented (Part 9)');
                        }
                    } else {
                        // Redo: re-apply the import
                        if (action.data.newP) {
                            window.P = [...action.data.newP];
                            this.P = [...window.P];
                            if (action.data.newCounter !== undefined) {
                                window.crimeIdCounter = action.data.newCounter;
                            }
                            if (typeof restoreCrimeMarkers === 'function') {
                                restoreCrimeMarkers(window.P);
                            }
                        }
                    }
                    break;

                case 'reset':
                    if (inverse) {
                        // Undo: restore the cleared points
                        window.P = [...action.data.previousP];
                        this.P = [...window.P];
                        if (action.data.previousCounter !== undefined) {
                            window.crimeIdCounter = action.data.previousCounter;
                        }
                        if (typeof restoreCrimeMarkers === 'function') {
                            restoreCrimeMarkers(window.P);
                        } else {
                            console.log('[ui.js] undo reset — restoreCrimeMarkers not yet implemented (Part 9)');
                        }
                    } else {
                        // Redo: clear again
                        window.P = [];
                        this.P = [];
                        window.crimeIdCounter = 0;
                        if (typeof clearAllMapResults === 'function') clearAllMapResults();
                    }
                    break;
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

            // Barangay boundary check — hard filter, reject outside points
            const warnings = [];
            let outsideCount = 0;
            const inside = typeof window.isInsideBarangay === 'function'
                ? valid.filter(p => {
                    if (window.isInsideBarangay(p.lat, p.lng)) return true;
                    outsideCount++;
                    return false;
                })
                : valid;
            if (outsideCount > 0) skipped += outsideCount;
            if (inside.length === 0) {
                this.importMessage = 'No coordinates fall inside the barangay boundary. Nothing imported.';
                return;
            }
            const valid_filtered = inside;

            const replacingCount = this.P.length;
            if (replacingCount > 0) {
                const ok = confirm(
                    `Importing will replace ${replacingCount} existing incident point${replacingCount !== 1 ? 's' : ''}. Continue?`
                );
                if (!ok) return;
            }

            // Build new points with unique IDs (IDs continue from current counter)
            const prevCounter = window.crimeIdCounter;
            const prevP = [...this.P];
            const newP = valid_filtered.map((v, i) => ({
                crimeId: 'CRIME-' + String(prevCounter + i + 1).padStart(3, '0'),
                lat: v.lat,
                lng: v.lng
            }));
            const newCounter = prevCounter + valid_filtered.length;

            // Outlier detection — runs immediately after parsing, before markers are plotted.
            // Flags points whose Haversine distance from centroid exceeds multiplier × average.
            let outlierCount = 0;
            if (newP.length >= 3) {
                const mult = (this.activeConfig.convexHull && this.activeConfig.convexHull.outlierMultiplier) || 2.5;
                const centLat = newP.reduce((s, p) => s + p.lat, 0) / newP.length;
                const centLng = newP.reduce((s, p) => s + p.lng, 0) / newP.length;
                const dists = newP.map(p => _haversine(centLat, centLng, p.lat, p.lng));
                const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
                const threshold = mult * avg;
                newP.forEach((p, i) => { p.isOutlier = dists[i] > threshold; });
                outlierCount = newP.filter(p => p.isOutlier).length;
                if (outlierCount > 0) {
                    warnings.push(
                        `${outlierCount} point${outlierCount !== 1 ? 's' : ''} flagged as potential outlier${outlierCount !== 1 ? 's' : ''} (orange markers).`
                    );
                }
            }

            // Push undo action before modifying state
            this._pushUndo({
                type: 'bulk_import',
                data: { previousP: prevP, previousCounter: prevCounter, newP, newCounter },
                timestamp: Date.now()
            });

            // Clear existing markers then plot new ones
            if (typeof clearCrimeMarkers === 'function') {
                clearCrimeMarkers();
            }

            window.crimeIdCounter = newCounter;
            window.P = newP;
            this.P = [...window.P];

            if (typeof restoreCrimeMarkers === 'function') {
                restoreCrimeMarkers(window.P);
            } else {
                console.log('[ui.js] importCoordinates() — restoreCrimeMarkers not yet implemented (Part 9)');
            }

            this.importText = '';

            if (warnings.length > 0) {
                this.showBanner(warnings[0], 'warning', warnings);
            }

            const skippedMsg = skipped ? `, ${skipped} line${skipped !== 1 ? 's' : ''} skipped (invalid format or outside boundary)` : '';
            this.importMessage = `${valid_filtered.length} point${valid_filtered.length !== 1 ? 's' : ''} imported successfully${skippedMsg}.`;
            setTimeout(() => { this.importMessage = ''; }, 3000);
        },

        // ── Settings ──────────────────────────────────────────────────────────

        // Always sync settingsDraft from activeConfig so modal shows current values.
        openSettings() {
            this.settingsDraft = JSON.parse(JSON.stringify(this.activeConfig));
            this.showSettings = true;
        },

        applySettings() {
            // Commit draft to active config
            this.activeConfig = JSON.parse(JSON.stringify(this.settingsDraft));

            // Update nMax based on candidateNodes setting
            const count = this.activeConfig.candidateNodes === 'intersection'
                ? (window._intersectionCount || 0)
                : (window._nodeCount || 0);
            if (count) this.nMax = Math.floor(Math.sqrt(count));

            // Sync animation preference to reactive state and localStorage
            this.animationsEnabled = this.activeConfig.display.animationsEnabled;
            window.animationsEnabled = this.animationsEnabled;
            localStorage.setItem('patrolpoint-animations', this.animationsEnabled);

            if (typeof applyConfig === 'function') {
                applyConfig(this.activeConfig);
            }
            this.showSettings = false;
        },

        resetSettingsToDefaults() {
            this.settingsDraft = {
                candidateNodes:     'all',
                hillClimbing: {
                    restarts:               50,
                    maxIterations:          500,
                    radiusMultiplier:       2,
                        synchronousMode:        false
                },
                convexHull: {
                    areaThresholdDivisor:   100,
                    outlierMultiplier:      2.5,
                    includeOutliers:        true
                },
                tsp: {
                    maxCrimeNodesPerZone:                10,
                    nearestNeighborFallbackThreshold:    12,
                    hullExteriorPenalty:                 1
                },
                zoneAssignment: {
                    strongRebalancing:      false
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

        // ── Print ─────────────────────────────────────────────────────────────

        printView() {
            const ts = new Date().toLocaleString('en-PH', {
                month: 'long', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false,
                timeZone: 'Asia/Manila'
            });
            document.body.setAttribute('data-print-timestamp', `Generated: ${ts}`);
            window.print();
        },

        // ── Route playback ────────────────────────────────────────────────────

        playbackToggle() {
            if (this.routePlaybackActive) {
                stopRoutePlayback();
            } else {
                startRoutePlayback(this.playbackPatrolId, this.playbackSpeed);
            }
        },

        playbackStop() {
            stopRoutePlayback();
        },

        onPlaybackPatrolChange() {
            if (this.routePlaybackActive) {
                startRoutePlayback(this.playbackPatrolId, this.playbackSpeed);
            }
            if (this.playbackPatrolId && window.showPatrolInfoPanel) {
                window.showPatrolInfoPanel(this.playbackPatrolId);
            }
        },

        onPlaybackSpeedChange() {
            updatePlaybackSpeed(this.playbackSpeed);
        },

        // ── Mobile bottom sheet drag ──────────────────────────────────────────

        onDragStart(e) {
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            this._dragStartY      = touch.clientY;
            this._dragStartHeight = this.mobileSheetHeight;
        },

        onDragMove(e) {
            const touch = e.touches && e.touches[0];
            if (!touch || this._dragStartY === 0) return;
            const deltaY   = this._dragStartY - touch.clientY;
            const deltaPct = (deltaY / window.innerHeight) * 100;
            this.mobileSheetHeight = Math.min(80, Math.max(20, this._dragStartHeight + deltaPct));
        },

        onDragEnd() {
            if (this._dragStartY === 0) return;
            this.mobileSheetHeight = this.mobileSheetHeight > 55 ? 80 : 40;
            this._dragStartY = 0;
        },

        // ── Algorithm comparison mode ─────────────────────────────────────────

        enterComparisonMode() {
            this.comparisonModeActive = true;
            window.comparisonModeActive = true;
            this.showComparison = true;
        },

        storeComparisonRunA() {
            if (!window.pipelineComplete) return;
            const totalCircuitDist = (window.routes || []).reduce((s, r) => s + (r.circuitDistanceM || 0), 0);
            const stationaryCount  = (window.zones  || []).filter(z => !z || z.length === 0).length;
            this.comparisonRunA = {
                barangay:        this.selectedBarangay,
                patrols:         window.S_star  ? [...window.S_star]     : [],
                hull:            window.currentHull ? [...window.currentHull] : [],
                zones:           window.zones   ? [...window.zones]      : [],
                routes:          window.routes  ? [...window.routes]     : [],
                mode:            this.deploymentMode,
                minPairwiseDist: window._lastMinPairwiseDist ?? null,
                totalCircuitDist,
                stationaryCount,
                totalRuntimeMs:  window._lastTotalRuntimeMs  ?? null,
                config:          JSON.parse(JSON.stringify(this.activeConfig))
            };
            window.comparisonResultA = this.comparisonRunA;
            this.enterComparisonMode();
            if (typeof renderComparisonResults === 'function' && this.comparisonRunB) {
                renderComparisonResults(this.comparisonRunA, this.comparisonRunB);
            }
        },

        storeComparisonRunB() {
            if (!window.pipelineComplete) return;
            const totalCircuitDist = (window.routes || []).reduce((s, r) => s + (r.circuitDistanceM || 0), 0);
            const stationaryCount  = (window.zones  || []).filter(z => !z || z.length === 0).length;
            this.comparisonRunB = {
                barangay:        this.selectedBarangay,
                patrols:         window.S_star  ? [...window.S_star]     : [],
                hull:            window.currentHull ? [...window.currentHull] : [],
                zones:           window.zones   ? [...window.zones]      : [],
                routes:          window.routes  ? [...window.routes]     : [],
                mode:            this.deploymentMode,
                minPairwiseDist: window._lastMinPairwiseDist ?? null,
                totalCircuitDist,
                stationaryCount,
                totalRuntimeMs:  window._lastTotalRuntimeMs  ?? null,
                config:          JSON.parse(JSON.stringify(this.activeConfig))
            };
            window.comparisonResultB = this.comparisonRunB;
            if (typeof renderComparisonResults === 'function' && this.comparisonRunA) {
                renderComparisonResults(this.comparisonRunA, this.comparisonRunB);
            }
        },

        exitComparisonMode() {
            this.comparisonRunA = null;
            this.comparisonRunB = null;
            this.comparisonModeActive = false;
            this.showComparison = false;
            this.showRunA = true;
            this.showRunB = true;
            window.comparisonResultA = null;
            window.comparisonResultB = null;
            window.comparisonModeActive = false;
            if (typeof clearComparisonOverlay === 'function') clearComparisonOverlay();
        },

        // ── Trace panel helpers (called by websocket-client.js) ───────────────

        initTracePanel() {
            this.traceStages        = [];
            this.pipelineSummary    = '';
            this.pipelineSummaryData = null;
            this.verificationReport  = null;
        },

        addTraceStage(id, name) {
            const info = STAGE_INFO[id] || {};
            this.traceStages.push({
                id,
                name,
                description:        info.description   || '',
                algorithmNote:      info.algorithmNote  || '',
                status:             'running',
                summary:            '',
                metrics:            [],
                fullLog:            '',
                expanded:           true,
                runtimeMs:          null,
                confidence:         null,
                convergenceCurve:   null,
                convergenceRestart: null,
                redundancy:         null,
                restartsCompleted:  null,
                subparts:           []
            });
        },

        updateTraceStage(id, { status, summary, fullLog, runtimeMs, confidence,
                                convergenceCurve, convergenceRestart, redundancy,
                                restartsCompleted, metrics, subparts }) {
            const stage = this.traceStages.find(s => s.id === id);
            if (!stage) return;
            if (status             !== undefined) stage.status             = status;
            if (summary            !== undefined) stage.summary            = summary;
            if (fullLog            !== undefined) stage.fullLog            = fullLog;
            if (runtimeMs          !== undefined) stage.runtimeMs          = runtimeMs;
            if (confidence         !== undefined) stage.confidence         = confidence;
            if (convergenceCurve   !== undefined) stage.convergenceCurve   = convergenceCurve;
            if (convergenceRestart !== undefined) stage.convergenceRestart = convergenceRestart;
            if (redundancy         !== undefined) stage.redundancy         = redundancy;
            if (restartsCompleted  !== undefined) stage.restartsCompleted  = restartsCompleted;
            if (metrics            !== undefined) stage.metrics            = metrics;
            if (subparts           !== undefined) stage.subparts           = subparts;
        },

        setPipelineSummary(text) {
            this.pipelineSummary = text;
            this.$nextTick(() => {
                const el = document.getElementById('trace-content');
                if (el) el.scrollTop = el.scrollHeight;
            });
        }

    }));
});
