import { Router } from 'express';
import { getOrFetchNetwork } from '../services/cache.js';

const router = Router();

// GET /api/network/:barangay
// Returns network summary — full nodes/edges are served via WebSocket during pipeline
router.get('/:barangay', async (req, res) => {
    try {
        const { barangay } = req.params;

        // TODO Build Step 6: replace with validateBarangay(barangay) from middleware/sanitize.js
        if (!barangay || !/^[a-zA-Z0-9 ]{1,255}$/.test(barangay)) {
            return res.status(400).json({ error: 'Invalid barangay name.' });
        }

        const data = await getOrFetchNetwork(barangay);

        res.json({
            barangay,
            nodeCount: data.nodeCount,
            edgeCount: data.edgeCount,
            intersectionCount: data.intersectionCount,
            bbox: data.bbox,
            boundary: data.boundary,
            fromCache: data.fromCache
        });
    } catch (err) {
        console.error('Network route error:', err);
        if (err.message.includes('No bounding box')) {
            return res.status(400).json({ error: err.message });
        }
        if (err.message.includes('Overpass')) {
            return res.status(503).json({ error: 'Road network data temporarily unavailable. Please try again later.' });
        }
        res.status(500).json({ error: 'Failed to load road network.' });
    }
});

export default router;
