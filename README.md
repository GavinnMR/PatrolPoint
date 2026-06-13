# PatrolPoint V2

A full-stack web application that optimally deploys patrol units across a barangay-level danger zone derived from user-plotted crime incident coordinates. V2 moves all algorithm computation to a Node.js backend, adds real-time WebSocket streaming, multi-barangay support, and persistent session history.

> V1 (client-side only, Barangay Commonwealth fixed) is available at the `main` branch.

---

## Problem Statement

Barangay-level patrol deployment is typically done by intuition. PatrolPoint gives a data-driven alternative: plot where incidents occurred, and the system computes the danger zone boundary, spreads patrol units optimally across it, and generates closed-loop roaming circuits for each patrol that follow actual road paths.

V2 extends this to any Philippine barangay — road network data is fetched live from OpenStreetMap via the Overpass API and cached server-side, so no pre-bundled data files are required.

---

## What's New in V2

| Feature | V1 | V2 |
|---|---|---|
| Geography | Fixed: Barangay Commonwealth only | Any barangay via live Overpass queries |
| Algorithm execution | Browser (client-side) | Node.js backend |
| Stage updates | All-at-once after pipeline | Real-time per stage via WebSocket |
| Zone assignment distance | Haversine (Euclidean) | Dijkstra road-network distance |
| Hill Climbing | Fixed 10 restarts | Adaptive restart count (5–30), seeded RNG |
| Authentication | None | JWT-based login / register |
| Session history | Lost on refresh | Persisted in PostgreSQL per user |
| Export | None | PDF and CSV |
| UI framework | Vanilla CSS / JS | Tailwind CSS + Alpine.js + GSAP |
| Mobile | Desktop-only | Responsive with bottom sheet |
| Dark mode | No | Yes |

---

## Algorithm Pipeline

Each **Recalculate** request runs four sequential stages on the server. Progress is streamed to the browser stage-by-stage via WebSocket.

### Stage 1 — Brute Force Convex Hull
Computes the smallest convex polygon enclosing all plotted incident coordinates. This defines the operational danger zone. Uses O(n³) brute-force edge testing — tractable at the 5–30 incidents typical of barangay deployment. Includes outlier detection, collinearity handling, and a linear fallback for degenerate inputs. An incremental update skips recomputation if all new incidents fall inside the previous hull.

### Stage 2 — Hill Climbing Patrol Placement
Places *n* patrol units at road intersection nodes inside the hull, maximising the minimum pairwise Haversine distance between all patrols. Uses multiple random restarts with a bounding-box-accelerated neighbourhood search. V2 adds adaptive restart count (stops early when the last 3 restarts converge within 0.1%), incident-seeded RNG for reproducibility, and a confidence indicator based on result spread across restarts.

### Stage 3 — Zone Assignment
Assigns each crime incident to its nearest patrol using **shortest road-network distance** (Dijkstra), forming *n* patrol responsibility zones. Incidents are silently snapped to the nearest road intersection before assignment. A rebalancing pass caps zone size at 1.5× the mean to prevent heavily skewed zones.

### Stage 4 — Backtracking TSP (Roaming mode)
Finds the optimal closed-loop visiting sequence for each patrol through its assigned incidents using exact backtracking with branch-and-bound pruning. Zone size is capped at 10 nodes (configurable) to keep O(k!) tractable. A nearest-neighbour heuristic fallback handles zones > 12 nodes.

### Stage 4.1 — Dijkstra Road Path Computation
Replaces straight-line segments with actual road-following paths using a binary min-heap Dijkstra (O((V+E) log V)) on the full road graph. A per-run cache ensures each node pair is computed at most once and reused across all patrol zones.

---

## Architecture

```
Browser (Alpine.js + Leaflet)
        │  WebSocket (real-time stage updates)
        │  HTTP (auth, sessions, export)
        ▼
Express + ws  ─── PostgreSQL (Supabase)
        │              road_networks  (30-day cache)
        │              users
        │              deployment_sessions
        ▼
Overpass API (OpenStreetMap road data)
```

**Server layout:**

```
server/
├── index.js
├── routes/          auth · network · sessions · export
├── algorithms/      convexHull · hillClimbing · zoneAssignment · tsp · dijkstra · verifier
├── services/        overpass · networkProcessor · cache · pipeline
├── websocket/       pipelineSocket
├── middleware/      rateLimit · auth · sanitize
└── db/              schema.sql · client · queries
```

