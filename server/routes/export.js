import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { requireAuth } from '../middleware/auth.js';
import { getSessionById } from '../db/queries.js';

const router = Router();

router.use(requireAuth);

// Resolve results data from either sessionId or direct results in body
async function resolveExportData(body, userId) {
    if (body.sessionId !== undefined) {
        const id = parseInt(body.sessionId, 10);
        if (isNaN(id)) throw new Error('sessionId must be a valid integer.');
        const session = await getSessionById(id, userId);
        if (!session) throw new Error('Session not found or you do not have permission to access it.');
        return {
            barangay_name: session.barangay_name,
            n_patrols: session.n_patrols,
            deployment_mode: session.deployment_mode,
            config: session.config,
            results: session.results,
            session_name: session.session_name,
            created_at: session.created_at
        };
    }
    if (!body.results) throw new Error('Request body must include either sessionId or results.');
    return {
        barangay_name: body.barangay_name || 'Unknown',
        n_patrols: body.n_patrols,
        deployment_mode: body.deployment_mode || 'unknown',
        config: body.config || {},
        results: body.results,
        session_name: body.session_name || null,
        created_at: new Date().toISOString()
    };
}

// POST /api/export/pdf
router.post('/pdf', async (req, res) => {
    try {
        const data = await resolveExportData(req.body, req.user.userId);
        const { barangay_name, n_patrols, deployment_mode, config, results, session_name, created_at } = data;
        const { patrols = [], zones = [], routes = [] } = results;

        const timestamp = new Date(created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

        // Build a quick lookup: patrolId → route info
        const routeByPatrol = {};
        for (const r of routes) {
            routeByPatrol[r.patrolId] = r;
        }

        const doc = new PDFDocument({
            margin: 50,
            size: 'A4',
            info: {
                Title: 'PatrolPoint Deployment Plan',
                Author: 'PatrolPoint System',
                Subject: `Patrol Deployment — ${barangay_name}`
            }
        });
        const buffers = [];
        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(buffers);
            const tsStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Disposition', `attachment; filename="patrolpoint-deployment-${tsStr}.pdf"`);
            res.send(pdf);
        });

        // Title block
        doc.fontSize(20).font('Helvetica-Bold').text('PatrolPoint Deployment Plan', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica').text(`Generated: ${timestamp}`, { align: 'center' });
        doc.moveDown(1.5);

        // Summary section
        doc.fontSize(13).font('Helvetica-Bold').text('Deployment Summary');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica');
        doc.text(`Barangay: ${barangay_name}`);
        doc.text(`Number of Patrols: ${n_patrols}`);
        doc.text(`Deployment Mode: ${deployment_mode.charAt(0).toUpperCase() + deployment_mode.slice(1)}`);
        if (session_name) doc.text(`Session Name: ${session_name}`);
        doc.moveDown(1.5);

        // Patrol positions table
        doc.fontSize(13).font('Helvetica-Bold').text('Patrol Positions');
        doc.moveDown(0.5);

        const colX = { id: 50, lat: 120, lng: 220, zoneSize: 320, circuit: 390, status: 470 };
        const tableTop = doc.y;

        // Header row
        doc.fontSize(9).font('Helvetica-Bold');
        doc.text('Patrol ID', colX.id, tableTop);
        doc.text('Latitude', colX.lat, tableTop);
        doc.text('Longitude', colX.lng, tableTop);
        doc.text('Zone Size', colX.zoneSize, tableTop);
        doc.text('Circuit (m)', colX.circuit, tableTop);
        doc.text('Status', colX.status, tableTop);
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(0.3);

        // Data rows
        doc.font('Helvetica').fontSize(9);
        for (let i = 0; i < patrols.length; i++) {
            const patrol = patrols[i];
            const zoneSize = zones[i] ? zones[i].length : 0;
            const route = routeByPatrol[patrol.id];
            const circuitDist = route ? Math.round(route.circuitDistanceM) : 0;
            const status = zoneSize === 0 ? 'Stationary' : deployment_mode === 'roaming' ? 'Roaming' : 'Stationary';

            const rowY = doc.y;
            doc.text(String(patrol.id), colX.id, rowY);
            doc.text(patrol.lat.toFixed(6), colX.lat, rowY);
            doc.text(patrol.lng.toFixed(6), colX.lng, rowY);
            doc.text(String(zoneSize), colX.zoneSize, rowY);
            doc.text(zoneSize > 1 && deployment_mode === 'roaming' ? String(circuitDist) : '—', colX.circuit, rowY);
            doc.text(status, colX.status, rowY);
            doc.moveDown(0.6);
        }

        doc.moveDown(1);

        // Crime nodes per patrol
        doc.fontSize(13).font('Helvetica-Bold').text('Crime Nodes by Patrol Zone');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(10);

        for (let i = 0; i < patrols.length; i++) {
            const patrol = patrols[i];
            const zoneNodes = zones[i] || [];
            doc.font('Helvetica-Bold').text(`Patrol ${patrol.id} — ${zoneNodes.length} node(s)`);
            doc.font('Helvetica');
            if (zoneNodes.length === 0) {
                doc.text('  No assigned crime nodes — patrol stationary.');
            } else {
                for (const node of zoneNodes) {
                    doc.text(`  ${node.crimeId || 'CRIME'}: (${node.lat?.toFixed(6)}, ${node.lng?.toFixed(6)})`);
                }
            }
            doc.moveDown(0.5);
        }

        doc.moveDown(0.5);

        // Configuration used
        doc.fontSize(13).font('Helvetica-Bold').text('Configuration Used');
        doc.moveDown(0.3);
        doc.font('Courier').fontSize(9);
        doc.text(JSON.stringify(config, null, 2));

        doc.end();
    } catch (err) {
        console.error('PDF export error:', err);
        if (!res.headersSent) {
            const msg = err.message || '';
            const status = (msg.includes('not found') || msg.includes('permission')) ? 404
                : (msg.includes('sessionId') || msg.includes('Request body')) ? 400
                : 500;
            res.status(status).json({ error: msg || 'PDF generation failed. Please try again.' });
        }
    }
});

