// server/algorithms/dijkstra.js
// Canonical Dijkstra with binary min-heap.
// haversineDistance is exported here and imported by every other algorithm file —
// never reimplement inline elsewhere.

// ── Haversine distance ────────────────────────────────────────────────────────
// Parameters always lat1, lng1, lat2, lng2. Returns meters.
export function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Binary Min-Heap ───────────────────────────────────────────────────────────
// position map gives O(1) index lookup — required for O(log n) decreaseKey.
// Without it, decreaseKey degrades to O(n) linear scan.
class MinHeap {
    constructor() {
        this.heap = [];     // [{nodeId, priority}, ...]
        this.position = {}; // nodeId → index in heap array
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    contains(nodeId) {
        return this.position[nodeId] !== undefined;
    }

    insert(nodeId, priority) {
        const idx = this.heap.length;
        this.heap.push({ nodeId, priority });
        this.position[nodeId] = idx;
        this._siftUp(idx);
    }

    extractMin() {
        if (this.heap.length === 0) return null;

        const min = this.heap[0];
        delete this.position[min.nodeId];

        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.position[last.nodeId] = 0;
            this._siftDown(0);
        }
        return min;
    }

    // Reduce priority of a node already in the heap and restore heap property.
    // No-op if newPriority is not strictly less than the current priority.
    decreaseKey(nodeId, newPriority) {
        const idx = this.position[nodeId];
        if (idx === undefined) return;
        if (newPriority >= this.heap[idx].priority) return;
        this.heap[idx].priority = newPriority;
        this._siftUp(idx);
    }

    _siftUp(idx) {
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (this.heap[parent].priority <= this.heap[idx].priority) break;
            this._swap(idx, parent);
            idx = parent;
        }
    }

    _siftDown(idx) {
        const n = this.heap.length;
        while (true) {
            let smallest = idx;
            const left = (idx << 1) + 1;
            const right = (idx << 1) + 2;
            if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
            if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
            if (smallest === idx) break;
            this._swap(idx, smallest);
            idx = smallest;
        }
    }

    _swap(i, j) {
        const tmp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = tmp;
        this.position[this.heap[i].nodeId] = i;
        this.position[this.heap[j].nodeId] = j;
    }
}

