// server/algorithms/convexHull.js
// Stage 1: Brute Force Convex Hull — V2 backend implementation.
// Pure ESM module — no browser globals, no side effects.
//
// V2 additions over V1:
//   • Incremental hull update: if all new incidents fall inside previousHull, skip recomputation.
//   • WebSocket progress callback (pushProgress) called after pre-filtering.
//   • Valid candidates cache (hullCache) returned and accepted as input for reuse across runs.
//
// haversineDistance is imported from dijkstra.js — never reimplemented inline.

import { haversineDistance } from './dijkstra.js';

// ── Ray Casting ───────────────────────────────────────────────────────────────
// Cast a ray rightward (+lng direction) from point, count hull edge crossings.
// Odd crossings → inside hull. Assumes CCW winding (enforced by winding normalization).
function rayCast(point, hull) {
    let crossings = 0;
    const m = hull.length;
    for (let i = 0; i < m; i++) {
        const a = hull[i], b = hull[(i + 1) % m];
        if ((a.lat <= point.lat && b.lat > point.lat) ||
            (b.lat <= point.lat && a.lat > point.lat)) {
            const t = (point.lat - a.lat) / (b.lat - a.lat);
            if (a.lng + t * (b.lng - a.lng) > point.lng) crossings++;
        }
    }
    return crossings % 2 === 1;
}

// Bounding box pre-filter then full ray cast.
// eps is CONFIG.snapping.boundingBoxEpsilon — expands bbox to avoid boundary float issues.
export function isPointInHull(point, hull, eps = 1e-7) {
    if (!hull || hull.length < 3) return false;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const v of hull) {
        if (v.lat < minLat) minLat = v.lat;
        if (v.lat > maxLat) maxLat = v.lat;
        if (v.lng < minLng) minLng = v.lng;
        if (v.lng > maxLng) maxLng = v.lng;
    }
    if (point.lat < minLat - eps || point.lat > maxLat + eps ||
        point.lng < minLng - eps || point.lng > maxLng + eps) return false;
    return rayCast(point, hull);
}

// ── Hull cache comparison ─────────────────────────────────────────────────────
// Vertex-by-vertex coordinate comparison using collinearity epsilon tolerance.
function hullsEqual(hull1, hull2, eps) {
    if (!hull1 || !hull2 || hull1.length !== hull2.length) return false;
    return hull1.every((v, i) =>
        Math.abs(v.lat - hull2[i].lat) < eps &&
        Math.abs(v.lng - hull2[i].lng) < eps
    );
}

// ── Ray Casting pre-filter ────────────────────────────────────────────────────
// Filter all road nodes inside hull.
// Bounding box pre-filter rejects obviously-outside nodes before full ray cast.
// eps expands the bbox by CONFIG.snapping.boundingBoxEpsilon on all sides.
function runRayCastPreFilter(hull, nodeMap, eps) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const v of hull) {
        if (v.lat < minLat) minLat = v.lat;
        if (v.lat > maxLat) maxLat = v.lat;
        if (v.lng < minLng) minLng = v.lng;
        if (v.lng > maxLng) maxLng = v.lng;
    }
    minLat -= eps; maxLat += eps; minLng -= eps; maxLng += eps;

    const candidates = [];
    let totalNodes   = 0;
    let bboxRejected = 0;
    let rayCastRejected = 0;

    for (const id in nodeMap) {
        totalNodes++;
        const node = nodeMap[id];
        if (node.lat < minLat || node.lat > maxLat || node.lng < minLng || node.lng > maxLng) {
            bboxRejected++;
            continue;
        }
        if (rayCast(node, hull)) {
            candidates.push(node);
        } else {
            rayCastRejected++;
        }
    }
    return { candidates, totalNodes, bboxRejected, rayCastRejected };
}

