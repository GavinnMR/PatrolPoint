// Stage 1: Brute Force Convex Hull

function computeConvexHull(points, n, config) {
    const log = [];
    const warnings = [];
    const eps = config.convexHull.collinearityEpsilon;

    // ── Step 1: Outlier detection ──────────────────────────────
    let filtered = points.slice();
    let outlierIndices = [];

    if (!config.convexHull_includeOutliers && points.length >= 3) {
        const centLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const centLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        const dists = points.map(p => haversineDistance(centLat, centLng, p.lat, p.lng));
        const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
        const threshold = config.convexHull.outlierMultiplier * avg;

        filtered = [];
        dists.forEach((d, i) => {
            if (d > threshold) {
                outlierIndices.push(i);
                log.push(`Outlier: point[${i}] (${points[i].lat.toFixed(6)}, ${points[i].lng.toFixed(6)}) dist=${Math.round(d)}m > threshold=${Math.round(threshold)}m`);
            } else {
                filtered.push(points[i]);
            }
        });

        if (outlierIndices.length > 0) {
            warnings.push(`${outlierIndices.length} outlier${outlierIndices.length !== 1 ? 's' : ''} detected and flagged.`);
            log.push(`Outlier detection: ${outlierIndices.length} flagged, ${filtered.length} remaining`);
        } else {
            log.push('Outlier detection: none flagged');
        }

        if (filtered.length < 3) {
            log.push(`Only ${filtered.length} non-outlier point(s) remain — insufficient for hull`);
            return {
                status: 'warning',
                message: 'Outlier removal reduced incident points below minimum required for danger zone computation. Either plot more points or adjust the outlier sensitivity in Settings.',
                warnings,
                data: { filteredCount: filtered.length, outlierIndices, traceLog: log, linearHandler: { triggered: false } }
            };
        }
    } else {
        log.push('Outlier detection: skipped');
    }

    log.push(`After outlier removal: ${filtered.length} points`);

    // ── Step 2: Validity check ─────────────────────────────────
    if (filtered.length === 2) {
        log.push('Only 2 non-outlier points — triggering linear handler');
        return makeLinearResult(filtered, n, 'two_points',
            'Only 2 incident coordinates plotted. Patrols placed along incident line. Plot at least 3 non-collinear points for full danger zone analysis.',
            warnings, outlierIndices, log);
    }

    // ── Step 3: Collinearity check — O(n) ─────────────────────
    // Fix first two points as baseline, test all others with cross product
    // x = lng, y = lat — consistent with Shoelace convention throughout
    const A = filtered[0], B = filtered[1];
    let allCollinear = true;
    for (let i = 2; i < filtered.length; i++) {
        const C = filtered[i];
        const k = (B.lng - A.lng) * (C.lat - A.lat) - (B.lat - A.lat) * (C.lng - A.lng);
        if (Math.abs(k) >= eps) { allCollinear = false; break; }
    }

    if (allCollinear) {
        log.push('Collinearity check: all points collinear — triggering linear handler');
        return makeLinearResult(filtered, n, 'collinear',
            'All incident coordinates are collinear. Patrols placed along the incident line. Plot points in different directions for full danger zone analysis.',
            warnings, outlierIndices, log);
    }
    log.push('Collinearity check: passed');

    // ── Step 4: Brute force convex hull — O(n³) ───────────────
    // For each ordered pair (pi, pj), the edge is valid if all other points
    // have d >= 0 (on the left of or on the directed edge — CCW orientation)
    // x = lng, y = lat
    const validEdges = [];
    for (let i = 0; i < filtered.length; i++) {
        for (let j = 0; j < filtered.length; j++) {
            if (i === j) continue;
            const pi = filtered[i], pj = filtered[j];
            let valid = true;
            for (let k = 0; k < filtered.length; k++) {
                if (k === i || k === j) continue;
                const pk = filtered[k];
                const d = (pj.lng - pi.lng) * (pk.lat - pi.lat) - (pj.lat - pi.lat) * (pk.lng - pi.lng);
                if (d < 0) { valid = false; break; }
            }
            if (valid) validEdges.push({ from: pi, to: pj });
        }
    }
    log.push(`Brute force hull: ${validEdges.length} valid directed edges found`);

    // ── Step 5: Edge count validation ─────────────────────────
    if (validEdges.length < 3) {
        log.push('Fewer than 3 valid hull edges — triggering linear handler');
        return makeLinearResult(filtered, n, 'few_edges',
            'Incident coordinates are too nearly collinear to form a valid danger zone. Patrols placed along incident line.',
            warnings, outlierIndices, log);
    }

    // ── Step 6: Edge ordering ──────────────────────────────────
    const remaining = validEdges.slice();
    const ordered = [remaining.shift()];
    while (remaining.length > 0) {
        const last = ordered[ordered.length - 1];
        const nextIdx = remaining.findIndex(e =>
            Math.abs(e.from.lat - last.to.lat) < 1e-9 &&
            Math.abs(e.from.lng - last.to.lng) < 1e-9
        );
        if (nextIdx === -1) {
            log.push('Edge ordering failed — no connecting edge found');
            return {
                status: 'error',
                message: 'Danger zone boundary could not be constructed. Please try different incident coordinates.',
                warnings,
                data: { filteredCount: filtered.length, outlierIndices, linearHandler: { triggered: false }, traceLog: log }
            };
        }
        ordered.push(remaining.splice(nextIdx, 1)[0]);
    }

    const hull = ordered.map(e => ({ lat: e.from.lat, lng: e.from.lng }));
    log.push(`Edge ordering: success — ${hull.length} hull vertices`);

    // ── Step 7: Shoelace area ──────────────────────────────────
    // lng as x, lat as y — Shoelace convention: x is lng, y is lat throughout
    let signedArea = 0;
    const m = hull.length;
    for (let i = 0; i < m; i++) {
        const curr = hull[i], next = hull[(i + 1) % m];
        signedArea += curr.lng * next.lat - next.lng * curr.lat;
    }
    signedArea /= 2;

    // ── Step 8: Winding order normalization ────────────────────
    if (signedArea < 0) {
        hull.reverse();
        signedArea = -signedArea;
        log.push('Winding order: reversed to counterclockwise');
    } else {
        log.push('Winding order: already counterclockwise');
    }

    const hullAreaDeg = Math.abs(signedArea);

    // ── Step 9: Hull area validation ──────────────────────────
    if (hullAreaDeg <= 0) {
        return {
            status: 'error',
            message: 'Danger zone has zero area. Please try different incident coordinates.',
            warnings,
            data: { filteredCount: filtered.length, outlierIndices, linearHandler: { triggered: false }, traceLog: log }
        };
    }

    // Convert deg² → m² using dynamic scale factor at hull centroid
    const centroidLat = hull.reduce((s, v) => s + v.lat, 0) / hull.length;
    const lngScale = 111000 * Math.cos(centroidLat * Math.PI / 180);
    const hullAreaM2 = hullAreaDeg * 111000 * lngScale;

    log.push(`Hull area: ${Math.round(hullAreaM2)} m²`);

    // Area threshold check against barangay bounding box area
    let areaWarning = false;
    const areaThreshold = barangayArea_m2 / config.convexHull.areaThresholdDivisor;
    if (hullAreaM2 < areaThreshold) {
        warnings.push('Incident coordinates are tightly clustered. Patrol spread may be limited. Consider spreading incident coordinates across a wider area.');
        areaWarning = true;
        log.push(`Area threshold: WARNING — ${Math.round(hullAreaM2)} m² < ${Math.round(areaThreshold)} m²`);
    } else {
        log.push(`Area threshold: passed (${Math.round(hullAreaM2)} m² >= ${Math.round(areaThreshold)} m²)`);
    }

    return {
        status: areaWarning ? 'warning' : 'success',
        message: areaWarning
            ? 'Danger zone computed — incident coordinates are tightly clustered.'
            : 'Danger zone boundary computed successfully.',
        warnings,
        data: { hull, hullAreaDeg, hullAreaM2, filteredCount: filtered.length, validEdgesCount: validEdges.length, outlierIndices, linearHandler: { triggered: false }, traceLog: log }
    };
}