// ── Hull exterior check ───────────────────────────────────────────────────────
// Ray casting point-in-polygon test. Hull vertices are [{lat, lng}] in CCW order.
// Casts a ray rightward (increasing lng) and counts edge crossings.
function pointInHull(lat, lng, hull) {
    let inside = false;
    const n = hull.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = hull[i].lng, yi = hull[i].lat;
        const xj = hull[j].lng, yj = hull[j].lat;
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ── Core Dijkstra ─────────────────────────────────────────────────────────────
// Single-source shortest path traversing the FULL road network — all nodes and
// edges, including non-intersection intermediate nodes. Restricting to
// intersection nodes only would produce incorrect paths through buildings.
//
// nodeMap:         optional { nodeId → {lat, lng} } — required when hull penalty is active
// hull:            optional [{lat, lng}] hull polygon — edges whose midpoint falls outside
//                  are penalized by exteriorPenalty to discourage exterior routing
// exteriorPenalty: multiplier applied to exterior-edge weights (default 1 = no penalty)
//
// Returns:
//   distances — { nodeId: distanceInMeters } — Infinity for unreachable nodes
//   parents   — { nodeId: parentNodeId }     — null for source and unreachable nodes
function dijkstra(sourceId, adjacencyList, nodeMap = null, hull = null, exteriorPenalty = 1, removedNodes = null) {
    const penaltyActive = exteriorPenalty > 1 && hull && hull.length >= 3 && nodeMap;

    const distances = {};
    const parents = {};

    for (const nodeId in adjacencyList) {
        distances[nodeId] = Infinity;
        parents[nodeId] = null;
    }
    // Source node may not be a key in adjacencyList if isolated — ensure it exists
    distances[sourceId] = 0;
    parents[sourceId] = null;

    const heap = new MinHeap();
    heap.insert(sourceId, 0);

    while (!heap.isEmpty()) {
        const { nodeId: current } = heap.extractMin();
        const currentDist = distances[current];

        // All remaining heap entries are Infinity — rest of graph is disconnected
        if (currentDist === Infinity) break;

        const neighbors = adjacencyList[current];
        if (!neighbors) continue;

        for (const { neighborId, weight } of neighbors) {
            if (removedNodes && removedNodes.has(neighborId)) continue;
            let w = weight;
            if (penaltyActive) {
                const nA = nodeMap[current];
                const nB = nodeMap[neighborId];
                if (nA && nB) {
                    const midLat = (nA.lat + nB.lat) / 2;
                    const midLng = (nA.lng + nB.lng) / 2;
                    if (!pointInHull(midLat, midLng, hull)) {
                        w *= exteriorPenalty;
                    }
                }
            }
            const newDist = currentDist + w;
            if (newDist < (distances[neighborId] ?? Infinity)) {
                distances[neighborId] = newDist;
                parents[neighborId] = current;
                if (heap.contains(neighborId)) {
                    heap.decreaseKey(neighborId, newDist);
                } else {
                    heap.insert(neighborId, newDist);
                }
            }
        }
    }

    return { distances, parents };
}

// ── Path reconstruction ───────────────────────────────────────────────────────
// Follows parent pointers from destId back to sourceId then reverses.
// Returns [sourceId, ..., destId] on success, or null if unreachable.
// Handles disconnected nodes gracefully — null path for Infinity-distance nodes.
export function reconstructPath(sourceId, destId, parents) {
    if (destId === sourceId) return [sourceId];

    // Unreachable: parent is null (never updated by Dijkstra) or not in parents map
    if (parents[destId] === null || parents[destId] === undefined) return null;

    const path = [destId];
    let current = destId;

    while (current !== sourceId) {
        current = parents[current];
        if (current === null || current === undefined) return null; // broken chain
        path.push(current);
    }

    path.reverse();
    return path;
}

// ── Normalized cache key ──────────────────────────────────────────────────────
// Extract numeric part of node IDs, sort numerically smaller first, join with pipe.
// Guarantees n89 and n234 always produce "n89|n234" regardless of call order.
export function normalizedCacheKey(idA, idB) {
    const numA = parseInt(idA.slice(1), 10);
    const numB = parseInt(idB.slice(1), 10);
    return numA < numB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// ── Cached Dijkstra runner ────────────────────────────────────────────────────
// Public entry point used by all other algorithm files.
// Cache is keyed by sourceId — one Dijkstra run populates distances and parents
// to every reachable node, so any specific path is reconstructable via
// reconstructPath without re-running. Cache persists for the pipeline run lifetime.
//
// dijkstraCache shape: { [sourceId]: { distances, parents } }
//
// Optional hull penalty params (used by Stage 4 when hullExteriorPenalty > 1):
//   nodeMap:         { nodeId → {lat, lng} } — required for midpoint check
//   hull:            [{lat, lng}] CCW hull polygon
//   exteriorPenalty: multiplier for edges whose midpoint falls outside the hull
//
// Disconnected nodes:
//   distances[nodeId] === Infinity   — node unreachable from source
//   reconstructPath(...)  === null   — no road path exists
export function runDijkstra(sourceId, adjacencyList, dijkstraCache, nodeMap = null, hull = null, exteriorPenalty = 1, removedNodes = null) {
    // Skip cache read when removedNodes is active — topology differs from base graph,
    // so a cached base-graph result would return wrong distances. Always recompute.
    // Writing is always safe: the cache is cleared before every pipeline run, so
    // a removed-nodes result cannot contaminate a later base-graph run.
    if (!removedNodes && dijkstraCache[sourceId]) {
        return dijkstraCache[sourceId];
    }
    const result = dijkstra(sourceId, adjacencyList, nodeMap, hull, exteriorPenalty, removedNodes);
    dijkstraCache[sourceId] = result;
    return result;
}
