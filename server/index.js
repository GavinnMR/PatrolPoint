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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0' });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/network', networkRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/export', exportRouter);

// Catch-all: serve frontend for any non-API GET
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// WebSocket connection handler — delegates to pipelineSocket.js
wss.on('connection', (ws, req) => {
    handlePipelineConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
runMigration().then(() => {
    httpServer.listen(PORT, () => {
        console.log(`PatrolPoint V2 server running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
});