// ── Linear placement ──────────────────────────────────────────────────────────
// position_k = (k × L) / (n + 1) for k = 1..n
// Dividing by n+1 places patrols inward from both endpoints with equal buffer on both sides.
function computeLinearPositions(points, n) {
    // Sort all points by projection onto line direction to find the extreme endpoints
    const A = points[0];
    const dlat = points[points.length - 1].lat - A.lat;
    const dlng = points[points.length - 1].lng - A.lng;
    const sorted = points.slice().sort((p, q) => {
        const pp = (p.lat - A.lat) * dlat + (p.lng - A.lng) * dlng;
        const pq = (q.lat - A.lat) * dlat + (q.lng - A.lng) * dlng;
        return pp - pq;
    });
    const first = sorted[0], last = sorted[sorted.length - 1];
    const lineLength = haversineDistance(first.lat, first.lng, last.lat, last.lng);

    const positions = [];
    for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        positions.push({
            lat: first.lat + t * (last.lat - first.lat),
            lng: first.lng + t * (last.lng - first.lng)
        });
    }
    return { positions, lineLength };
}

// Build and return a formatted linear handler result. edgeCount is null when called
// before brute-force hull computation (two_points, collinear triggers).
function makeLinearResult(points, n, reason, message, warnings, outlierIndices, log, edgeCount = null) {
    const { positions, lineLength } = computeLinearPositions(points, n);
    const patrolSpacing = lineLength / (positions.length + 1);
    log.push(`Linear handler: line length ${Math.round(lineLength)}m, ${positions.length} patrol position${positions.length !== 1 ? 's' : ''} placed, spacing ~${Math.round(patrolSpacing)}m`);
    return {
        status: 'warning',
        message,
        warnings,
        data: {
            hull: null,
            hullAreaDeg: null,
            hullAreaM2: null,
            validCandidates: null,
            filteredCount: points.length,
            outlierCount: outlierIndices.length,
            outlierIndices,
            validEdgesCount: edgeCount,
            linearHandler: { triggered: true, reason, patrolPositions: positions, lineLength, patrolSpacing },
            traceLog: log,
            skipped: false,
            updatedHullCache: null
        }
    };
}

