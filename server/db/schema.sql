-- Road network cache table
-- Stores processed Overpass road network data per barangay
CREATE TABLE IF NOT EXISTS road_networks (
    id SERIAL PRIMARY KEY,
    barangay_name VARCHAR(255) NOT NULL,
    city VARCHAR(255) NOT NULL DEFAULT 'Quezon City',
    osm_relation_id BIGINT,
    nodes JSONB NOT NULL,
    edges JSONB NOT NULL,
    boundary JSONB NOT NULL,
    adjacency_list JSONB NOT NULL,
    intersection_node_ids JSONB NOT NULL,
    node_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    intersection_count INTEGER NOT NULL,
    bbox_south DECIMAL(10, 7) NOT NULL,
    bbox_west DECIMAL(10, 7) NOT NULL,
    bbox_north DECIMAL(10, 7) NOT NULL,
    bbox_east DECIMAL(10, 7) NOT NULL,
    excluded_road_types TEXT[] DEFAULT ARRAY['steps'],
    cached_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '30 days'),
    UNIQUE(barangay_name, city)
);

CREATE INDEX IF NOT EXISTS idx_road_networks_barangay ON road_networks(barangay_name);
CREATE INDEX IF NOT EXISTS idx_road_networks_expires ON road_networks(expires_at);

-- Users table
-- Stores tanod commander accounts
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    barangay VARCHAR(255) DEFAULT 'Commonwealth',
    role VARCHAR(50) DEFAULT 'commander',
    created_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP
);

-- Deployment sessions table
-- Stores saved pipeline runs per user
CREATE TABLE IF NOT EXISTS deployment_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_name VARCHAR(255),
    barangay_name VARCHAR(255) NOT NULL,
    n_patrols INTEGER NOT NULL,
    deployment_mode VARCHAR(50) NOT NULL,
    incidents JSONB NOT NULL,
    config JSONB NOT NULL,
    results JSONB NOT NULL,
    trace JSONB NOT NULL,
    total_runtime_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON deployment_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON deployment_sessions(created_at DESC);
