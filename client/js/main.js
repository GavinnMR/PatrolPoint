// PatrolPoint V2 — main.js
// Global state declarations and initialization sequence.
// Alpine.js component lives in ui.js.
// Map rendering lives in map.js (Part 9).
// WebSocket client lives in websocket-client.js (Part 8).

// ── Patrol color palette ─────────────────────────────────────────────────────
window.PATROL_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
    '#e91e63', '#00bcd4'
];

// ── Crime nodes ──────────────────────────────────────────────────────────────
window.P               = [];   // raw incident coordinate objects { crimeId, lat, lng }
window.crimeIdCounter  = 0;    // sequential counter for CRIME-001, CRIME-002, …
window.crimeMarkers    = {};   // crimeId → Leaflet marker

// ── Pipeline results ─────────────────────────────────────────────────────────
window.currentHull     = null; // hull polygon vertices [{lat,lng}]
window.S_star          = [];   // optimal patrol positions [{id,nodeId,lat,lng,color}]
window.zones           = [];   // n zone arrays of snapped crime node objects
window.routes          = [];   // TSP routes with pathSegments
window.pipelineComplete = false;

// ── Map layers ───────────────────────────────────────────────────────────────
window.hullPolygon     = null; // Leaflet polygon
window.patrolMarkers   = {};   // patrolId → Leaflet marker
window.patrolRoutes    = {};   // patrolId → array of Leaflet polylines
window.zoneLines       = [];   // Leaflet polylines for zone assignment lines
window.overlapOverlay  = [];   // Leaflet polylines for overlap highlighting
window.nearestHighlights = []; // Leaflet markers for nearest intersections outside hull
window.barangayMask    = null; // Leaflet polygon (world rect with boundary hole)
window.osmGraphLayers  = [];   // Leaflet polylines for OSM graph mode

// ── Road network (received from backend via WebSocket / HTTP) ────────────────
window.nodeMap              = {}; // nodeId → {lat, lng}
window.adjacencyList        = {}; // nodeId → [{neighborId, weight}]
window.intersectionNodeIds  = []; // array of intersection node IDs
window.barangayBoundary     = []; // boundary polygon vertices [{lat,lng}]
window.currentBarangay      = 'Commonwealth';

// ── UI state ─────────────────────────────────────────────────────────────────
window.pipelineRunning      = false;
window.undoStack            = [];  // action objects {type, data}
window.redoStack            = [];
window.darkMode             = false;
window.animationsEnabled    = true;
window.osmGraphMode         = false;
window.removedNodes         = new Set();  // node IDs excluded from routing — persists within session
window.comparisonModeActive = false;
window.comparisonResultA    = null;
window.comparisonResultB    = null;

// ── Auth ─────────────────────────────────────────────────────────────────────
window.authToken    = null;   // JWT from login
window.currentUser  = null;   // decoded user { id, username, displayName, barangay }

// ── Initialization (DOMContentLoaded) ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Load persisted display preferences from localStorage
    window.darkMode = localStorage.getItem('patrolpoint-dark-mode') === 'true';
    window.animationsEnabled = localStorage.getItem('patrolpoint-animations') !== 'false';

    // Apply dark mode class immediately so there is no flash of wrong theme
    if (window.darkMode) {
        document.documentElement.classList.add('dark');
    }

    // Restore saved auth token (validated by backend on first use)
    const savedToken = localStorage.getItem('patrolpoint-token');
    if (savedToken) window.authToken = savedToken;

    // Map, WebSocket, and network loading are initialized in Parts 8–9.
    // Stubs below guard against "function not defined" errors in earlier parts.
    if (typeof initMap === 'function')        initMap();
    if (typeof initWebSocket === 'function')  initWebSocket();
});
