// Canonical Haversine distance — parameters always lat1, lng1, lat2, lng2, returns meters
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function extractBoundaryPolygon(boundaryData) {
    const elements = boundaryData?.elements;
    if (!elements || elements.length === 0) return [];

    // Build node and way lookup maps
    const nodesMap = new Map();
    const waysMap = new Map();
    for (const el of elements) {
        if (el.type === 'node') nodesMap.set(el.id, { lat: el.lat, lng: el.lon });
        if (el.type === 'way') waysMap.set(el.id, el.nodes || []);
    }

    // Find the boundary relation
    const relation = elements.find(el => el.type === 'relation');
    if (!relation) {
        // No relation — return all boundary nodes as fallback
        return Array.from(nodesMap.values());
    }

    // Get outer way members (role 'outer' or empty role)
    const outerWayIds = (relation.members || [])
        .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
        .map(m => m.ref);

    if (outerWayIds.length === 0) return [];

    // Chain ways into an ordered polygon ring
    const usedIds = new Set();
    const firstWayNodes = waysMap.get(outerWayIds[0]);
    if (!firstWayNodes || firstWayNodes.length === 0) return [];

    const orderedNodeIds = [...firstWayNodes];
    usedIds.add(outerWayIds[0]);

    // Guard against infinite loop if ways don't chain cleanly
    let maxIter = outerWayIds.length * 2;
    while (usedIds.size < outerWayIds.length && maxIter-- > 0) {
        const tail = orderedNodeIds[orderedNodeIds.length - 1];
        let chained = false;
        for (const wayId of outerWayIds) {
            if (usedIds.has(wayId)) continue;
            const wayNodes = waysMap.get(wayId);
            if (!wayNodes || wayNodes.length === 0) continue;
            if (wayNodes[0] === tail) {
                orderedNodeIds.push(...wayNodes.slice(1));
                usedIds.add(wayId);
                chained = true;
                break;
            } else if (wayNodes[wayNodes.length - 1] === tail) {
                orderedNodeIds.push(...[...wayNodes].reverse().slice(1));
                usedIds.add(wayId);
                chained = true;
                break;
            }
        }
        if (!chained) break;
    }

    return orderedNodeIds
        .map(id => nodesMap.get(id))
        .filter(Boolean);
}

export function processOverpassResponse(roadData, boundaryData) {
    const elements = roadData.elements || [];

    // Step 1-2: Extract all nodes, build nodeMap and osmToInternalId
    const osmNodes = elements.filter(e => e.type === 'node');
    const nodeMap = {};
    const osmToInternalId = new Map();

    osmNodes.forEach((node, index) => {
        const id = 'n' + index;
        nodeMap[id] = { id, osmId: node.id, lat: node.lat, lng: node.lon };
        osmToInternalId.set(node.id, id);
    });

    if (Object.keys(nodeMap).length === 0) {
        throw new Error(`Overpass returned no road nodes for this barangay. Check the barangay name or bounding box.`);
    }

    // Step 3-4: Extract highway ways (exclude steps), build edges with deduplication
    const ways = elements.filter(e =>
        e.type === 'way' &&
        e.tags?.highway &&
        e.tags.highway !== 'steps'
    );

    const edgeSet = new Map();
    const degree = new Map();
    for (const id in nodeMap) degree.set(id, 0);

    for (const way of ways) {
        const nodeIds = way.nodes || [];
        for (let i = 0; i < nodeIds.length - 1; i++) {
            const fromId = osmToInternalId.get(nodeIds[i]);
            const toId = osmToInternalId.get(nodeIds[i + 1]);
            if (!fromId || !toId) continue;

            // Canonical deduplication key — numeric sort so n89|n234 is always the same key
            const fromNum = parseInt(fromId.slice(1));
            const toNum = parseInt(toId.slice(1));
            const key = fromNum < toNum ? `${fromId}|${toId}` : `${toId}|${fromId}`;

            if (!edgeSet.has(key)) {
                const from = nodeMap[fromId];
                const to = nodeMap[toId];
                const weight = parseFloat(haversineDistance(from.lat, from.lng, to.lat, to.lng).toFixed(4));
                edgeSet.set(key, { from: fromId, to: toId, weight });
                degree.set(fromId, (degree.get(fromId) || 0) + 1);
                degree.set(toId, (degree.get(toId) || 0) + 1);
            }
        }
    }

    const edges = Array.from(edgeSet.values());

    // Step 5: Build adjacencyList (undirected — add both directions)
    const adjacencyList = {};
    for (const id in nodeMap) adjacencyList[id] = [];
    for (const edge of edges) {
        adjacencyList[edge.from].push({ neighborId: edge.to, weight: edge.weight });
        adjacencyList[edge.to].push({ neighborId: edge.from, weight: edge.weight });
    }

    // Step 6: Intersection nodes — degree >= 3
    const intersectionNodeIds = [];
    for (const [id, deg] of degree) {
        if (deg >= 3) intersectionNodeIds.push(id);
    }

    // Step 7: Extract boundary polygon and OSM relation ID from boundaryData
    const boundary = extractBoundaryPolygon(boundaryData);
    const osmRelationId = boundaryData?.elements?.find(el => el.type === 'relation')?.id || null;

    // Step 8: Compute bounding box from all road nodes
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    for (const id in nodeMap) {
        const { lat, lng } = nodeMap[id];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    }

    const nodeCount = Object.keys(nodeMap).length;
    const edgeCount = edges.length;
    const intersectionCount = intersectionNodeIds.length;

    console.log(`Network processed: ${nodeCount} nodes, ${edgeCount} edges, ${intersectionCount} intersection nodes, ${boundary.length} boundary vertices`);

    return {
        nodes: nodeMap,
        edges,
        adjacencyList,
        intersectionNodeIds,
        boundary,
        osmRelationId,
        nodeCount,
        edgeCount,
        intersectionCount,
        bbox: { south: minLat, west: minLng, north: maxLat, east: maxLng }
    };
}
