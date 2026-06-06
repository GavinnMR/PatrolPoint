import { getRoadNetwork, saveRoadNetwork } from '../db/queries.js';
import { fetchBarangayData } from './overpass.js';
import { processOverpassResponse } from './networkProcessor.js';

const BARANGAY_BBOXES = {
    'Commonwealth': { south: 14.69, west: 121.08, north: 14.72, east: 121.11 }
};

// Module-level in-memory cache — persists across requests for the lifetime of the process
const networkCache = {};

export async function getOrFetchNetwork(barangayName) {
    // 1. In-memory hit — fastest path, no DB round-trip
    if (networkCache[barangayName]) {
        console.log(`Network cache hit (memory): ${barangayName}`);
        return { ...networkCache[barangayName], fromCache: true };
    }

    // 2. Database hit — warm start after server restart
    // Catch DB errors (host unreachable, pool timeout, etc.) and fall through to Overpass
    // so the service stays available even when the database is temporarily down.
    let dbRecord = null;
    try {
        dbRecord = await getRoadNetwork(barangayName);
    } catch (dbErr) {
        console.warn(`Database unavailable for "${barangayName}" (${dbErr.message}) — falling back to Overpass API`);
    }
    if (dbRecord) {
        console.log(`Network cache hit (database): ${barangayName}`);
        const data = {
            nodes: dbRecord.nodes,
            edges: dbRecord.edges,
            adjacencyList: dbRecord.adjacency_list,
            intersectionNodeIds: dbRecord.intersection_node_ids,
            boundary: dbRecord.boundary,
            nodeCount: dbRecord.node_count,
            edgeCount: dbRecord.edge_count,
            intersectionCount: dbRecord.intersection_count,
            bbox: {
                south: parseFloat(dbRecord.bbox_south),
                west: parseFloat(dbRecord.bbox_west),
                north: parseFloat(dbRecord.bbox_north),
                east: parseFloat(dbRecord.bbox_east)
            }
        };
        networkCache[barangayName] = data;
        return { ...data, fromCache: true };
    }

    // 3. Cold start — fetch from Overpass, process, cache in DB and memory
    console.log(`Network cache miss: ${barangayName} — fetching from Overpass`);
    const bbox = BARANGAY_BBOXES[barangayName];
    if (!bbox) {
        throw new Error(`No bounding box configured for barangay: ${barangayName}`);
    }

    const { roadData, boundaryData } = await fetchBarangayData(barangayName, bbox);
    const processed = processOverpassResponse(roadData, boundaryData);

    try {
        await saveRoadNetwork({
            barangay_name: barangayName,
            city: 'Quezon City',
            osm_relation_id: processed.osmRelationId,
            nodes: processed.nodes,
            edges: processed.edges,
            boundary: processed.boundary,
            adjacency_list: processed.adjacencyList,
            intersection_node_ids: processed.intersectionNodeIds,
            node_count: processed.nodeCount,
            edge_count: processed.edgeCount,
            intersection_count: processed.intersectionCount,
            bbox_south: processed.bbox.south,
            bbox_west: processed.bbox.west,
            bbox_north: processed.bbox.north,
            bbox_east: processed.bbox.east
        });
        console.log(`Network cached to database: ${barangayName}`);
    } catch (dbErr) {
        console.error(`Failed to cache network to database for ${barangayName}:`, dbErr.message);
        // Non-fatal — in-memory cache still serves this request and subsequent ones
    }

    networkCache[barangayName] = processed;

    return { ...processed, fromCache: false };
}
