import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSessionsByUser, getSessionById, saveSession, deleteSession } from '../db/queries.js';

const router = Router();

router.use(requireAuth);

// GET /api/sessions — summaries only (no results or trace)
router.get('/', async (req, res) => {
    try {
        const sessions = await getSessionsByUser(req.user.userId);
        res.json(sessions);
    } catch (err) {
        console.error('Get sessions error:', err);
        res.status(500).json({ error: 'Failed to retrieve sessions. Please try again.' });
    }
});

// GET /api/sessions/:id — full session, ownership verified
router.get('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Session ID must be a valid integer.' });
        }
        const session = await getSessionById(id, req.user.userId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found or you do not have permission to access it.' });
        }
        res.json(session);
    } catch (err) {
        console.error('Get session error:', err);
        res.status(500).json({ error: 'Failed to retrieve session. Please try again.' });
    }
});

// POST /api/sessions — save new session
router.post('/', async (req, res) => {
    try {
        const { session_name, barangay_name, n_patrols, deployment_mode, incidents, config, results, trace, total_runtime_ms } = req.body;

        const missing = [];
        if (!barangay_name) missing.push('barangay_name');
        if (n_patrols === undefined || n_patrols === null) missing.push('n_patrols');
        if (!deployment_mode) missing.push('deployment_mode');
        if (!incidents) missing.push('incidents');
        if (!config) missing.push('config');
        if (!results) missing.push('results');
        if (!trace) missing.push('trace');

        if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}.` });
        }

        const id = await saveSession(req.user.userId, req.body);
        res.status(201).json({ id, message: 'Session saved' });
    } catch (err) {
        console.error('Save session error:', err);
        res.status(500).json({ error: 'Failed to save session. Please try again.' });
    }
});

// DELETE /api/sessions/:id — ownership verified, 404 if not found or wrong user
router.delete('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Session ID must be a valid integer.' });
        }
        const session = await getSessionById(id, req.user.userId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found or you do not have permission to delete it.' });
        }
        await deleteSession(id, req.user.userId);
        res.json({ message: 'Session deleted' });
    } catch (err) {
        console.error('Delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session. Please try again.' });
    }
});

export default router;