// POST /api/export/csv
router.post('/csv', async (req, res) => {
    try {
        const data = await resolveExportData(req.body, req.user.userId);
        const { barangay_name, n_patrols, deployment_mode, results } = data;
        const { patrols = [], zones = [], routes = [] } = results;

        const routeByPatrol = {};
        for (const r of routes) {
            routeByPatrol[r.patrolId] = r;
        }

        const lines = [];

        // Section 1: patrol_positions
        lines.push('# patrol_positions');
        lines.push('patrolId,lat,lng,zoneSize,circuitDistanceM,status');
        for (let i = 0; i < patrols.length; i++) {
            const patrol = patrols[i];
            const zoneSize = zones[i] ? zones[i].length : 0;
            const route = routeByPatrol[patrol.id];
            const circuitDist = route ? Math.round(route.circuitDistanceM) : '';
            const status = zoneSize === 0 ? 'stationary' : deployment_mode === 'roaming' ? 'roaming' : 'stationary';
            const circuit = zoneSize > 1 && deployment_mode === 'roaming' ? circuitDist : '';
            lines.push(`${patrol.id},${patrol.lat},${patrol.lng},${zoneSize},${circuit},${status}`);
        }

        lines.push('');

        // Section 2: crime_nodes
        lines.push('# crime_nodes');
        lines.push('crimeId,lat,lng,assignedPatrolId');
        for (let i = 0; i < patrols.length; i++) {
            const patrol = patrols[i];
            const zoneNodes = zones[i] || [];
            for (const node of zoneNodes) {
                const crimeId = node.crimeId || `CRIME-${String(i + 1).padStart(3, '0')}`;
                lines.push(`${crimeId},${node.lat},${node.lng},${patrol.id}`);
            }
        }

        const csv = lines.join('\n');
        const tsStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', `attachment; filename="patrolpoint-deployment-${tsStr}.csv"`);
        res.send(csv);
    } catch (err) {
        console.error('CSV export error:', err);
        const msg = err.message || '';
        const status = (msg.includes('not found') || msg.includes('permission')) ? 404
            : (msg.includes('sessionId') || msg.includes('Request body')) ? 400
            : 500;
        res.status(status).json({ error: msg || 'CSV generation failed. Please try again.' });
    }
});

export default router;
