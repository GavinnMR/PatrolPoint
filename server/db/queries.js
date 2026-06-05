import pool from './client.js';

export async function getRoadNetwork(barangayName) {
    const res = await pool.query(
        `SELECT * FROM road_networks
         WHERE barangay_name = $1 AND expires_at > NOW()`,
        [barangayName]
    );
    return res.rows[0] || null;
}

export async function saveRoadNetwork(data) {
    const {
        barangay_name, city, osm_relation_id,
        nodes, edges, boundary, adjacency_list, intersection_node_ids,
        node_count, edge_count, intersection_count,
        bbox_south, bbox_west, bbox_north, bbox_east,
        excluded_road_types
    } = data;

    const res = await pool.query(
        `INSERT INTO road_networks
            (barangay_name, city, osm_relation_id, nodes, edges, boundary,
             adjacency_list, intersection_node_ids, node_count, edge_count,
             intersection_count, bbox_south, bbox_west, bbox_north, bbox_east,
             excluded_road_types)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (barangay_name, city) DO UPDATE SET
            osm_relation_id      = EXCLUDED.osm_relation_id,
            nodes                = EXCLUDED.nodes,
            edges                = EXCLUDED.edges,
            boundary             = EXCLUDED.boundary,
            adjacency_list       = EXCLUDED.adjacency_list,
            intersection_node_ids = EXCLUDED.intersection_node_ids,
            node_count           = EXCLUDED.node_count,
            edge_count           = EXCLUDED.edge_count,
            intersection_count   = EXCLUDED.intersection_count,
            bbox_south           = EXCLUDED.bbox_south,
            bbox_west            = EXCLUDED.bbox_west,
            bbox_north           = EXCLUDED.bbox_north,
            bbox_east            = EXCLUDED.bbox_east,
            excluded_road_types  = EXCLUDED.excluded_road_types,
            cached_at            = NOW(),
            expires_at           = NOW() + INTERVAL '30 days'
         RETURNING id`,
        [
            barangay_name,
            city || 'Quezon City',
            osm_relation_id || null,
            JSON.stringify(nodes),
            JSON.stringify(edges),
            JSON.stringify(boundary),
            JSON.stringify(adjacency_list),
            JSON.stringify(intersection_node_ids),
            node_count, edge_count, intersection_count,
            bbox_south, bbox_west, bbox_north, bbox_east,
            excluded_road_types || ['steps']
        ]
    );
    return res.rows[0];
}

export async function getSessionsByUser(userId) {
    const res = await pool.query(
        `SELECT id, session_name, barangay_name, n_patrols, deployment_mode, created_at
         FROM deployment_sessions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
    );
    return res.rows;
}

export async function getSessionById(sessionId, userId) {
    const res = await pool.query(
        `SELECT * FROM deployment_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
    );
    return res.rows[0] || null;
}

export async function saveSession(userId, sessionData) {
    const {
        session_name, barangay_name, n_patrols, deployment_mode,
        incidents, config, results, trace, total_runtime_ms
    } = sessionData;

    const res = await pool.query(
        `INSERT INTO deployment_sessions
            (user_id, session_name, barangay_name, n_patrols, deployment_mode,
             incidents, config, results, trace, total_runtime_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
            userId, session_name, barangay_name, n_patrols, deployment_mode,
            JSON.stringify(incidents), JSON.stringify(config),
            JSON.stringify(results), JSON.stringify(trace),
            total_runtime_ms
        ]
    );
    return res.rows[0].id;
}

export async function deleteSession(sessionId, userId) {
    await pool.query(
        `DELETE FROM deployment_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
    );
}

export async function getUserByUsername(username) {
    const res = await pool.query(
        `SELECT id, username, password_hash, display_name, barangay, role
         FROM users WHERE username = $1`,
        [username]
    );
    return res.rows[0] || null;
}

export async function createUser(username, passwordHash, displayName) {
    const res = await pool.query(
        `INSERT INTO users (username, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, username, display_name, barangay, role`,
        [username, passwordHash, displayName]
    );
    return res.rows[0];
}

export async function updateLastLogin(userId) {
    await pool.query(
        `UPDATE users SET last_login = NOW() WHERE id = $1`,
        [userId]
    );
}
