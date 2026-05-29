# PatrolPoint

A client-side web application that optimally deploys patrol units across a barangay-level danger zone derived from user-plotted crime incident coordinates.

**[Live Demo →](https://gavinnmr.github.io/patrolpoint_v1/)**

---

## Problem Statement

Barangay-level patrol deployment is typically done by intuition. PatrolPoint gives a data-driven alternative: plot where incidents occurred, and the system computes the danger zone boundary, spreads patrol units optimally across it, and generates closed-loop roaming circuits for each patrol that follow actual road paths. Everything runs in the browser with no backend or account required.

The system is built around Barangay Commonwealth, Quezon City, Metro Manila — a pre-processed road network of 3,613 nodes and 3,971 edges is bundled with the app.

---

## Algorithm Pipeline

Each click of **Recalculate** runs four sequential stages:

### Stage 1 — Brute Force Convex Hull
Computes the smallest convex polygon enclosing all plotted incident coordinates. This polygon defines the operational danger zone. Uses an O(n³) brute-force edge test — tractable at the 5–30 incident points typical of barangay deployment. Includes outlier detection, collinearity handling, and a linear fallback for degenerate inputs.

### Stage 2 — Hill Climbing Patrol Placement
Places *n* patrol units at road intersection nodes inside the hull, maximising the minimum pairwise distance between all patrols. Uses multiple random restarts with a bounding-box-accelerated neighbourhood search. Operates exclusively on the 914 pre-computed intersection nodes of Barangay Commonwealth.

### Stage 3 — Zone Assignment
Assigns each crime incident to its nearest patrol via Haversine distance, forming *n* patrol zones. Incidents are silently snapped to the nearest road intersection inside the hull before assignment, so all downstream routing follows real roads.

### Stage 4 — Backtracking TSP (Roaming mode)
Finds the optimal closed-loop visiting sequence for each patrol through its assigned crime nodes using exact backtracking with branch-and-bound pruning. Zone size is capped at 10 nodes to keep O(k!) tractable.

### Stage 4.1 — Dijkstra Road Path Computation
Replaces straight-line segments with actual road-following paths. Runs Dijkstra's algorithm with a binary min-heap (O((V+E) log V)) on the full 3,613-node graph. Results are cached per pipeline run so repeated source nodes are only computed once.

---

## How to Run Locally

No build step. No dependencies to install.

```
git clone https://github.com/GavinnMR/patrolpoint_v1.git
cd patrolpoint_v1
```

Open `index.html` in any modern browser. The road network loads from `data/road_network.json` via a local `fetch` — use a local server if your browser blocks file-origin requests:

```
# Python
python -m http.server 5500

# VS Code
Install the "Live Server" extension, right-click index.html → Open with Live Server
```

Then open `http://localhost:5500` in your browser.

---

## Usage

1. **Plot incidents** — click anywhere on the map to add a crime incident coordinate (red ✕ marker)
2. **Set patrols** — enter the number of patrol units in the control panel (max 30)
3. **Choose mode** — Stationary places patrols and shows zone assignment lines; Roaming adds TSP road-following circuits
4. **Recalculate** — runs the full pipeline; or use **Ctrl+Enter**
5. **Import** — paste bulk coordinates (one `lat, lng` per line) via the Import Coordinates section
6. **Settings** — adjust algorithm constants (Hill Climbing restarts, outlier sensitivity, TSP zone cap, display toggles) via the ⚙ gear icon

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | HTML, CSS, vanilla JavaScript — no frameworks |
| Map | [Leaflet.js](https://leafletjs.com/) 1.9.4 via CDN |
| Tiles | OpenStreetMap standard tile layer |
| Route arrows | [Leaflet.PolylineDecorator](https://github.com/bbecquet/Leaflet.PolylineDecorator) 1.6.0 |
| Deployment | GitHub Pages (static, no backend) |
| Road network | Pre-processed GeoJSON — Barangay Commonwealth, Quezon City |

---

## Known Limitations

- **Fixed geography** — the road network is compiled specifically for Barangay Commonwealth. Applying the system to another barangay requires regenerating `road_network.json` from OpenStreetMap data.
- **Hill Climbing is heuristic** — patrol placement is not guaranteed optimal. Results vary slightly between runs due to random restarts.
- **TSP zone cap** — zones are limited to 10 crime nodes for tractability. Incidents beyond the cap are deprioritised (shown with grey markers).
- **No persistence** — all plotted incidents are lost on page refresh. Export is not yet implemented.
- **Desktop-only layout** — the side-by-side map and control panel is not optimised for mobile screens.
- **Offline use** — requires an internet connection to load OSM map tiles and CDN scripts (Leaflet, PolylineDecorator). The road network data itself is bundled locally.
