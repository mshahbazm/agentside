/**
 * agentside entry point — rebuilt on pi-mono (pi-ai + pi-agent-core).
 *
 * Boots Hono, connects Mongo, loads skills into the in-memory index, spins up
 * the WebSocket server, and wires graceful shutdown. No processor / worker
 * queue — each WS connection owns its own stateful pi-agent-core Agent.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './config/env.config';
import { connectMongoDB, disconnectMongoDB, getMongoDBStatus } from './db';
import { closeRedisConnection } from './lib/redis';
import { loadSkills } from './skills/loader';
import {
  closeAllConnections,
  getConnectionCount,
  startHeartbeat,
  stopHeartbeat,
} from './ws/connections';
import { setupWebSocket } from './ws/server';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  }),
);

app.get('/', async (c) => {
  const mongoStatus = getMongoDBStatus();
  return c.json({
    status: mongoStatus.connected ? 'ok' : 'degraded',
    service: 'agentside',
    timestamp: new Date().toISOString(),
    connections: getConnectionCount(),
    mongodb: {
      connected: mongoStatus.connected,
      dbName: mongoStatus.dbName,
    },
  });
});

const { injectWebSocket } = setupWebSocket(app);

// ============================================================================
// Graceful shutdown
// ============================================================================

async function shutdown() {
  console.log('[agentside] shutting down');
  stopHeartbeat();
  await closeAllConnections();
  await closeRedisConnection();
  await disconnectMongoDB();
  console.log('[agentside] shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================================================
// Boot
// ============================================================================

console.log('[agentside] connecting to MongoDB…');
await connectMongoDB({ uri: env.MONGODB_URI });

console.log('[agentside] loading skills…');
loadSkills();

console.log(`[agentside] starting on port ${env.PORT}…`);
const server = serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    console.log(`[agentside] listening on http://localhost:${info.port}`);
  },
);

injectWebSocket(server);
startHeartbeat();