**Client layout:**

```
client/
├── index.html
└── js/
    ├── main.js            global state (P, S★, zones, routes)
    ├── ui.js              Alpine.js component — all reactive data + interaction logic
    ├── map.js             Leaflet rendering, layer management
    └── websocket-client.js  WebSocket connection, message handlers, reconnection
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, vanilla JS, Tailwind CSS (CDN), Alpine.js (CDN), GSAP (CDN) |
| Map | Leaflet.js 1.9.4 + Leaflet.PolylineDecorator 1.6.0 |
| Tiles | OpenStreetMap (light) / CartoDB Dark Matter (dark mode) |
| Backend | Node.js 22, Express 4, ws (WebSocket) |
| Database | PostgreSQL via Supabase |
| External data | Overpass API (live OSM road network, with 3 fallback endpoints) |
| Auth | JWT (jsonwebtoken) + bcrypt password hashing |
| Export | pdfkit (PDF), json2csv (CSV) |
| Hosting | Render (Node.js service) |

---

## How to Run Locally

**Prerequisites:** Node.js 22+, a PostgreSQL database (Supabase free tier works), npm.

```bash
git clone https://github.com/GavinnMR/patrolpoint.git
cd patrolpoint
git checkout v2
npm install
```

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://user:pass@db.supabase.co:5432/postgres
JWT_SECRET=<64-byte hex string>
NODE_ENV=development
PORT=3000
DEMO_MODE=false
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Run the database schema (tables are created with `IF NOT EXISTS` — safe to run repeatedly):

The server applies `server/db/schema.sql` automatically on every boot, so no manual migration step is needed.

Start the server:

```bash
npm start
```

Open `http://localhost:3000`. The WebSocket connects automatically, the road network for Barangay Commonwealth loads, and the Recalculate button becomes active.

**Demo mode** (no auth, sessions, or export):

```env
DEMO_MODE=true
```

---

## Usage

1. **Select barangay** — type in the barangay selector; road network loads from cache or fetches live from Overpass
2. **Plot incidents** — click anywhere on the map to add a crime incident coordinate
3. **Set patrols** — enter the number of patrol units (max is computed from intersection count)
4. **Choose mode** — Stationary shows zone assignment lines; Roaming adds TSP road-following circuits
5. **Recalculate** — runs the pipeline on the server; each stage result streams in as it completes (Ctrl+Enter shortcut)
6. **Import** — paste bulk coordinates (one `lat, lng` per line) via the Import Coordinates section
7. **Settings** — adjust Hill Climbing restarts, outlier sensitivity, TSP zone cap, display toggles via the gear icon
8. **Export** — download a PDF or CSV report of the current deployment (requires login)
9. **Sessions** — view and reload previous pipeline runs (requires login)

---

## WebSocket Message Protocol

**Client → Server**

```javascript
{ type: 'compute', data: { incidents, n, mode, config, barangay } }
{ type: 'cancel' }
{ type: 'ping' }
```

**Server → Client**

```javascript
{ type: 'connected' }
{ type: 'network_loaded',    data: { barangay, nodeCount, edgeCount, intersectionCount, fromCache } }
{ type: 'pipeline_start',    data: { totalStages: 4, mode } }
{ type: 'stage_start',       data: { stage, name } }
{ type: 'stage_progress',    data: { stage, restart, iteration, patrolPositions, bestMinDist } }
{ type: 'stage_complete',    data: { stage, result, trace, runtimeMs } }
{ type: 'pipeline_complete', data: { hull, patrols, zones, routes, trace, totalRuntimeMs } }
{ type: 'warning',           data: { stage, message } }
{ type: 'error',             data: { stage, message, fatal } }
```

---

## Known Limitations

- **Overpass dependency** — loading a new barangay requires an Overpass API call (~2–10 s depending on barangay size). Commonwealth is cached server-side after first load.
- **Hill Climbing is heuristic** — patrol placement is not guaranteed globally optimal. The adaptive restart mechanism reduces but does not eliminate local-optima risk.
- **TSP zone cap** — zones are limited to 10 crime nodes (default) for tractability. Incidents beyond the cap are deprioritised and shown with grey markers.
- **No offline mode** — requires internet for OSM tiles, CDN scripts, and the server connection.
- **Single barangay at a time** — multi-barangay joint deployment planning is not yet supported.