function makeLinearResult(points, n, reason, message, warnings, outlierIndices, log) {
    const { positions, lineLength } = computeLinearPositions(points, n);
    const patrolSpacing = lineLength / (positions.length + 1);
    log.push(`Linear handler: line length ${Math.round(lineLength)}m, ${positions.length} patrol position${positions.length !== 1 ? 's' : ''} placed, spacing ~${Math.round(patrolSpacing)}m`);
    return {
        status: 'warning',
        message,
        warnings,
        data: {
            filteredCount: points.length,
            outlierIndices,
            linearHandler: { triggered: true, reason, patrolPositions: positions, lineLength, patrolSpacing },
            traceLog: log
        }
    };
}

function computeLinearPositions(points, n) {
    // Sort all points by projection onto line direction to find extreme endpoints
    const A = points[0];
    const dlat = points[points.length - 1].lat - A.lat;
    const dlng = points[points.length - 1].lng - A.lng;
    const sorted = points.slice().sort((p, q) => {
        const pp = (p.lat - A.lat) * dlat + (p.lng - A.lng) * dlng;
        const pq = (q.lat - A.lat) * dlat + (q.lng - A.lng) * dlng;
        return pp - pq;
    });
    const first = sorted[0], last = sorted[sorted.length - 1];
    // L = total line length via Haversine — spec-required intermediate value
    const lineLength = haversineDistance(first.lat, first.lng, last.lat, last.lng);

    // position_k = (k × L) / (n + 1) — equal intervals with buffer on both ends
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
