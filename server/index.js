import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import networkRouter from './routes/network.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { handlePipelineConnection } from './websocket/pipelineSocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);

const wss = new WebSocketServer({ server: httpServer });

app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? /\.onrender\.com$/
        : '*'
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/data', express.static(path.join(__dirname, '..', 'data')));
if (process.env.NODE_ENV !== 'production') {
    app.use('/tests', express.static(path.join(__dirname, '..', 'tests')));
}

app.use('/api', apiLimiter);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0' });
});

app.use('/api/network', networkRouter);

// Catch-all: serve frontend for any non-API GET
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

wss.on('connection', (ws, req) => {
    handlePipelineConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`PatrolPoint V2 server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
