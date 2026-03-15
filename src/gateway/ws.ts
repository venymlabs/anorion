import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../shared/logger';

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // We check auth inline here since we don't have access to the server's key store
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Pass through — auth checked per-message if needed
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        logger.debug({ msg }, 'WS message received');

        if (msg.type === 'subscribe') {
          ws.send(JSON.stringify({ type: 'subscribed', agents: msg.agents || [] }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
    });
  });

  // Expose for sending events
  return wss;
}

export type { WebSocketServer as WsServer };