// ── Main export ───────────────────────────────────────────────────────────────
// incidents:        Array<{lat, lng}> — current incident coordinates
// n:                number of patrols (used by linear handler for equidistant placement)
// config:           CONFIG object with convexHull, snapping sections
// networkData:      { intersectionNodeIds: string[], nodeMap: Object, barangayAreaM2: number }
// options.previousHull:           Array<{lat,lng}> | null — hull from last pipeline run
// options.previousValidCandidates Array<node> | null — validCandidates from last run
// options.previousIncidents:      Array<{lat,lng}> | null — incidents from last run (needed for
//                                   correct new-point detection in incremental update)
// options.pushProgress:           function | null — WebSocket callback, called after pre-filtering
// options.hullCache:              { hull, candidates } | null — valid-candidates cache across runs
export function runConvexHull(incidents, n, config, networkData, options = {}) {
    const {
        previousHull = null,
        previousValidCandidates = null,
        previousIncidents = null,
        pushProgress = null,
        hullCache = null
    } = options;

    const { nodeMap, barangayAreaM2 } = networkData;
    const eps    = config.snapping.boundingBoxEpsilon;       // 1e-7
    const colEps = config.convexHull.collinearityEpsilon;    // 1e-10

    const log      = [];
    const warnings = [];

    // ── V2: Incremental hull update ───────────────────────────────────────────
    // This check runs BEFORE outlier detection per spec ordering.
    // If previousHull is null (first pipeline run) skip this block entirely.
    if (previousHull && previousHull.length >= 3 && previousValidCandidates) {

        if (previousIncidents) {
            // Find "new" points: in current incidents but not in previous (by lat/lng proximity)
            const newPoints = incidents.filter(p =>
                !previousIncidents.some(
                    q => Math.abs(p.lat - q.lat) < eps && Math.abs(p.lng - q.lng) < eps
                )
            );

            if (newPoints.length === 0) {
                // No new points added — check whether any previous incident was removed
                const anyRemoved = previousIncidents.some(q =>
                    !incidents.some(
                        p => Math.abs(p.lat - q.lat) < eps && Math.abs(p.lng - q.lng) < eps
                    )
                );

                if (!anyRemoved) {
                    // Incident set is identical — hull is guaranteed unchanged
                    log.push('Incremental hull update: incident set identical to previous run - skipping full computation.');
                    return {
                        status: 'success',
                        message: 'Hull unchanged - incident set identical to previous run.',
                        warnings: [],
                        data: {
                            hull: previousHull,
                            hullAreaDeg: null,
                            hullAreaM2: null,
                            validCandidates: previousValidCandidates,
                            filteredCount: incidents.length,
                            outlierCount: 0,
                            outlierIndices: [],
                            validEdgesCount: null,
                            linearHandler: { triggered: false },
                            traceLog: log,
                            skipped: true,
                            updatedHullCache: hullCache
                        }
                    };
                }
                // Points were removed — hull may have shrunk; must recompute
                log.push('Incremental hull update: incident(s) removed since last run - hull may have changed. Recomputing.');

            } else {
                // New points exist — check if all fall inside previousHull
                const allNewInside = newPoints.every(p => isPointInHull(p, previousHull, eps));
                if (allNewInside) {
                    log.push(`Incremental hull update: ${newPoints.length} new incident(s) all inside previous hull - hull unchanged. Skipping full computation.`);
                    return {
                        status: 'success',
                        message: 'Hull unchanged - all new incidents fall inside previous danger zone.',
                        warnings: [],
                        data: {
                            hull: previousHull,
                            hullAreaDeg: null,
                            hullAreaM2: null,
                            validCandidates: previousValidCandidates,
                            filteredCount: incidents.length,
                            outlierCount: 0,
                            outlierIndices: [],
                            validEdgesCount: null,
                            linearHandler: { triggered: false },
                            traceLog: log,
                            skipped: true,
                            updatedHullCache: hullCache
                        }
                    };
                }
                log.push(`Incremental hull update: new incident(s) outside previous hull - recomputing.`);
            }

        } else {
            // previousIncidents not provided — conservative fallback: check ALL current incidents
            // This correctly handles "new interior point" additions but will conservatively
            // return previousHull if a hull-defining point was removed (hull would be too large).
            // Pipeline should pass previousIncidents for correct behavior.
            const allInside = incidents.every(p => isPointInHull(p, previousHull, eps));
            if (allInside) {
                log.push('Incremental hull update (conservative): all current incidents inside previous hull - skipping recomputation.');
                return {
                    status: 'success',
                    message: 'Hull unchanged - all current incidents inside previous danger zone.',
                    warnings: [],
                    data: {
                        hull: previousHull,
                        hullAreaDeg: null,
                        hullAreaM2: null,
                        validCandidates: previousValidCandidates,
                        filteredCount: incidents.length,
                        outlierCount: 0,
                        outlierIndices: [],
                        validEdgesCount: null,
                        linearHandler: { triggered: false },
                        traceLog: log,
                        skipped: true,
                        updatedHullCache: hullCache
                    }
                };
            }
            log.push('Incremental hull update: incident(s) outside previous hull - recomputing.');
        }
    }

    // ── Step 1: Outlier detection ─────────────────────────────────────────────
    let filtered      = incidents.slice();
    let outlierIndices = [];

    if (!config.convexHull.includeOutliers && incidents.length >= 3) {
        const centLat = incidents.reduce((s, p) => s + p.lat, 0) / incidents.length;
        const centLng = incidents.reduce((s, p) => s + p.lng, 0) / incidents.length;
        const dists   = incidents.map(p => haversineDistance(centLat, centLng, p.lat, p.lng));
        const avg     = dists.reduce((s, d) => s + d, 0) / dists.length;
        const threshold = config.convexHull.outlierMultiplier * avg;

        filtered = [];
        dists.forEach((d, i) => {
            if (d > threshold) {
                outlierIndices.push(i);
                log.push(`Outlier: incident[${i}] (${incidents[i].lat.toFixed(6)}, ${incidents[i].lng.toFixed(6)}) dist=${Math.round(d)}m > threshold=${Math.round(threshold)}m`);
            } else {
                filtered.push(incidents[i]);
            }
        });

        if (outlierIndices.length > 0) {
            warnings.push(`${outlierIndices.length} outlier${outlierIndices.length !== 1 ? 's' : ''} detected and flagged.`);
            log.push(`Outlier detection: ${outlierIndices.length} flagged, ${filtered.length} remaining`);
        } else {
            log.push('Outlier detection: none flagged');
        }

        if (filtered.length < 3) {
            log.push(`Only ${filtered.length} non-outlier incident(s) remain - insufficient for hull`);
            return {
                status: 'warning',
                message: 'Outlier removal reduced incident points below minimum required for danger zone computation. Either plot more points or adjust the outlier sensitivity in Settings.',
                warnings,
                data: {
                    hull: null,
                    hullAreaDeg: null,
                    hullAreaM2: null,
                    validCandidates: null,
                    filteredCount: filtered.length,
                    outlierCount: outlierIndices.length,
                    outlierIndices,
                    validEdgesCount: null,
                    linearHandler: { triggered: false },
                    traceLog: log,
                    skipped: false,
                    updatedHullCache: null
                }
            };
        }
    } else {
        log.push('Outlier detection: skipped');
    }

    log.push(`After outlier removal: ${filtered.length} incident(s)`);

    // ── Step 2: Validity check ────────────────────────────────────────────────
    if (filtered.length === 2) {
        log.push('Only 2 non-outlier incidents - triggering linear handler');
        return makeLinearResult(
            filtered, n, 'two_points',
            'Only 2 incident coordinates plotted. Patrols placed along incident line. Plot at least 3 non-collinear points for full danger zone analysis.',
            warnings, outlierIndices, log
        );
    }

    // ── Step 3: Collinearity check — O(n) ────────────────────────────────────
    // Fix first two points A and B as baseline. Test every remaining point C.
    // Shoelace convention: x = lng, y = lat — consistent throughout this file.
    const A = filtered[0], B = filtered[1];
    let allCollinear = true;
    for (let i = 2; i < filtered.length; i++) {
        const C = filtered[i];
        const k = (B.lng - A.lng) * (C.lat - A.lat) - (B.lat - A.lat) * (C.lng - A.lng);
        if (Math.abs(k) >= colEps) { allCollinear = false; break; }
    }

    if (allCollinear) {
        log.push('Collinearity check: all incidents collinear - triggering linear handler');
        return makeLinearResult(
            filtered, n, 'collinear',
            'All incident coordinates are collinear. Patrols placed along the incident line. Plot points in different directions for full danger zone analysis.',
            warnings, outlierIndices, log
        );
    }
    log.push('Collinearity check: passed');

    // ── Step 4: Brute Force Convex Hull — O(n³) ──────────────────────────────
    // For each ordered pair (pi, pj), compute cross product d for every other point pk.
    // Shoelace convention: x = lng, y = lat — consistent throughout this file.
    //   d > 0 → pk is to the LEFT of directed edge pi→pj (CCW orientation)
    //   d < 0 → pk is to the RIGHT — disqualify this directed edge
    //   d = 0 → pk lies on the line — allowed (collinear on boundary)
    // Keep only directed edges where all remaining points have d >= 0 (CCW direction).
    const validEdges = [];
    for (let i = 0; i < filtered.length; i++) {
        for (let j = 0; j < filtered.length; j++) {
            if (i === j) continue;
            const pi = filtered[i], pj = filtered[j];
            let valid = true;
            for (let k = 0; k < filtered.length; k++) {
                if (k === i || k === j) continue;
                const pk = filtered[k];
                const d = (pj.lng - pi.lng) * (pk.lat - pi.lat) -
                          (pj.lat - pi.lat) * (pk.lng - pi.lng);
                if (d < 0) { valid = false; break; }
            }
            if (valid) validEdges.push({ from: pi, to: pj });
        }
    }
    log.push(`Brute force hull: ${validEdges.length} valid directed edges found`);

    // ── Step 5: Edge count validation ────────────────────────────────────────
    if (validEdges.length < 3) {
        log.push('Fewer than 3 valid hull edges - triggering linear handler');
        return makeLinearResult(
            filtered, n, 'few_edges',
            'Incident coordinates are too nearly collinear to form a valid danger zone. Patrols placed along incident line.',
            warnings, outlierIndices, log, validEdges.length
        );
    }

    // ── Step 6: Edge ordering ─────────────────────────────────────────────────
    // Sort collected hull edges into a connected polygon sequence.
    // Start with any edge; find the next edge whose from-point matches the current to-point.
    // Error if no connecting edge found — hull is topologically broken.
    const remaining = validEdges.slice();
    const ordered   = [remaining.shift()];
    while (remaining.length > 0) {
        const last    = ordered[ordered.length - 1];
        const nextIdx = remaining.findIndex(e =>
            Math.abs(e.from.lat - last.to.lat) < 1e-9 &&
            Math.abs(e.from.lng - last.to.lng) < 1e-9
        );
        if (nextIdx === -1) {
            log.push('Edge ordering failed - no connecting edge found');
            return {
                status: 'error',
                message: 'Danger zone boundary could not be constructed. Please try different incident coordinates.',
                warnings,
                data: {
                    hull: null,
                    hullAreaDeg: null,
                    hullAreaM2: null,
                    validCandidates: null,
                    filteredCount: filtered.length,
                    outlierCount: outlierIndices.length,
                    outlierIndices,
                    validEdgesCount: validEdges.length,
                    linearHandler: { triggered: false },
                    traceLog: log,
                    skipped: false,
                    updatedHullCache: null
                }
            };
        }
        ordered.push(remaining.splice(nextIdx, 1)[0]);
    }

    const hull = ordered.map(e => ({ lat: e.from.lat, lng: e.from.lng }));
    log.push(`Edge ordering: success - ${hull.length} hull vertices`);

    // ── Step 7: Shoelace area ─────────────────────────────────────────────────
    // Shoelace convention: lng is x, lat is y — must be consistent throughout this file.
    let signedArea = 0;
    const m = hull.length;
    for (let i = 0; i < m; i++) {
        const curr = hull[i], next = hull[(i + 1) % m];
        signedArea += curr.lng * next.lat - next.lng * curr.lat;
    }
    signedArea /= 2;

    // ── Step 8: Winding order normalization ───────────────────────────────────
    // Positive signed area → CCW (correct). Negative → CW → reverse to force CCW.
    // All Ray Casting logic assumes CCW winding consistently.
    let windingReversed = false;
    if (signedArea < 0) {
        hull.reverse();
        signedArea = -signedArea;
        windingReversed = true;
        log.push('Winding order: reversed to counterclockwise');
    } else {
        log.push('Winding order: already counterclockwise');
    }

    const hullAreaDeg = Math.abs(signedArea);

    // ── Step 9: Hull area validation ──────────────────────────────────────────
    if (hullAreaDeg <= 0) {
        return {
            status: 'error',
            message: 'Danger zone has zero area. Please try different incident coordinates.',
            warnings,
            data: {
                hull: null,
                hullAreaDeg: null,
                hullAreaM2: null,
                validCandidates: null,
                filteredCount: filtered.length,
                outlierCount: outlierIndices.length,
                outlierIndices,
                validEdgesCount: validEdges.length,
                linearHandler: { triggered: false },
                traceLog: log,
                skipped: false,
                updatedHullCache: null
            }
        };
    }

    // Convert deg² → m² using dynamic longitude scale factor at hull centroid.
    // lngScale = 111000 × cos(centroid_lat) accounts for longitude compression at higher latitudes.
    const centroidLat = hull.reduce((s, v) => s + v.lat, 0) / hull.length;
    const lngScale    = 111000 * Math.cos(centroidLat * Math.PI / 180);
    const hullAreaM2  = hullAreaDeg * 111000 * lngScale;
    log.push(`Hull area (approx.): ${Math.round(hullAreaM2)} m² — Shoelace flat-plane estimate, accurate to <1% at barangay scale`);


    // ── Step 10: Ray Casting pre-filter ───────────────────────────────────────
    // MUST run after hull validation and winding normalization — never before.
    // Check valid candidates cache first: if hull vertices match cached hull, skip Ray Casting.
    let validCandidates;
    let updatedHullCache;

    let rayCastStats = null;
    if (hullCache && hullsEqual(hull, hullCache.hull, colEps)) {
        validCandidates  = hullCache.candidates;
        updatedHullCache = hullCache;
        log.push(`Valid candidates: cache hit - reusing ${validCandidates.length} cached candidates (hull unchanged)`);
    } else {
        const rcResult   = runRayCastPreFilter(hull, nodeMap, eps);
        validCandidates  = rcResult.candidates;
        rayCastStats = {
            totalNodes:      rcResult.totalNodes,
            bboxRejected:    rcResult.bboxRejected,
            rayCastRejected: rcResult.rayCastRejected,
            passed:          rcResult.candidates.length
        };
        // Deep-copy hull vertices into cache to prevent mutation by downstream code
        updatedHullCache = {
            hull:       hull.map(v => ({ lat: v.lat, lng: v.lng })),
            candidates: validCandidates
        };
        log.push(
            `Ray Cast: ${rcResult.totalNodes} nodes checked — ` +
            `${rcResult.bboxRejected} rejected by bbox pre-filter, ` +
            `${rcResult.rayCastRejected} failed ray cast, ` +
            `${validCandidates.length} passed (valid candidates)`
        );
    }

    // WebSocket progress callback — called after pre-filtering with hull metrics (V2 feature)
    if (typeof pushProgress === 'function') {
        pushProgress({
            stage: 1,
            validCandidateCount: validCandidates.length,
            hullVertexCount: hull.length,
            hullAreaM2
        });
    }

    // ── Empty valid candidates ────────────────────────────────────────────────
    // Keep hull polygon in result so pipeline can highlight nearest outside intersections.
    if (validCandidates.length === 0) {
        log.push('No intersection nodes found inside hull - cannot place any patrols');

        // Find 5 nearest intersection nodes to hull centroid — all are outside the hull
        const centLat = hull.reduce((s, v) => s + v.lat, 0) / hull.length;
        const centLng = hull.reduce((s, v) => s + v.lng, 0) / hull.length;
        const nearestHighlights = Object.keys(nodeMap)
            .map(id => ({ id, lat: nodeMap[id].lat, lng: nodeMap[id].lng,
                dist: haversineDistance(centLat, centLng, nodeMap[id].lat, nodeMap[id].lng) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 5)
            .map(({ id, lat, lng }) => ({ id, lat, lng }));

        return {
            status: 'error',
            message: 'No road intersections found inside the danger zone. Please plot incident coordinates closer to road intersections or expand the incident area.',
            warnings,
            data: {
                hull,
                hullAreaDeg,
                hullAreaM2,
                validCandidates: [],
                nearestHighlights,
                filteredCount: filtered.length,
                outlierCount: outlierIndices.length,
                outlierIndices,
                validEdgesCount: validEdges.length,
                linearHandler: { triggered: false },
                windingReversed,
                rayCastStats,
                traceLog: log,
                skipped: false,
                updatedHullCache
            }
        };
    }

    log.push(`Stage 1 complete - ${hull.length} hull vertices, ${Math.round(hullAreaM2)} m², ${validCandidates.length} valid candidates`);

    return {
        status: 'success',
        message: 'Danger zone boundary computed successfully.',
        warnings,
        data: {
            hull,
            hullAreaDeg,
            hullAreaM2,
            validCandidates,
            filteredCount: filtered.length,
            outlierCount: outlierIndices.length,
            outlierIndices,
            validEdgesCount: validEdges.length,
            linearHandler: { triggered: false },
            windingReversed,
            rayCastStats,
            traceLog: log,
            skipped: false,
            updatedHullCache
        }
    };
}
