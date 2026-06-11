#!/usr/bin/env python3
"""
Preprocess Geofabrik GeoJSON data into per-barangay road_network.json files.

Run once from the project root:
    python scripts/preprocess_barangays.py

Reads:
    data/source/admin_areas.geojson   — barangay boundary polygons
    data/source/roads.geojson         — road multilines (all Philippines)

Writes:
    data/barangays/<slug>.json        — one file per barangay
    data/barangays/manifest.json      — name -> slug + bbox index
"""

import json
import math
import os
import re
import geopandas as gpd
from shapely.geometry import LineString, MultiLineString, MultiPolygon, GeometryCollection

# ── Config ─────────────────────────────────────────────────────────────────────

SOURCE_DIR = 'data/source'
OUTPUT_DIR = 'data/barangays'
ADMIN_FILE = os.path.join(SOURCE_DIR, 'admin_areas.geojson')
ROADS_FILE = os.path.join(SOURCE_DIR, 'roads.geojson')

# Padded Quezon City bounding box: (minLng, minLat, maxLng, maxLat)
QC_BBOX = (121.00, 14.57, 121.22, 14.82)

# Max nodes per barangay — filters out region-level admin areas (Metro Manila, districts, etc.)
# Real QC barangays top out around 10k nodes; anything above this is a non-barangay admin boundary.
MAX_NODES = 15000

# ── Helpers ────────────────────────────────────────────────────────────────────

def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return round(2 * R * math.asin(math.sqrt(a)), 4)


def name_to_slug(name):
    s = name.lower()
    s = s.replace('ñ', 'n').replace('ü', 'u').replace('é', 'e').replace('ó', 'o')
    s = re.sub(r"[^a-z0-9\s]", '', s)
    s = re.sub(r'\s+', '-', s.strip())
    return s


def extract_boundary_coords(geom):
    """Extract exterior ring of a polygon geometry as [{lat, lng}, ...].
    For MultiPolygon, uses the largest polygon by area."""
    if isinstance(geom, MultiPolygon):
        geom = max(geom.geoms, key=lambda g: g.area)
    if not hasattr(geom, 'exterior'):
        return []
    # GeoJSON coords are (lng, lat) — swap to {lat, lng}; drop duplicate closing vertex
    return [{"lat": round(lat, 7), "lng": round(lng, 7)}
            for lng, lat in list(geom.exterior.coords)[:-1]]


