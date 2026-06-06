import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from './routes/auth.js';
import networkRouter from './routes/network.js';
import { handlePipelineConnection } from './websocket/pipelineSocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0' });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/network', networkRouter);

// Catch-all: serve frontend for any non-API GET
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// WebSocket connection handler — delegates to pipelineSocket.js
wss.on('connection', (ws, req) => {
    handlePipelineConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`PatrolPoint V2 server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
