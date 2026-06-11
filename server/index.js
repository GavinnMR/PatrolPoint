import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import authRouter from './routes/auth.js';
import networkRouter from './routes/network.js';
import sessionsRouter from './routes/sessions.js';
import exportRouter from './routes/export.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { handlePipelineConnection } from './websocket/pipelineSocket.js';
import pool from './db/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEMO_MODE = process.env.DEMO_MODE === 'true';
if (DEMO_MODE) console.log('PatrolPoint running in DEMO_MODE — auth, sessions, and export disabled');

// ── Startup DB migration — run schema.sql on every boot ───────────────────────
// schema.sql uses CREATE TABLE IF NOT EXISTS — safe to run repeatedly.
// pg does not support multiple statements in one query() call, so split on ';'
// and execute each non-empty statement individually.
// Runs before the server accepts connections so tables exist for all requests.
async function runMigration() {
    try {
        const schemaPath = path.join(__dirname, 'db', 'schema.sql');
        const schema     = fs.readFileSync(schemaPath, 'utf8');
        const statements = schema.split(';').map(s => s.trim()).filter(Boolean);
        const client     = await pool.connect();
        try {
            for (const stmt of statements) {
                await client.query(stmt);
            }
            console.log(`DB migration complete — ${statements.length} statements executed`);
        } finally {
            client.release();
        }
    } catch (err) {
        // Non-fatal: log and continue. The server can still serve requests
        // that don't require auth or sessions. Road network falls back to Overpass.
        console.error('DB migration failed (non-fatal):', err.message);
    }
}

const app = express();
const httpServer = http.createServer(app);

// WebSocket server shares port with Express
const wss = new WebSocketServer({ server: httpServer });

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? /\.onrender\.com$/
        : '*'
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

// Rate limiter — applied to all /api routes only
app.use('/api', apiLimiter);

// Config endpoint — tells the client whether demo mode is active
app.get('/api/config', (req, res) => {
    res.json({ demoMode: DEMO_MODE });
});

// Health check — includes DB reachability so we can diagnose Render connectivity
app.get('/health', async (req, res) => {
    let dbStatus = 'ok';
    let dbError  = null;
    try {
        await pool.query('SELECT 1');
    } catch (err) {
        dbStatus = 'error';
        dbError  = err.message;
    }
    res.json({
        status: dbStatus === 'ok' ? 'ok' : 'degraded',
        version: '2.0',
        db: dbStatus,
        dbError: dbError || undefined,
        dbUrl: process.env.DATABASE_URL ? 'set' : 'NOT SET'
    });
});

// Routes — auth/sessions/export disabled in demo mode
const demoDisabled = (_, res) => res.status(503).json({ error: 'This feature is disabled in demo mode.' });
app.use('/api/auth',     DEMO_MODE ? demoDisabled : authRouter);
app.use('/api/network',  networkRouter);
app.use('/api/sessions', DEMO_MODE ? demoDisabled : sessionsRouter);
app.use('/api/export',   DEMO_MODE ? demoDisabled : exportRouter);

// Catch-all: serve frontend for any non-API GET
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// WebSocket connection handler — delegates to pipelineSocket.js
wss.on('connection', (ws, req) => {
    handlePipelineConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
(DEMO_MODE ? Promise.resolve() : runMigration()).then(() => {
    httpServer.listen(PORT, () => {
        console.log(`PatrolPoint V2 server running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
});
