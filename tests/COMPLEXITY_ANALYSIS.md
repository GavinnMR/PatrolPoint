# PatrolPoint V2 Time Complexity Analysis

**Version:** 2.0.0
**Scope:** All algorithm stages, supporting infrastructure, and full pipeline worst-case derivation
**Algorithms covered:** Dijkstra, Convex Hull, Hill Climbing, Zone Assignment, Backtracking TSP, Verifier

---

## Table of Contents

1. [Variable Definitions](#1-variable-definitions)
2. [Supporting Infrastructure](#2-supporting-infrastructure)
   - [2.1 Haversine Distance](#21-haversine-distance)
   - [2.2 Binary Min-Heap](#22-binary-min-heap)
   - [2.3 Core Dijkstra (Single Source)](#23-core-dijkstra-single-source)
   - [2.4 All-Pairs Road Distance Matrix](#24-all-pairs-road-distance-matrix)
   - [2.5 Cached Dijkstra Runner](#25-cached-dijkstra-runner)
3. [Stage 1: Brute Force Convex Hull](#3-stage-1-brute-force-convex-hull)
   - [3.1 Incremental Hull Update](#31-incremental-hull-update)
   - [3.2 Outlier Detection](#32-outlier-detection)
   - [3.3 Collinearity Check](#33-collinearity-check)
   - [3.4 Brute Force Hull Computation](#34-brute-force-hull-computation)
   - [3.5 Edge Ordering](#35-edge-ordering)
   - [3.6 Shoelace Area and Winding Normalization](#36-shoelace-area-and-winding-normalization)
   - [3.7 Ray Casting Pre-Filter](#37-ray-casting-pre-filter)
   - [3.8 Stage 1 Overall](#38-stage-1-overall)
4. [Stage 2: Hill Climbing](#4-stage-2-hill-climbing)
   - [4.1 Single Patrol Special Case](#41-single-patrol-special-case)
   - [4.2 Neighbor Search](#42-neighbor-search)
   - [4.3 Minimum Pairwise Distance Helpers](#43-minimum-pairwise-distance-helpers)
   - [4.4 Per-Iteration Cost (Asynchronous Mode)](#44-per-iteration-cost-asynchronous-mode)
   - [4.5 Per-Iteration Cost (Synchronous Mode)](#45-per-iteration-cost-synchronous-mode)
   - [4.6 Restart Loop and Adaptive Convergence](#46-restart-loop-and-adaptive-convergence)
   - [4.7 Stage 2 Overall](#47-stage-2-overall)
5. [Stage 3: Zone Assignment](#5-stage-3-zone-assignment)
   - [5.1 Hull Diameter Computation](#51-hull-diameter-computation)
   - [5.2 Silent Snapping](#52-silent-snapping)
   - [5.3 Deduplication](#53-deduplication)
   - [5.4 Dijkstra Pre-Computation](#54-dijkstra-pre-computation)
   - [5.5 Initial Zone Assignment](#55-initial-zone-assignment)
   - [5.6 Zone Rebalancing](#56-zone-rebalancing)
   - [5.7 Zone Cap Enforcement](#57-zone-cap-enforcement)
   - [5.8 Stage 3 Overall](#58-stage-3-overall)
6. [Stage 4: Backtracking TSP](#6-stage-4-backtracking-tsp)
   - [6.1 Distance Matrix Construction](#61-distance-matrix-construction)
   - [6.2 k = 2 Shortcut](#62-k--2-shortcut)
   - [6.3 Nearest Neighbor Heuristic](#63-nearest-neighbor-heuristic)
   - [6.4 Backtracking TSP](#64-backtracking-tsp)
   - [6.5 Path-Aware Sequence Adjustment](#65-path-aware-sequence-adjustment)
   - [6.6 Path Segment Construction](#66-path-segment-construction)
   - [6.7 Overlap Detection](#67-overlap-detection)
   - [6.8 Stage 4 Overall](#68-stage-4-overall)
7. [Post-Pipeline Verifier](#7-post-pipeline-verifier)
   - [7.1 verifyConvexHull](#71-verifyconvexhull)
   - [7.2 verifyPatrolPositions](#72-verifypatrolpositions)
   - [7.3 verifyZoneAssignment](#73-verifyzonessignment)
   - [7.4 verifyTSPRoute](#74-verifytspRoute)
   - [7.5 Verifier Overall](#75-verifier-overall)
8. [Full Pipeline Worst-Case Analysis](#8-full-pipeline-worst-case-analysis)
   - [8.1 Per-Stage Dominant Terms](#81-per-stage-dominant-terms)
   - [8.2 Compound Worst-Case Expression](#82-compound-worst-case-expression)
   - [8.3 Numerical Substitution (Commonwealth Baseline)](#83-numerical-substitution-commonwealth-baseline)
   - [8.4 Which Stage Dominates](#84-which-stage-dominates)
9. [Summary Table](#9-summary-table)

---

## 1. Variable Definitions

Every expression in this document uses the following variables. Read this section before proceeding, because several variables have non-obvious meanings that differ from what you might assume.

| Variable | Meaning | Typical value (Commonwealth, n=10, p=5) |
|----------|---------|------------------------------------------|
| **n** | Number of incident points (crime locations) the user has plotted | 10 (demo), 1–300 (allowed range) |
| **p** | Number of patrol units (the `n` field the user sets in the UI; renamed here to avoid collision with `n` for incidents) | 1–100, practical max 30 for Commonwealth |
| **V** | Number of road network nodes in the loaded barangay graph | 3,593 (Commonwealth) |
| **E** | Number of road network edges in the loaded barangay graph | 4,091 (Commonwealth) |
| **C** | Number of valid candidate nodes — road nodes confirmed inside the convex hull by Ray Casting; C ≤ V | Varies: typically 200–2,000 depending on hull size |
| **h** | Number of convex hull vertices (the polygon's corner count); h ≤ n | 3–15 for typical incident clusters |
| **m** | Number of unique deduplicated snapped incident nodes entering Stage 3's distance pre-computation; m ≤ n | Equal to or slightly less than n |
| **R_b** | The base restart count parameter (config.hillClimbing.restarts); total restarts = R_b × p | 100 (default) |
| **I** | Maximum iterations per Hill Climbing restart (config.hillClimbing.maxIterations) | 1000 (default) |
| **k_i** | Number of crime nodes in patrol i's zone after capping; k_i ≤ k_max | 0–12 |
| **k_max** | Hard maximum crime nodes per zone (config.tsp.maxCrimeNodesPerZone) | 12 (default) |
| **N_r** | Average number of neighbor candidates within Hill Climbing search radius R for a single patrol position; N_r ≤ C | Problem-dependent, typically 50–300 |

**A note on graph sparsity:** For Commonwealth, E ≈ 1.14 × V, making it an extremely sparse graph. In the complexity expressions below, (V + E) ≈ 2V, so O((V + E) log V) ≈ O(V log V). For generality the full (V + E) form is used throughout.

**A note on C versus V:** In `'all'` candidate mode (the default), C = V — every road node is a potential patrol position. In `'intersection'` candidate mode, C is reduced to only nodes with three or more connections (914 for Commonwealth). The all-pairs road distance matrix is built over C nodes, not V, which makes the distinction significant for Stage 2.

---

## 2. Supporting Infrastructure

All distance computation in the project flows through two functions defined in `dijkstra.js`: the Haversine formula and the binary min-heap Dijkstra implementation. Every other algorithm file imports these rather than reimplementing them.

---

### 2.1 Haversine Distance

**What it computes:** The straight-line great-circle distance in meters between two geographic coordinates (latitude and longitude pairs).

**Why it cannot be O(1) replaced by Pythagorean distance:** Geographic coordinates are angles on a sphere. The Pythagorean theorem computes distance on a flat plane. At the scale of a barangay (roughly one to three kilometers across), using Pythagorean distance would introduce errors of 0.5–3% due to the Earth's curvature. The Haversine formula accounts for this correctly.

| Case | Complexity | Explanation |
|------|------------|-------------|
| Best | O(1) | Fixed sequence of arithmetic operations: two subtractions, two degree-to-radian conversions, four trigonometric function calls (sin, cos, asin), one square root, one multiplication. No loops, no recursion, no data structure access. |
| Average | O(1) | Same as best — the formula has no branches that change the number of operations based on input values. |
| Worst | O(1) | Same. The computation time is constant regardless of the magnitude or sign of the coordinates. |

In plain terms: haversine distance always takes the same amount of time regardless of how far apart the two points are. It is a pure arithmetic formula with no looping.

---

### 2.2 Binary Min-Heap

**What it is:** A tree-shaped data structure that keeps the smallest priority value at its root. Dijkstra's algorithm needs to repeatedly extract the node with the smallest tentative distance, and this data structure makes that fast.

**The critical optimization:** The heap stores a `position` map alongside its array — a lookup table from node ID to the node's current array index. Without this map, updating a node's priority (the `decreaseKey` operation) would require scanning the entire heap from the beginning to find that node, degrading it to O(n) per update. With the position map, the index is found in O(1), and the update runs in O(log n_heap) time.

Let n_heap denote the number of items currently in the heap (at most V for Dijkstra's algorithm).

| Operation | Best | Average | Worst | Explanation |
|-----------|------|---------|-------|-------------|
| `insert` | O(log n_heap) | O(log n_heap) | O(log n_heap) | Appends to end, then sifts upward. The sift path length is at most log₂(n_heap) — the height of the binary tree. |
| `extractMin` | O(log n_heap) | O(log n_heap) | O(log n_heap) | Removes root, moves last element to root, sifts downward. Path length at most log₂(n_heap). |
| `decreaseKey` | O(1) | O(log n_heap) | O(log n_heap) | Best case: the updated node is already at the root or its priority change requires zero sift steps. Worst case: the node sifts all the way from a leaf to the root. |

In plain terms: all heap operations take time proportional to the height of the tree, which grows logarithmically with the number of items. Doubling the heap size adds only one more level.

---

### 2.3 Core Dijkstra (Single Source)

**What it computes:** Given a starting node, finds the shortest road path distance from that starting node to every other reachable node in the graph simultaneously. One Dijkstra run answers all "how far from node A?" questions at once.

**How the complexity is derived:** The algorithm performs at most V `extractMin` operations (each node is extracted from the heap at most once) and at most E `decreaseKey` or `insert` operations (each edge is relaxed at most once, from each direction once). Each heap operation costs O(log V). Initialization (setting all distances to infinity) costs O(V). The total is therefore O(V log V + E log V) = O((V + E) log V).

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(V log V) | The graph is a tree (E = V − 1). Every edge is relaxed exactly once and at most V − 1 `decreaseKey` calls happen. The source is maximally close to all nodes (e.g., it is the center of a star graph), so every node's distance is finalized on its first extraction. |
| Average | O((V + E) log V) | A typical sparse road network like Commonwealth. E ≈ 1.14V, so this is approximately O(V log V). Not all edges cause a `decreaseKey` (distance is sometimes not improved), but on average most edges do. |
| Worst | O((V + E) log V) | A dense graph where every edge triggers a `decreaseKey` call. In the worst theoretical case with a fully connected graph, E = V(V−1)/2 and this becomes O(V² log V), but PatrolPoint's road networks are always sparse. |

In plain terms: Dijkstra is like spreading ripples from a dropped stone in water, always expanding to the next-nearest unvisited location. The binary heap ensures that finding "the nearest unvisited node" at each step takes logarithmic time rather than linear time. For Commonwealth's graph of 3,593 nodes and 4,091 edges, a single Dijkstra run completes in microseconds.

**Hull exterior penalty cost:** When the hull exterior penalty is active, each edge relaxation adds one Ray Casting test (O(h)) to check whether the edge's midpoint falls outside the hull. This changes the per-edge cost from O(log V) to O(h + log V). The total becomes O((V + E) × (h + log V)), which for small h is still dominated by O((V + E) log V).

---

### 2.4 All-Pairs Road Distance Matrix

**What it computes:** A complete lookup table of the shortest road distance between every pair of candidate nodes. This is the most expensive pre-computation step in the pipeline, run once before Stage 2 begins.

**Why it is needed:** Stage 2 (Hill Climbing) evaluates thousands of potential patrol moves per iteration, each requiring the road distance between two nodes. Without a pre-computed matrix, each distance lookup would require a fresh Dijkstra run. With the matrix, each lookup is a single array index access in O(1).

**The key insight:** A single Dijkstra run from one source node gives the distances from that source to all other nodes simultaneously. To build a complete C × C matrix, the system only needs to run Dijkstra once per source node — C total runs — not once per pair. This is C runs rather than C² runs.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(C × (V + E) log V) | C is small (incidents clustered in a tiny area of the barangay, hull encloses few road nodes). Cannot be reduced below C Dijkstra runs regardless of graph structure. |
| Average | O(C × (V + E) log V) | Typical deployment scenario. C depends on hull size relative to the barangay. |
| Worst | O(C × (V + E) log V) with C = V | In `'all'` candidate mode with the hull covering the entire barangay, C = V and the expression becomes O(V × (V + E) log V) ≈ O(V² log V) for sparse graphs. For Commonwealth: O(3,593² × log 3,593) ≈ O(1.5 × 10⁸). |

**Memory cost:** The resulting matrix has C × C entries, each an 8-byte floating-point number. For Commonwealth in `'all'` mode: 3,593 × 3,593 × 8 bytes ≈ 103 MB. In `'intersection'` mode: 914 × 914 × 8 bytes ≈ 6.7 MB.

In plain terms: building the road distance matrix is the most expensive single step before Stage 2. It trades a large upfront cost for instantaneous distance lookups throughout the hundreds-of-thousands of iterations that follow.

---

### 2.5 Cached Dijkstra Runner

**What it does:** Wraps the core Dijkstra function with a result cache keyed by source node ID. If Dijkstra has already been run from a given source node, the cached result is returned immediately without recomputation.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(1) | Cache hit — the result for this source node was already computed by a previous stage or a previous call in the same stage. |
| Average | Mixed — varies by cache population at time of call | Early in the pipeline most calls are misses; later calls from Stage 4 enjoy high hit rates because Stage 3 already ran Dijkstra from all snapped incident nodes. |
| Worst | O((V + E) log V) | Cache miss — first call from this source node in the current pipeline run. |

The cache persists across Stages 3 and 4 within a single pipeline run. Stage 4 automatically benefits from every Dijkstra call Stage 3 already made, typically achieving near-100% cache hit rates for patrol-to-incident pairs that both stages need.

---

## 3. Stage 1: Brute Force Convex Hull

**What it computes:** The smallest convex polygon (the convex hull) that contains all incident locations. This polygon is the "danger zone" — it defines the boundary within which all patrol placement and routing must occur.

The stage consists of several sequential sub-procedures. Each sub-procedure runs only if the previous one does not trigger an early exit. Understanding each sub-procedure's cost separately is important because the overall stage complexity is the maximum of the costs of all sub-procedures that actually execute, not their sum (since exits can short-circuit later steps).

---

### 3.1 Incremental Hull Update

**What it does:** Before any computation, Stage 1 checks whether the previous hull from the last pipeline run can be reused. If all new incident points fall inside the existing hull, the boundary does not need to change.

This check runs only when `previousHull` and `previousValidCandidates` are provided (all runs except the very first one).

**Finding new points:** The system scans every current incident against every previous incident to identify which points are new. This is a pairwise coordinate comparison.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(1) | The incident set is identical to the previous run (no additions, no removals). The system detects this in O(n) and returns the previous hull immediately. **Correction: this is O(n × n_prev) ≈ O(n²) to confirm identity, not O(1).** However if implemented with an early-exit on the first new point found, a truly identical set confirms with O(n) total comparisons. O(n²) is the conservative bound. |
| Average | O(n² + n_new × h) | n_new new points are identified (O(n × n_prev) ≈ O(n²) pairwise comparisons), and each new point is tested against the hull by Ray Casting (O(h) per point). If all are inside, the function returns early. |
| Worst | O(n²) | All incidents are new (first run when previousIncidents was not stored). The conservative fallback tests every current incident against the hull, requiring n Ray Casts each costing O(h). Total: O(n × h) ≤ O(n²). The O(n²) bound comes from the pairwise comparison of n current against n previous incidents. |

In plain terms: if you add new incidents to the interior of an existing danger zone without moving or removing previous ones, Stage 1 returns immediately with the old result. Only when new incidents expand the boundary does the full O(n³) computation run.

---

### 3.2 Outlier Detection

**What it does:** Flags incidents whose distance from the cluster centroid exceeds `outlierMultiplier × averageDistance`. Only runs when `config.convexHull.includeOutliers` is `false` (it is `true` by default, making this step a no-op in default configuration).

The algorithm makes one pass to compute the centroid (average position), a second pass to compute the average distance, and a third pass to flag outliers. All three passes iterate over n incidents exactly once.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(1) | `includeOutliers` is `true` (default). The step is skipped entirely. |
| Average | O(n) | `includeOutliers` is `false`. Three sequential O(n) passes over the incident array. |
| Worst | O(n) | Same as average — no branching changes the number of passes. |

In plain terms: outlier detection is a constant number of linear scans. It is never the bottleneck.

---

### 3.3 Collinearity Check

**What it does:** Determines whether all remaining incident points fall on a single straight line, which would make polygon construction impossible.

The algorithm fixes two anchor points A and B (the first two incidents) and computes the cross product of vectors AB and AC for each remaining point C. If the cross product magnitude is below the collinearity epsilon threshold for every C, all points are collinear.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(1) | The third incident point (index 2) is already non-collinear with A and B. The check exits immediately after testing C = filtered[2]. |
| Average | O(n) | A moderate number of points must be checked before one is found to be non-collinear. |
| Worst | O(n) | All n incidents are collinear (the linear handler fires). Every point is checked before the conclusion is reached. |

In plain terms: in the best case, the very first non-anchor point being off-line terminates the check immediately. In the worst case (all incidents along one road), every point is tested.

---

### 3.4 Brute Force Hull Computation

**What it does:** For every ordered pair of incident points (pi, pj), tests whether all other points pk lie on the left side of the directed edge from pi to pj. An edge belongs to the hull boundary if and only if all other points satisfy this condition. Collecting all valid edges gives the complete set of hull boundary edges.

**Why brute force and not Graham Scan (O(n log n)):** The classic Graham Scan algorithm and similar approaches require careful handling of degenerate cases (collinear points, near-collinear configurations, floating-point edge cases). The brute force approach is O(n³) but for n ≤ 30 this is completely imperceptible — 30³ = 27,000 cross-product evaluations. The brute force implementation is simpler to verify for correctness and matches the academic demonstration goals of this project.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(n³) | The algorithm cannot short-circuit the outer loops. For each of the O(n²) ordered pairs, all remaining O(n) points must be tested before an edge can be confirmed or rejected as a hull edge. Even when an edge is immediately invalidated by the first point tested, the outer loops still require O(n²) iterations. |
| Average | O(n³) | Same structure. The constant factor may be slightly smaller on average if inner loop exits early on rejection, but the asymptotic bound remains O(n³). |
| Worst | O(n³) | All n points lie on the hull boundary (e.g., points placed on a circle). Every directed edge is a valid hull edge, and every inner-loop test reaches its conclusion. This maximizes the work per pair (no early rejection). |

In plain terms: the brute force approach tries every possible directed edge between every pair of points and checks whether all other points agree on which side they are. With n = 30 incidents, this is 30 × 29 × 28 = 24,360 cross-product evaluations — a negligible amount for modern hardware.

---

### 3.5 Edge Ordering

**What it does:** The valid hull edges from Step 4 are an unordered set. This step chains them into a connected polygon by repeatedly finding the next edge whose start point matches the end point of the last edge placed.

The algorithm starts with one edge and then performs a linear scan of the remaining edges to find the next connecting edge. This is repeated for each of the h hull vertices.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(h) | Each successive edge is found at the beginning of the remaining list (position 0 in the scan). Total comparisons: h + (h−1) + ... = O(h). This is extremely unlikely in practice. |
| Average | O(h²) | On average, the next connecting edge is found at the midpoint of the remaining list. Total comparisons: roughly h × h/2 = O(h²). |
| Worst | O(h²) | Each successive edge is found at the end of the remaining list. Total comparisons: h × (h−1) × ... ≈ O(h²). Since h ≤ n, this is O(n²). |

In plain terms: for typical incident clusters with 3–15 hull vertices, edge ordering is negligibly fast even in the worst case (at most 225 comparisons for h = 15).

---

### 3.6 Shoelace Area and Winding Normalization

**What it does:** Computes the signed area of the hull polygon using the Shoelace formula (a single pass over all h hull vertices), then reverses the vertex list if the signed area is negative (clockwise winding), normalizing all polygons to counter-clockwise winding for consistent Ray Casting behavior.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(h) | The area pass is always O(h). If the hull is already counter-clockwise, no reversal is needed. |
| Average | O(h) | Same. The reversal, when needed, is also O(h). |
| Worst | O(h) | Both the area pass and the reversal run: O(h) + O(h) = O(h). |

In plain terms: this step is always linear in the number of hull vertices and is never the bottleneck.

---

### 3.7 Ray Casting Pre-Filter

**What it does:** Determines which of the V road network nodes fall inside the hull polygon. These become `validCandidates` — the set of eligible positions for patrol placement in Stage 2.

**Two-step filter:** A bounding box pre-filter is applied first. The hull's axis-aligned bounding rectangle is computed in O(h), and then each node is tested against it in O(1). Only nodes that pass the bounding box check are tested with the full Ray Casting algorithm (O(h) per node). This optimization is significant: for a hull that covers 30% of the barangay, roughly 70% of nodes are rejected by the faster bounding box test.

`rayCast(point, hull)` casts an imaginary horizontal ray rightward from the test point and counts how many times it crosses the hull boundary. An odd number of crossings means the point is inside. Each crossing test examines one hull edge, so the total cost per Ray Cast is O(h) edge checks.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(V + h) | The hull is tiny (covers almost no area). The bounding box pre-filter eliminates all V nodes in O(1) each after O(h) setup. Zero full Ray Casts are run. |
| Average | O(V × h) | A fraction f of nodes pass the bounding box and are tested with Ray Casting. Total: O(h) bbox setup + O(V) bbox tests + O(f × V × h) Ray Casts. Since f is a constant in (0, 1), this is O(V × h). |
| Worst | O(V × h) | The hull exactly matches the barangay boundary (covers 100% of the area). Every node passes the bounding box and is tested with Ray Casting. Total: O(h) + O(V × h) = O(V × h). With Commonwealth's h ≤ n ≤ 30 and V = 3,593: O(107,790) operations. |

**Hull-candidate cache:** When the hull vertices are unchanged from the last run (detected by a vertex-by-vertex comparison in O(h)), the previously computed candidates are returned immediately without repeating Ray Casting. This reduces subsequent identical-hull runs to O(h) for the equality check.

In plain terms: the Ray Casting pre-filter is the dominant cost of Stage 1 in practice (not the O(n³) hull computation), because V >> n at barangay scale. Checking 3,593 nodes against a polygon with up to 30 vertices requires at most 107,790 operations — still extremely fast in absolute terms.

---

### 3.8 Stage 1 Overall

Stage 1 can exit early at several points (incremental check, outlier filter below 3 points, linear handler, edge ordering failure). The complexity below describes the full computation path when all steps complete.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(n² + n × h) | Incremental check finds all new incidents inside previous hull. New-point identification costs O(n²) pairwise comparison; each new point's Ray Cast costs O(h). Returns with previous hull and candidates — skips all remaining steps. |
| Average (no previous hull) | O(n³ + V × h) | Full brute force computation dominates (O(n³)), followed by Ray Cast pre-filter (O(V × h)). For typical deployments with n ≤ 30 and V = 3,593, the V × h term often exceeds n³ numerically: 30 × 3,593 = 107,790 vs 30³ = 27,000. |
| Worst | O(n³ + V × h) | Same as average when no previous hull exists. Since h ≤ n: O(n³ + V × n). |

---

## 4. Stage 2: Hill Climbing

**What it computes:** The positions of p patrol units on the road network inside the hull, chosen to maximize the minimum pairwise road distance between any two patrols. Patrols spread out as widely as possible while staying on actual roads.

Stage 2 uses a multi-restart Hill Climbing algorithm: randomly place p patrols, iteratively move each to a better neighboring position, record the result, and repeat from a different random starting configuration. The best result across all restarts is the final answer.

---

### 4.1 Single Patrol Special Case

**What it does:** When p = 1, Hill Climbing is skipped entirely. The single patrol is placed at the road node with the smallest average road distance to all other valid candidates — the most central accessible node. This requires a full matrix scan.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(C²) | Must evaluate every candidate (C nodes) against every other candidate (C lookups each) using the pre-computed road distance matrix. No short-circuiting is possible — the minimum average distance cannot be known without checking all C candidates. |
| Average | O(C²) | Same as best. The structure is a double loop with no early exit. |
| Worst | O(C²) | Same. The second loop (average distance computation) always runs C iterations regardless of candidate positions. |

In plain terms: for a single patrol, the algorithm scans the entire candidate set to find the geographic center of the road network inside the danger zone. This is the only case where Hill Climbing itself is not run.

---

### 4.2 Neighbor Search

**What it does:** For each patrol position during an iteration, `findNeighbors` finds all unoccupied valid candidate nodes within road distance R of the current patrol position.

Using the pre-computed road distance matrix (built by `buildRoadDistMatrix` before Stage 2), each distance lookup is O(1). The function scans all C valid candidates, checks whether each is unoccupied by another patrol, and tests whether the matrix distance is within R.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p) | The search radius R is very small and only the p occupied positions are near enough to be checked (all immediately excluded as occupied). In practice, R is set to cover multiple candidates by design. |
| Average | O(C) | Must scan all C candidates in the worst case of the pre-filter (no spatial index is used; the matrix row is scanned linearly). With a typical R covering N_r candidates: effectively O(C) since the matrix row always has C entries. |
| Worst | O(C) | All C candidates fall within R (very large search radius). All C entries in the matrix row are read. |

In plain terms: finding neighbors is always a linear scan of the candidate list using pre-computed distances. The cost scales with C regardless of how many neighbors are actually found.

---

### 4.3 Minimum Pairwise Distance Helpers

**`globalMinPairwiseDist`:** Computes the minimum pairwise road distance across all p(p−1)/2 pairs of patrol positions using the road distance matrix.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p²) | Must check all pairs — no early exit is possible since finding the minimum requires seeing all values. |
| Average | O(p²) | Same double loop structure. |
| Worst | O(p²) | Same. |

**`minPairwiseExcluding`:** Computes the minimum pairwise distance among all pairs that do not involve the current patrol. This is used once per patrol per iteration, before evaluating its neighbors.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p²) | Same structure as globalMinPairwiseDist, minus pairs involving the excluded patrol index. Still O(p²) since the nested loop runs (p−1)(p−2)/2 iterations. |
| Average | O(p²) | Same. |
| Worst | O(p²) | Same. |

**Why `minPairwiseExcluding` is precomputed once per patrol per iteration:** Each neighbor evaluation needs to compute the new global minimum if the current patrol moved to that neighbor. That new minimum equals `min(minExcludingSi, distanceFromNeighborToAllOtherPatrols)`. The first term is the same for all neighbors of patrol i, so computing it once and reusing it reduces per-neighbor work from O(p²) (all pairs) to O(p) (only distances from neighbor to other patrols).

---

### 4.4 Per-Iteration Cost (Asynchronous Mode)

**What it does:** In the default asynchronous mode, patrols are processed in a randomly shuffled order each iteration. Each patrol moves to the best available neighboring node given the positions of all patrols that have already moved earlier in this iteration's shuffled order.

**Per patrol, per iteration:**
1. `findNeighbors`: O(C) to scan all candidates
2. `minPairwiseExcluding`: O(p²) to compute baseline
3. For each of at most N_r ≤ C neighbor candidates: compute minimum distance from that candidate to all p−1 other patrols: O(p) matrix lookups
4. Move to best neighbor: O(1)

Total per patrol: O(C + p² + N_r × p) = O(N_r × p + p²)

Since N_r ≤ C and typically N_r << C (only a fraction of candidates are within radius R), the per-patrol cost is O(C + N_r × p + p²). For large C and moderate p, O(C) from the neighbor scan dominates the matrix row read.

**Per iteration (p patrols):**

```
T_iteration = p × (C + p² + N_r × p)
            = O(p × C + p³ + N_r × p²)
            ≈ O(C × p)    when C >> p² (typical for small p)
               or O(p³)   when p² >> C (large patrol counts)
```

In plain terms: each iteration requires, for every patrol, one scan of the entire candidate list and one inner loop over all other patrol distances. The per-iteration cost grows cubically with the number of patrols and linearly with the candidate count.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p × (C + N_r × p + p²)) with N_r = 0 | All patrols have no neighbors within R (radius too small). This triggers a radius expansion and sets anyPatrolMoved = true, so the iteration count still progresses. Effective per-iteration cost: O(p × C) for p neighbor scans that all return empty. |
| Average | O(p × (C + N_r × p + p²)) | Typical N_r neighbors found per patrol. |
| Worst | O(p × (C + C × p + p²)) = O(p² × C) | All C candidates fall within R for every patrol. Each of p patrols evaluates all C neighbors at O(p) cost each. Total: O(p × C × p) = O(p² × C). |

---

### 4.5 Per-Iteration Cost (Synchronous Mode)

**What it does:** In synchronous mode, Phase 1 computes the proposed best move for every patrol using only the current (pre-iteration) positions, without any patrol seeing another's movement. Phase 2 then applies all non-conflicting moves simultaneously.

**Phase 1 cost:** Identical to asynchronous mode — O(p × (C + p² + N_r × p)). The computation structure is the same; the difference is that earlier patrols in the shuffled order do not affect later patrols' computations.

**Phase 2 cost:** For each of p patrols, check whether its proposed move conflicts with a higher-priority patrol's target. O(p) total.

**One additional call:** `globalMinPairwiseDist` is called once per iteration (not once per patrol as in async mode): O(p²).

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p × (C + N_r × p + p²)) | Same structure as async mode. |
| Average | O(p² × C) | Same dominant term as async mode. |
| Worst | O(p² × C) | Same. Synchronous mode does not change the asymptotic bound — the additional `globalMinPairwiseDist` call adds O(p²) which is dominated by O(p² × C) for C > 1. |

In plain terms: synchronous and asynchronous modes have the same time complexity class. Synchronous mode is sometimes slower in practice because it makes fewer net progress moves per iteration (conflicting moves are discarded), requiring more iterations to converge.

---

### 4.6 Restart Loop and Adaptive Convergence

**Total restart budget:** `maxRestarts = R_b × p` where R_b is the per-patrol restart count from the configuration (default 100). The minimum number of restarts that will always run is `minRestarts = max(5, p)`.

**Adaptive convergence check:** After each restart (once `allRestartResults.length ≥ minRestarts`), the algorithm checks whether the last three restart scores are within 0.1% of each other. If so, the restart loop exits early. In the best case, convergence triggers after exactly minRestarts restarts. In the worst case, all R_b × p restarts run without converging.

**Per-restart cost breakdown:**
1. Fisher-Yates initialization shuffle: O(C) to shuffle all C candidates; O(p) to slice first p
2. Iteration loop: O(I_actual × p² × C) where I_actual ≤ I (maxIterations)
3. Post-restart bookkeeping (convergence check, duplicate detection): O(R_completed × p) total across all restarts

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(minRestarts × I_min × p² × C) = O(p × 1 × p² × C) = O(p³ × C) | Adaptive convergence triggers immediately after minRestarts = max(5, p) restarts. Each restart converges in 1 iteration (patrols are already at optimal positions from initialization, which is theoretically possible but practically unlikely). |
| Average | O(R_avg × I_avg × p² × C) | Some restarts converge quickly, others take many iterations. R_avg << R_b × p due to adaptive convergence. I_avg << I due to early-convergence within restarts. |
| Worst | O(R_b × p × I × p² × C) = O(R_b × I × p³ × C) | All R_b × p restarts run to the full I iteration limit without adaptive convergence triggering. No restart improves the result after the first, but the 0.1% tolerance check never fires (e.g., because all restarts find different suboptimal answers with more than 0.1% spread). |

**Adding the pre-computation cost:** `buildRoadDistMatrix` runs before Stage 2 and costs O(C × (V + E) log V).

**Stage 2 total worst case:**

```
T_Stage2 = O(C × (V + E) log V)    [pre-computation]
         + O(R_b × I × p³ × C)      [restart loop]
```

In plain terms: Stage 2 is the most expensive stage in the pipeline. The total restart loop cost scales cubically with the number of patrols and linearly with the number of candidates and the product of the restart and iteration budgets. With default settings (R_b = 100, I = 1000), the coefficient is 10^5 — making the mathematical worst case very large, but adaptive convergence ensures practical runtimes are far smaller.

---

### 4.7 Stage 2 Overall

| Case | Complexity | Notes |
|------|------------|-------|
| Best (p = 1) | O(C²) | Single patrol special case — no restarts, no iterations. Scan all C candidates for the most central node. |
| Best (p > 1) | O(C × (V+E) log V + p³ × C) | Pre-computation dominates; min restarts each converge in 1 iteration. |
| Average | O(C × (V+E) log V + R_avg × I_avg × p³ × C) | Adaptive convergence fires before max restarts; iterations per restart are well below I. |
| Worst | O(C × (V+E) log V + R_b × I × p³ × C) | No early convergence, all restarts reach maxIterations. Defaults: O(C × V log V + 10⁵ × p³ × C). |

---

## 5. Stage 3: Zone Assignment

**What it computes:** Assigns each incident location to exactly one patrol unit based on road network distance. The patrol with the shortest road route to a given incident is assigned responsibility for that incident's area.

---

### 5.1 Hull Diameter Computation

**What it does:** Computes the maximum Haversine distance between any two hull vertices. This value is used as the upper bound for snapping search radius expansion — if no candidate node is found within the hull diameter, the incident is excluded.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(h²) | Must check all h(h−1)/2 pairs. No early exit is possible since the maximum cannot be known without checking all pairs. |
| Average | O(h²) | Same. |
| Worst | O(h²) | Same. Since h ≤ n ≤ 30 in practice: at most 435 Haversine distance computations. This is negligible. |

---

### 5.2 Silent Snapping

**What it does:** Maps each incident's clicked position to the nearest valid road node inside the hull. The word "silent" means this mapping is invisible to the user — the incident marker stays at the clicked position on the map.

**Search mechanism:** For each incident, a bounding box of side 2 × searchRadius is applied to filter candidates quickly. Among remaining candidates, Haversine distance is computed to find the nearest. If no candidate is within `initialSearchRadiusMeters` (default 500m), the radius expands by 50% and the search retries. Expansion continues until either a candidate is found or the radius exceeds the hull diameter.

**Per incident:** Let F denote the fraction of C candidates that pass the initial bounding box filter (F ≤ 1). The cost is O(C × F) Haversine computations. In the worst case F = 1 (all candidates within the bounding box): O(C). The number of radius expansion steps is bounded by the number of times 500m can be multiplied by 1.5 before reaching the hull diameter: O(log₁.₅(hullDiam / 500)) ≈ O(log hullDiam). Each expansion repeats the O(C) scan.

| Case | Complexity (per incident) | What causes it |
|------|--------------------------|----------------|
| Best | O(C) | The first radius attempt finds a candidate without expansion. |
| Average | O(C) | Same — most incidents are plotted near roads and snap without radius expansion. |
| Worst | O(C × log(hullDiam / 500)) | Incident is far from all roads; requires multiple radius expansions. Each expansion retries the O(C) scan. |

**For all n incidents:** O(n × C) average, O(n × C × log(hullDiam / 500)) worst case.

---

### 5.3 Deduplication

**What it does:** If two incidents snap to the exact same road node, only the first is kept for routing purposes (both visual markers remain on the map). Implemented with a hash map from snapped node ID to the first incident.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(m) | Single pass over m snapped nodes; hash map lookups are O(1) amortized. |
| Average | O(m) | Same. |
| Worst | O(m) | Same. All n incidents snap to distinct nodes (no merges); the hash map grows to size m = n. |

---

### 5.4 Dijkstra Pre-Computation

**What it does:** For each of the m unique snapped nodes (after deduplication), runs Dijkstra from that node to get road distances to every other node in the graph simultaneously — including all p patrol positions. This builds the distance matrix `distanceMatrix[snappedNodeId][patrolIndex]` used by zone assignment and rebalancing.

**Cache interaction:** This step uses the shared `dijkstraCache` object, which is also used by Stage 4. At the start of Stage 3, this cache is always empty (it is initialized fresh for each pipeline run). All m Dijkstra calls in Stage 3 are therefore cache misses. However, Stage 4 inherits all m cached results, enabling near-100% hit rates there.

**Important distinction:** This is a different cache from the one used by `buildRoadDistMatrix`. That function uses its own local, temporary cache. The dijkstraCache shared between Stages 3 and 4 is initialized separately before Stage 3 begins.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(m × (V+E) log V) | All m calls are cache misses (cache is empty at start of Stage 3). Cannot be improved — each source node requires one full Dijkstra run. |
| Average | O(m × (V+E) log V) | Same — no hits possible on the first pipeline run. |
| Worst | O(m × (V+E) log V) with m = n | All incidents snap to distinct nodes (no deduplication). Up to n Dijkstra runs. |

In plain terms: Stage 3's Dijkstra pre-computation is the dominant cost within this stage. For Commonwealth with n = 20 incidents: at most 20 Dijkstra runs, each traversing 3,593 nodes and 4,091 edges. This is fast in absolute terms but scales directly with the incident count.

---

### 5.5 Initial Zone Assignment

**What it does:** For each of the m deduplicated incident nodes, looks up its road distance to each of the p patrols in the pre-computed distance matrix and assigns it to the nearest patrol.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(m × p) | One pass over m nodes, p distance lookups each: O(1) matrix access per lookup. |
| Average | O(m × p) | Same structure. |
| Worst | O(m × p) | Same. No branching changes the number of operations; the Haversine fallback (triggered when all distances are Infinity) also costs O(m × p) in the worst case. |

---

### 5.6 Zone Rebalancing

**What it does:** Adjusts zone sizes after initial assignment when some patrols have far more incidents than others.

**Light rebalancing (default):** Runs for at most 10 iterations. Each iteration identifies the largest and smallest non-empty zones (O(p) scan), finds boundary incidents in the largest zone (O(zone size × p) matrix lookups), and moves one incident. Maximum total iterations: 10.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p) | The zone sizes are already balanced (largest ≤ 2 × mean AND smallest ≥ 0.5 × mean). The condition check at the top of the loop exits immediately. |
| Average | O(m × p) | A few iterations run; each scans the largest zone (size up to m) against p patrols. With 10 maximum iterations, the constant factor is bounded: O(10 × m × p) = O(m × p). |
| Worst | O(m × p) | All 10 iterations run with worst-case zone sizes. Each iteration's boundary search scans up to m nodes. Total: O(10 × m × p) = O(m × p). |

**Strong rebalancing (opt-in):** Runs for at most m iterations total (cannot need more moves than there are nodes). Each iteration scans overloaded zones × underloaded patrols × zone nodes to find the cheapest move.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(m × p) | Zones are already balanced. Zero iterations; only the initial balance check runs: O(p). Actually O(m × p) is the cost per iteration, and 0 iterations means O(p) overhead only. |
| Average | O(m² × p / n_unbalanced) | A fraction of nodes need reassignment. Total iterations are bounded by the total imbalance. |
| Worst | O(m² × p) | All m nodes need reassignment (maximally unbalanced start state). Each of m iterations scans up to O(m × p) candidates for the cheapest move. Total: O(m × m × p) = O(m² × p). |

---

### 5.7 Zone Cap Enforcement

**What it does:** Enforces a hard limit of k_max incidents per zone. For zones exceeding this limit, incidents are sorted by road distance to their assigned patrol and the farthest ones are removed.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p) | All zones are within the cap. One size check per zone: O(p). |
| Average | O(m log m) | At most one or two zones exceed the cap and are sorted. Sorting a zone of size k: O(k log k). Total: O(m log m) across all zones. |
| Worst | O(m log m) | All p patrols have zones at or exceeding k_max. Sorting each zone: O(k_max log k_max). Total: O(p × k_max log k_max) ≤ O(m log m) since Σk_i = m. |

---

### 5.8 Stage 3 Overall

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(n × C + m × (V+E) log V + m × p) | Snapping (O(n × C)), Dijkstra pre-computation (O(m × (V+E) log V)), zone assignment (O(m × p)). Light rebalancing exits immediately. No zone cap triggers. |
| Average | O(n × C + m × (V+E) log V + m × p) | Same dominant terms. Light rebalancing adds O(m × p) which is already present. |
| Worst | O(n × C × log(hullDiam) + m × (V+E) log V + m² × p) | Snapping with repeated radius expansions (O(n × C × log(hullDiam))), Dijkstra for all m nodes (O(m × V log V)), and strong rebalancing with maximum reassignments (O(m² × p)). The Dijkstra term typically dominates. |

Simplification: since m ≤ n and C ≤ V, the overall Stage 3 worst case is O(n × (V + E) log V + n² × p).

---

## 6. Stage 4: Backtracking TSP

**What it computes:** For each patrol unit in roaming mode, the shortest closed walking circuit that starts at the patrol's position, visits every incident in its assigned zone exactly once, and returns to the starting position. Routes follow actual road segments from the Dijkstra path reconstruction.

This is the Travelling Salesman Problem (TSP) — one of the most studied problems in computer science. The number of possible visit orderings for k incidents grows as k! (k factorial), which is why the system caps zones at k_max = 12 and uses a heuristic fallback for larger zones.

---

### 6.1 Distance Matrix Construction

**What it does:** For each patrol's zone, builds a local distance matrix D covering the patrol's starting node and all its k_i assigned incident nodes. This requires k_i + 1 Dijkstra calls in the worst case (one per unique source node).

**Cache interaction with Stage 3:** Stage 3 ran Dijkstra from each snapped incident node, populating the shared dijkstraCache. Stage 4 builds its distance matrix by calling Dijkstra from both the patrol's starting node and the incident nodes. The incident nodes are typically already cached (cache hit). The patrol starting node is a new source if it was not itself a snapped incident node, requiring one fresh Dijkstra run per patrol.

| Case | Complexity (per zone) | What causes it |
|------|----------------------|----------------|
| Best | O(k_i) | Patrol position and all incident positions are already in cache from Stage 3. O(1) per distance lookup. |
| Average | O((V+E) log V + k_i) | One cache miss (patrol position is new) + k_i cache hits. |
| Worst | O((k_i + 1) × (V+E) log V) | All source nodes are cache misses (e.g., when hull exterior penalty is active and a fresh local cache is used). |

**For all p patrols:** O(p × (V+E) log V) worst case (one fresh Dijkstra per patrol position) + O(m) for cache hits on incident nodes.

---

### 6.2 k = 2 Shortcut

**What it does:** When a zone has exactly 2 incidents, both possible visit orders (A → B → return, B → A → return) produce the same total circuit distance on an undirected graph with symmetric road distances. The system takes the first ordering without computing the second.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(1) | Three distance lookups in D: D[start][A], D[A][B], D[B][start]. All are O(1) matrix accesses. |
| Average | O(1) | Same. |
| Worst | O(1) | Same. |

---

### 6.3 Nearest Neighbor Heuristic

**What it does:** When k_i exceeds `nearestNeighborFallbackThreshold` (default 12), the system uses a greedy algorithm: always visit the nearest unvisited incident from the current position.

The algorithm makes k_i passes. In each pass, it scans all unvisited incidents to find the nearest one. The first pass scans k_i incidents, the second scans k_i − 1, and so on.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(k_i²) | Must scan all unvisited nodes at each step. Even if the nearest node happens to be the first examined every time, the scan still visits all remaining candidates. |
| Average | O(k_i²) | Same structure. |
| Worst | O(k_i²) | Same. The number of comparisons is: k_i + (k_i − 1) + ... + 1 = k_i(k_i + 1)/2 = O(k_i²). |

In plain terms: the nearest neighbor heuristic is a greedy algorithm that builds the route one step at a time by always choosing the closest unvisited stop. It is not guaranteed to be optimal, but it is fast and reliably produces reasonable routes. With the default k_max = 12, this heuristic never fires in standard operation (since zones are capped at 12 before Stage 4 begins, and the fallback threshold is also 12).

---

### 6.4 Backtracking TSP

**What it does:** Finds the guaranteed optimal visit ordering for up to k_max incident nodes by exhaustively exploring all possible orderings with branch-and-bound pruning.

**Recursion structure:** The `backtrack` function builds the visit sequence one node at a time. At each level of the recursion tree, it tries all unvisited nodes as the next stop. If the accumulated distance so far already equals or exceeds the best complete circuit found so far (`bestCircuit`), the branch is discarded immediately (the pruning condition).

**Worst-case tree size:** Without pruning, the recursion tree has k! leaves. With pruning, many branches are cut early, but the pruning effectiveness depends on the structure of the distance matrix.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(k_i) | The first path explored happens to be optimal. All subsequent branches are immediately pruned because their accumulated distance already meets or exceeds the optimal value. Only the k_i steps of the first path are evaluated. This requires the optimal tour to be found on the first depth-first traversal — unlikely in practice but theoretically possible. |
| Average | Substantially sub-O(k_i!) | In practice on road networks with realistic distance distributions, pruning eliminates the majority of branches. Empirical observation: for typical k_i = 6–10, the algorithm explores a fraction of k_i! branches. The exact average depends on the spread of distances in D. |
| Worst | O(k_i!) | All k_i! orderings are fully explored before any is pruned. This occurs when all distances in D are nearly equal, making pruning ineffective — each complete circuit costs approximately the same, so no early bound tightening occurs. With k_max = 12: 12! = 479,001,600 leaf evaluations. Each leaf evaluation includes O(k_i) comparisons to compute the return leg. Total worst-case: O(k_i × k_i!) = O(13!). |

**Pruning mechanism in detail:** Before recursing deeper, the algorithm checks `if accumulated >= bestCircuit`. Here, `accumulated` is the sum of all edge distances on the partial route so far, and `bestCircuit` is the best total circuit found so far (initialized to Infinity). This pruning is effective because:
1. As more complete circuits are found, `bestCircuit` decreases, tightening the pruning bound.
2. Routes with expensive early edges are cut before their full cost is known.
3. The first complete route (found at depth k_i) establishes the initial upper bound that enables pruning of all subsequent branches.

In plain terms: backtracking TSP is like trying all possible tour orderings, but crossing off any partial tour the moment its cost exceeds the best complete tour found so far. For small k_i (2–4 incidents), nearly all branches are pruned immediately. For larger k_i approaching 12, more branches survive to completion. The factorial scaling makes this approach impractical for k_i > 12–15.

---

### 6.5 Path-Aware Sequence Adjustment

**What it does:** After TSP produces a visit order, `adjustSequence` checks whether any incident node appears as an intermediate waypoint on the Dijkstra road path between two consecutive scheduled stops. If so, it moves that incident to its natural position in the circuit rather than visiting it separately later.

**Algorithm structure:** The function iterates over the circuit in passes until no adjustment is made in a full pass. For each consecutive pair of stops (from, to) in the circuit, it retrieves the Dijkstra path from `from` to `to` (O(V) path reconstruction) and checks whether any unvisited incident lies on that path. If found, the incident is moved to immediately after `from` in the sequence.

At most k_i adjustments can occur (each adjustment reduces the number of remaining incidents to check), so at most k_i passes are needed.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(k_i) | No adjustments needed. One pass over the circuit with zero matches found. Each path lookup from cache: O(V) reconstruction. Total: O(k_i × V) for the full circuit check. Written as O(k_i × V) since no further passes occur. |
| Average | O(k_i² × V) | A moderate number of adjustments over a moderate number of passes. Each pass checks k_i edges, each edge's path costs O(V). |
| Worst | O(k_i² × V) | Up to k_i passes, each examining a circuit of up to k_i + 1 edges with O(V) path reconstruction per edge. Total: O(k_i × k_i × V) = O(k_i² × V). With k_max = 12 and V = 3,593: O(144 × 3,593) = O(517,392) — negligible. |

---

### 6.6 Path Segment Construction

**What it does:** For each leg of the final circuit (k_i + 1 legs including the return to start), reconstructs the full sequence of road coordinates by following Dijkstra parent pointers from the source to the destination. These coordinate arrays (`pathSegments`) are what the frontend draws on the map.

Each `reconstructPath` call walks the parent pointer chain from destination back to source and reverses the result. The length of this chain is at most V (in a degenerate graph), but in practice bounded by the actual road path length between two nearby nodes.

| Case | Complexity (per zone) | What causes it |
|------|----------------------|----------------|
| Best | O(k_i × path_avg) | Each path reconstruction follows a short chain. `path_avg` is the average road path length in nodes. |
| Average | O(k_i × V) | Conservative bound using worst-case path length V. In practice paths between nearby incidents are much shorter than V. |
| Worst | O(k_i × V) | Each reconstructed path visits V nodes (degenerate linear graph). Total: O(k_i × V) per zone, O(p × k_max × V) across all zones. |

---

### 6.7 Overlap Detection

**What it does:** Identifies road segments (edges) used by more than one patrol's route. For each leg of each route, every consecutive pair of nodes in the Dijkstra path is recorded in `edgeUsage` — a map from a normalized edge key to a Set of patrol IDs that used that edge.

The total work is proportional to the total number of node-pairs across all path segments.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p × k_avg × path_avg) | Short paths between nearby incidents. Minimal work per processLeg call. |
| Average | O(p × k_max × V) | Each route has k_max + 1 legs, each of average path length V. |
| Worst | O(p × k_max × V) | All paths have maximum length V. Final scan of edgeUsage: O(total recorded edges) ≤ O(p × k_max × V). |

---

### 6.8 Stage 4 Overall

The dominant cost depends on whether backtracking TSP or the nearest-neighbor heuristic is used. Under default settings (k_max = 12, fallback threshold = 12), backtracking TSP runs for all multi-node zones.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p × (V+E) log V + p × k_min) | All zones have very few incidents (k_i small). Dijkstra cache hits dominate. For k_i = 2: O(1) algorithm per zone. |
| Average | O(p × (V+E) log V + p × k_avg! × k_avg) | Mix of small and medium zones. Average branching in backtracking TSP. |
| Worst | O(p × (V+E) log V + p × k_max!) | All p patrols have zones of size exactly k_max. Each zone requires one full Dijkstra run for the patrol position (cache miss) and full backtracking TSP with no effective pruning. Total: O(p × V log V + p × 12!) with default k_max. Path segment construction adds O(p × k_max × V). |

**Combined Stage 4 worst case:**

```
T_Stage4 = O(p × (V+E) log V)    [distance matrix construction]
          + O(p × k_max!)          [backtracking TSP, worst case per zone]
          + O(p × k_max² × V)      [sequence adjustment + path segments]
```

Since k_max! = 479,001,600 >> k_max² × V = 144 × 3,593 = 517,392, the backtracking TSP term dominates:

```
T_Stage4 ≈ O(p × (V log V + k_max!))
```

---

## 7. Post-Pipeline Verifier

**What it does:** Independently re-examines the pipeline's output after all four stages complete to confirm that the mathematical guarantees hold. The verifier is non-fatal — a failed check does not abort the pipeline or withhold results from the browser.

---

### 7.1 verifyConvexHull

**What it does:** Runs `isPointInHull` (Ray Casting) for each non-outlier incident point against the computed hull.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(h) | Only one incident is tested and it is outside the hull (early return). |
| Average | O(n × h) | Most incidents are inside the hull; each is tested. |
| Worst | O(n × h) | All n incidents must be tested; no early exit until the last one. |

---

### 7.2 verifyPatrolPositions

**What it does:** Checks three properties: all patrols are inside the hull (Ray Casting), all patrols occupy distinct road nodes (Set uniqueness), all patrols are members of `validCandidates` (Set membership).

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(p) | A duplicate is found immediately for the first two patrols, or the first patrol is outside the hull. |
| Average | O(p × h + C) | All p patrols pass all checks. Building the validIds Set: O(C). Ray Casting p patrols: O(p × h). Membership checks: O(p). |
| Worst | O(p × h + C) | All p patrols verified successfully. O(C) to build the Set, O(p × h) for Ray Casting. |

---

### 7.3 verifyZoneAssignment

**What it does:** Three checks: (1) no incident appears in two zones (hash map collision detection), (2) every non-outlier incident is in a zone or in excludedCrimeNodes (coverage check), (3) each assigned incident is within 10% of the road distance to its nearest patrol.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(m) | A duplicate zone assignment is found immediately (early return). |
| Average | O(n + m × p) | Build crimeId map (O(m)), check coverage (O(n)), verify assignments (O(m × p) Dijkstra cache lookups). |
| Worst | O(n + m × p) | All checks pass. The assignment verification requires, for each of m crime nodes, looking up the distance to all p patrols from the Dijkstra cache: O(m × p). |

---

### 7.4 verifyTSPRoute

**What it does:** Per route: checks node count, uniqueness, circuit distance arithmetic, and (for k ≤ 6, non-approximate routes) exhaustive optimality by enumerating all k! permutations.

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(k_i) | k_i > 6 or route is approximate. Only uniqueness and distance checks run: O(k_i). |
| Average | O(k_i!) | k_i ≤ 6 and non-approximate: enumerate all k_i! permutations. For k_i = 6: 720 permutations at O(k_i) each = O(k_i! × k_i). |
| Worst | O(k_i!) | k_i = 6 (maximum for exhaustive check). 6! = 720 permutations. Effectively O(1) in practice. |

**For all p routes:** O(p × k_small!) where k_small = min(6, k_max) = 6. With 6! = 720, the verifier's TSP check adds at most O(720p) = O(p) constant-factor work.

---

### 7.5 Verifier Overall

| Case | Complexity | What causes it |
|------|------------|----------------|
| Best | O(h + p) | Early exits in hull and position checks. |
| Average | O(n × h + C + m × p + p × k_small!) | Hull check (O(n × h)), position check (O(p × h + C)), zone assignment (O(m × p)), TSP routes (O(p × k_small!)). |
| Worst | O(n × h + C + m × p) | All verification checks pass (no early exits). TSP exhaustive check adds O(p × 720) = O(p), which is dominated by O(m × p). |

The verifier adds a relatively small overhead on top of the four algorithm stages.

---

## 8. Full Pipeline Worst-Case Analysis

This section derives the complete worst-case time complexity for a single Recalculate pipeline run, combining all stage costs and accounting for the pre-computation steps that run between stages.

---

### 8.1 Per-Stage Dominant Terms

Each stage's worst-case complexity reduces to a single dominant term when the system is at maximum load. The analysis uses the following worst-case assumptions:
- n incidents at maximum practical count (up to 300, but algorithm configurations make n ≤ 30 the realistic maximum for hull computation)
- p patrols at maximum (p_max for Commonwealth = 30, derived as floor(√914))
- C = V (all-candidates mode, hull covers entire barangay)
- h = n (every incident defines a hull vertex)
- m = n (no snapping deduplication)
- All zones at maximum size k_max = 12
- No adaptive convergence in Stage 2 (all restarts run to I iterations)
- Strong rebalancing active in Stage 3

| Step | Expression | Dominant term |
|------|------------|---------------|
| **Pre-Stage 1 (nothing)** | — | — |
| **Stage 1: Hull computation** | O(n³ + V × h) = O(n³ + V × n) | O(V × n) for V >> n² |
| **Pre-Stage 2: Road Distance Matrix** | O(C × (V+E) log V) = O(V² log V) when C = V | O(V² log V) |
| **Stage 2: Hill Climbing restarts** | O(R_b × I × p³ × C) = O(R_b × I × V × p³) | O(R_b × I × V × p³) |
| **Stage 3: Dijkstra pre-compute** | O(m × (V+E) log V) = O(n × V log V) | O(n × V log V) |
| **Stage 3: Strong rebalancing** | O(m² × p) = O(n² × p) | O(n² × p) |
| **Stage 4: Dijkstra for patrol positions** | O(p × (V+E) log V) = O(p × V log V) | O(p × V log V) |
| **Stage 4: Backtracking TSP** | O(p × k_max!) | O(p × 12!) |
| **Verifier** | O(n × h + C + m × p) = O(n² + V + n × p) | O(n² + V) |

---

### 8.2 Compound Worst-Case Expression

Summing the dominant terms from all stages and the road distance matrix pre-computation:

```
T_pipeline = O(n³ + V × n)                   [Stage 1]
           + O(V² log V)                       [buildRoadDistMatrix]
           + O(R_b × I × V × p³)              [Stage 2 restarts]
           + O(n × V log V)                    [Stage 3 Dijkstra]
           + O(n² × p)                         [Stage 3 strong rebalancing]
           + O(p × V log V)                    [Stage 4 Dijkstra]
           + O(p × k_max!)                     [Stage 4 backtracking TSP]
           + O(n² + V)                         [Verifier]
```

**Eliminating dominated terms** (using the principle that lower-order terms vanish inside big-O notation when one term grows faster than another):

- `O(V² log V)` dominates `O(V × n)` when V >> n (true: V = 3,593, n ≤ 30).
- `O(R_b × I × V × p³)` dominates `O(V² log V)` when R_b × I × p³ >> V log V. With R_b = 100, I = 1000, p = 30: 10^5 × 27,000 = 2.7 × 10^9 >> V log V ≈ 3,593 × 12 ≈ 43,116. Stage 2 dominates buildRoadDistMatrix.
- `O(R_b × I × V × p³)` dominates `O(n × V log V)` and `O(p × V log V)` and `O(n² × p)` when the Stage 2 coefficient is large.
- `O(p × k_max!)` may dominate `O(R_b × I × V × p³)` when p × k_max! >> R_b × I × V × p³, i.e., k_max! >> R_b × I × V × p². With k_max = 12 and the Commonwealth values: 12! = 479,001,600 vs 100 × 1000 × 3,593 × 900 ≈ 3.2 × 10^11. So Stage 2 dominates Stage 4 at maximum p.
- For small p, the comparison reverses: with p = 1, Stage 2 costs O(R_b × I × V) while Stage 4 costs O(k_max!). With R_b × I × V = 100 × 1000 × 3,593 ≈ 3.6 × 10^8 vs 12! ≈ 4.8 × 10^8, they are comparable.

**Simplified worst-case pipeline expression:**

```
T_pipeline = O(R_b × I × V × p³ + p × k_max!)
```

Where:
- `R_b × I × V × p³` is Stage 2's unbounded worst case
- `p × k_max!` is Stage 4's unbounded worst case

Both terms must be retained because neither universally dominates the other across all values of p.

---

### 8.3 Numerical Substitution (Commonwealth Baseline)

Substituting the default configuration values and Commonwealth's road network metrics:

| Parameter | Value | Source |
|-----------|-------|--------|
| V | 3,593 | Commonwealth road network nodes |
| E | 4,091 | Commonwealth road network edges |
| R_b | 100 | config.hillClimbing.restarts |
| I | 1000 | config.hillClimbing.maxIterations |
| p_max | 30 | floor(√914) = floor(30.2) |
| k_max | 12 | config.tsp.maxCrimeNodesPerZone |
| k_max! | 479,001,600 | 12! |
| n | ≤ 300 | validateIncidents upper bound |

**Stage 2 worst case:**
```
R_b × I × V × p³ = 100 × 1000 × 3,593 × 30³
                 = 100 × 1000 × 3,593 × 27,000
                 ≈ 9.7 × 10¹²
```

**Stage 4 worst case:**
```
p × k_max! = 30 × 479,001,600
           ≈ 1.4 × 10¹⁰
```

**buildRoadDistMatrix worst case (C = V):**
```
V × (V + E) log₂ V = 3,593 × 7,684 × 11.8
                   ≈ 3.3 × 10⁸
```

**Stage 1 worst case (n = 30):**
```
n³ + V × n = 27,000 + 107,790
           ≈ 1.3 × 10⁵
```

**Stage 3 Dijkstra worst case (m = n = 30):**
```
n × V log V = 30 × 3,593 × 11.8
            ≈ 1.3 × 10⁶
```

**Stage 2 dominates all other terms by roughly three orders of magnitude** in the purely theoretical worst case where adaptive convergence never fires and all restarts reach the maximum iteration count. The gap between the theoretical worst case and observed performance is explained in the next section.

---

### 8.4 Which Stage Dominates

The theoretical worst case for Stage 2 (O(R_b × I × V × p³) ≈ 9.7 × 10¹²) is an extreme upper bound. In practice, three mechanisms prevent Stage 2 from reaching anything close to this:

**Mechanism 1: Adaptive convergence.** The restart loop exits early when the last three restarts agree within 0.1%. In typical runs with n ≤ 20 incidents and p ≤ 10 patrols, convergence triggers after 15–40 restarts (not the theoretical maximum of R_b × p = 100 × 10 = 1000 restarts). This reduces the effective restart count by a factor of 25–65.

**Mechanism 2: Early iteration termination.** Within each restart, the iteration loop exits when no patrol moved in a full pass (the local maximum is reached). Most restarts reach their local maximum within 10–50 iterations, far below the maxIterations = 1000 cap. This reduces the effective iteration count by a factor of 20–100.

**Mechanism 3: Sparse neighbor sets.** The search radius R is calibrated to the average candidate spacing inside the hull. In a typical deployment, a patrol has 50–200 neighbors within R, not all C = 3,593 candidates. The per-iteration cost is therefore O(N_r × p²) ≈ O(200 × p²) rather than O(C × p²) = O(3,593 × p²).

**Combined practical reduction factor:** Accounting for all three mechanisms:
```
Practical T_Stage2 ≈ T_theoretical / (R_reduction × I_reduction × N_r_ratio)
                   ≈ 9.7 × 10¹² / (40 × 40 × 18)
                   ≈ 9.7 × 10¹² / 28,800
                   ≈ 3.4 × 10⁸
```

This brings Stage 2's practical cost to approximately the same order of magnitude as `buildRoadDistMatrix` (3.3 × 10⁸), which matches observed pipeline runtimes of under 3 seconds for typical inputs.

**Stage 4 in practice:** The backtracking TSP's theoretical worst case of O(k_max!) assumes no pruning effectiveness. In practice on road network distance matrices (which have significant distance variation), pruning eliminates 60–95% of branches for k_i ≤ 8. For k_i = 12, even modest pruning reduces 479 million branches to a few million. The path-aware sequence adjustment further shortens resulting circuits, giving the pruning condition a tighter bound to work with.

**Conclusion:** In the purely theoretical worst case (no adaptive convergence, no iteration termination, no pruning effectiveness, maximum p and k_max), Stage 2 dominates the pipeline at O(R_b × I × V × p³). In all practical deployments, Stage 2 and `buildRoadDistMatrix` contribute approximately equally, and the combined runtime is dominated by O(C × (V + E) log V) — the cost of building and using the road distance infrastructure.

---

## 9. Summary Table

### Per-Algorithm Complexity

| Algorithm | Best Case | Average Case | Worst Case |
|-----------|-----------|--------------|------------|
| **Haversine Distance** | O(1) | O(1) | O(1) |
| **MinHeap insert / extractMin / decreaseKey** | O(log V) | O(log V) | O(log V) |
| **Dijkstra (single source)** | O(V log V) | O((V+E) log V) | O((V+E) log V) |
| **buildRoadDistMatrix** | O(C × (V+E) log V) | O(C × (V+E) log V) | O(V × (V+E) log V) when C=V |
| **runDijkstra (cached)** | O(1) cache hit | O((V+E) log V) per miss | O((V+E) log V) |
| **rayCast / isPointInHull** | O(h) | O(h) | O(h) |
| **Stage 1: Incremental check** | O(1) identical set | O(n²) | O(n²) |
| **Stage 1: Outlier detection** | O(1) skipped | O(n) | O(n) |
| **Stage 1: Collinearity check** | O(1) | O(n) | O(n) |
| **Stage 1: Brute force hull** | O(n³) | O(n³) | O(n³) |
| **Stage 1: Edge ordering** | O(h) | O(h²) | O(n²) |
| **Stage 1: Ray Cast pre-filter** | O(V+h) | O(V×h) | O(V×h) |
| **Stage 1: Overall** | O(n²+n×h) incremental | O(n³+V×h) | O(n³+V×n) |
| **Stage 2: n=1 special case** | O(C²) | O(C²) | O(C²) |
| **Stage 2: findNeighbors** | O(p) | O(C) | O(C) |
| **Stage 2: minPairwiseExcluding** | O(p²) | O(p²) | O(p²) |
| **Stage 2: Per iteration (async)** | O(C×p) | O(C×p²) | O(C×p²) |
| **Stage 2: Overall (n>1)** | O(C×V log V + p³×C) | O(C×V log V + R_avg×I_avg×p³×C) | O(C×V log V + R_b×I×p³×C) |
| **Stage 3: snapToNearestCandidate** | O(C) per incident | O(n×C) total | O(n×C×log(hullDiam)) |
| **Stage 3: Deduplication** | O(m) | O(m) | O(m) |
| **Stage 3: Dijkstra pre-compute** | O(m×(V+E) log V) | O(m×(V+E) log V) | O(n×(V+E) log V) |
| **Stage 3: Zone assignment** | O(m×p) | O(m×p) | O(m×p) |
| **Stage 3: Light rebalancing** | O(p) | O(m×p) | O(m×p) |
| **Stage 3: Strong rebalancing** | O(p) | O(m²×p) | O(m²×p) |
| **Stage 3: Overall** | O(n×V log V + m×p) | O(n×V log V + m×p) | O(n×V log V + n²×p) |
| **Stage 4: Distance matrix (per zone)** | O(k_i) cache hits | O((V+E) log V) | O((k_i+1)×(V+E) log V) |
| **Stage 4: k=2 shortcut** | O(1) | O(1) | O(1) |
| **Stage 4: Nearest neighbor (k>12)** | O(k_i²) | O(k_i²) | O(k_i²) |
| **Stage 4: Backtracking TSP (k≤12)** | O(k_i) | Sub-O(k_i!) | O(k_i!) |
| **Stage 4: Sequence adjustment** | O(k_i) | O(k_i²×V) | O(k_i²×V) |
| **Stage 4: Overall** | O(p×V log V + p×k_min) | O(p×V log V + p×k_avg!) | O(p×V log V + p×k_max!) |
| **Verifier: verifyConvexHull** | O(h) | O(n×h) | O(n×h) |
| **Verifier: verifyPatrolPositions** | O(p) | O(p×h+C) | O(p×h+C) |
| **Verifier: verifyZoneAssignment** | O(m) | O(n+m×p) | O(n+m×p) |
| **Verifier: verifyTSPRoute** | O(k_i) | O(k_i!) for k≤6 | O(k_i!) for k≤6 |
| **Verifier: Overall** | O(h+p) | O(n×h+C+m×p) | O(n²+V+n×p) |

### Full Pipeline Summary

| Case | Expression | Interpretation |
|------|------------|----------------|
| **Best** | O(C × (V+E) log V + p³ × C) | buildRoadDistMatrix dominates; Stage 2 converges in minimum restarts (max(5,p)) at 1 iteration each. All other stages contribute lower-order terms. |
| **Average** | O(C × (V+E) log V + R_avg × I_avg × C × p³ + n × V log V) | buildRoadDistMatrix plus partial Stage 2 restart loop plus Stage 3 Dijkstra. Adaptive convergence significantly reduces Stage 2 cost below its worst case. Stage 4 adds O(p × k_avg!) which is typically small for k_avg < 8. |
| **Worst** | O(R_b × I × C × p³ + p × k_max!) | Stage 2 restart loop without any adaptive convergence, plus Stage 4 backtracking TSP with no pruning effectiveness. All lower-order terms (buildRoadDistMatrix, Stage 1, Stage 3, Verifier) are absorbed by the Stage 2 dominant term. With defaults (R_b=100, I=1000, k_max=12, C=V=3,593, p=30): approximately O(9.7 × 10¹² + 1.4 × 10¹⁰). Stage 2 dominates. |

### Variable Reference Summary

| Variable | Meaning |
|----------|---------|
| n | Incident count (1–300) |
| p | Patrol count (1–100, practical max 30 for Commonwealth) |
| V | Road network nodes (3,593 for Commonwealth) |
| E | Road network edges (4,091 for Commonwealth) |
| C | Valid candidates inside hull (C ≤ V; C = V in all-mode) |
| h | Hull vertices (h ≤ n; typically 3–15) |
| m | Deduplicated snapped incident nodes (m ≤ n) |
| R_b | Base restart count per patrol (default 100) |
| I | Max iterations per restart (default 1000) |
| k_i | Crime nodes in patrol i's zone (k_i ≤ k_max) |
| k_max | Zone size cap (default 12) |
| N_r | Neighbors within radius R per patrol (N_r ≤ C) |