def extract_linestrings(geom):
    """Recursively extract all LineString parts from any geometry type."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        result = []
        for g in geom.geoms:
            result.extend(extract_linestrings(g))
        return result
    return []


def build_network(clipped_roads):
    """
    Convert clipped road GeoDataFrame into nodes + edges in road_network.json format.

    GeoJSON coordinates are (lng, lat) — we store as {lat, lng} to match the
    existing schema used throughout the server and client.
    """
    node_lookup = {}   # "lat,lng" string -> node id
    nodes = []
    edges = []
    edge_set = set()
    counter = 0

    def get_node(lat, lng):
        nonlocal counter
        # Round to 7 decimal places (~1 cm precision) for deduplication
        key = f"{lat:.7f},{lng:.7f}"
        if key not in node_lookup:
            nid = f"n{counter}"
            node_lookup[key] = nid
            nodes.append({"id": nid, "lat": round(lat, 7), "lng": round(lng, 7)})
            counter += 1
        return node_lookup[key]

    for geom in clipped_roads.geometry:
        for line in extract_linestrings(geom):
            coords = list(line.coords)   # each coord is (lng, lat) in GeoJSON
            for i in range(len(coords) - 1):
                lng1, lat1 = coords[i][0],     coords[i][1]
                lng2, lat2 = coords[i + 1][0], coords[i + 1][1]

                id1 = get_node(lat1, lng1)
                id2 = get_node(lat2, lng2)

                if id1 == id2:
                    continue   # zero-length segment — skip

                n1 = int(id1[1:])
                n2 = int(id2[1:])
                edge_key = f"{min(n1, n2)}|{max(n1, n2)}"

                if edge_key not in edge_set:
                    edge_set.add(edge_key)
                    w = haversine(lat1, lng1, lat2, lng2)
                    edges.append({"from": id1, "to": id2, "weight": w})

    return nodes, edges


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # ── Load admin boundaries filtered to QC area ──────────────────────────────
    print("Loading admin areas (filtering to QC bbox)...")
    admin = gpd.read_file(ADMIN_FILE, bbox=QC_BBOX)
    print(f"  {len(admin)} features found in QC bounding box")

    # Keep only barangay-level boundaries (admin_level=10) if the column exists
    if 'admin_level' in admin.columns:
        admin = admin[admin['admin_level'].astype(str) == '10']
        print(f"  {len(admin)} barangay-level features after admin_level=10 filter")
    else:
        print("  No admin_level column found — processing all features in bbox")

    # Ensure WGS84
    if admin.crs and admin.crs.to_epsg() != 4326:
        admin = admin.to_crs(epsg=4326)

    # ── Load roads filtered to QC area ─────────────────────────────────────────
    print("Loading roads (filtering to QC bbox — may take a moment)...")
    roads = gpd.read_file(ROADS_FILE, bbox=QC_BBOX)
    print(f"  {len(roads)} road features loaded")

    if roads.crs and roads.crs.to_epsg() != 4326:
        roads = roads.to_crs(epsg=4326)

    # ── Per-barangay processing ────────────────────────────────────────────────
    manifest = {}
    skipped = []

    print(f"\nProcessing {len(admin)} barangays...\n")

    for idx, (_, row) in enumerate(admin.iterrows(), 1):
        name = str(row.get('name', '')).strip()
        if not name:
            continue

        slug = name_to_slug(name)
        polygon = row.geometry

        # Clip roads to this barangay boundary — cuts road lines at the polygon edge
        try:
            clipped = gpd.clip(roads, polygon)
        except Exception as e:
            print(f"  [{idx}/{len(admin)}] ⚠  {name} — clip failed: {e}")
            skipped.append(name)
            continue

        if clipped.empty:
            print(f"  [{idx}/{len(admin)}] ⚠  {name} — no roads inside boundary, skipped")
            skipped.append(name)
            continue

        nodes, edges = build_network(clipped)

        if not nodes or not edges:
            print(f"  [{idx}/{len(admin)}] ⚠  {name} — no road segments extracted, skipped")
            skipped.append(name)
            continue

        if len(nodes) > MAX_NODES:
            print(f"  [{idx}/{len(admin)}] ⚠  {name} — {len(nodes)} nodes exceeds MAX_NODES ({MAX_NODES}), skipped (region-level area)")
            skipped.append(name)
            continue

        # Bounding box from actual road nodes (tighter than admin polygon)
        lats = [n['lat'] for n in nodes]
        lngs = [n['lng'] for n in nodes]
        bbox = {
            "south": round(min(lats), 7),
            "west":  round(min(lngs), 7),
            "north": round(max(lats), 7),
            "east":  round(max(lngs), 7)
        }

        boundary = extract_boundary_coords(polygon)

        out_path = os.path.join(OUTPUT_DIR, f"{slug}.json")
        with open(out_path, 'w') as f:
            json.dump({"nodes": nodes, "edges": edges, "boundary": boundary}, f)

        manifest[name] = {"slug": slug, "bbox": bbox}
        print(f"  [{idx}/{len(admin)}] ✓  {name}: {len(nodes)} nodes, {len(edges)} edges → {slug}.json")

    # ── Write manifest ─────────────────────────────────────────────────────────
    manifest_path = os.path.join(OUTPUT_DIR, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"\n{'─' * 60}")
    print(f"Done.  {len(manifest)} barangays processed,  {len(skipped)} skipped.")
    print(f"Manifest → {manifest_path}")
    if skipped:
        print(f"\nSkipped ({len(skipped)}): {', '.join(skipped)}")


if __name__ == '__main__':
    main()
