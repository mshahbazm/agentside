/**
 * WebSocket Connection Manager
 * Tracks active WebSocket connections by socketId
 */

import type { WSContext } from 'hono/ws';
import { v4 as uuidv4 } from 'uuid';

/**
 * Auth info for socket connection
 */
export interface iSocketAuthInfo {
  userId: string;
  companyId?: string;
  isSystemUser: boolean;
}

/**
 * Connection info stored for each socket
 */
interface iConnectionInfo {
  ws: WSContext;
  socketId: string;
  connectedAt: Date;
  lastActivity: Date;
  auth: iSocketAuthInfo;
  metadata?: Record<string, unknown>;
  /**
   * Set to true by `markConnectionReady` after auth completes in `onOpen`.
   * Messages arriving before ready are silently dropped (except ping/pong/ack).
   */
  ready: boolean;
}

/**
 * Active connections map
 * Key: socketId, Value: connection info
 */
const connections = new Map<string, iConnectionInfo>();

/**
 * Register a new WebSocket connection with authentication
 * @param ws - WebSocket context
 * @param auth - Authentication info from JWT
 * @param metadata - Optional metadata
 * @returns The assigned socketId
 */
export function registerConnection(
  ws: WSContext,
  auth: iSocketAuthInfo,
  metadata?: Record<string, unknown>
): string {
  const socketId = uuidv4();
  const now = new Date();

  connections.set(socketId, {
    ws,
    socketId,
    connectedAt: now,
    lastActivity: now,
    auth,
    metadata,
    ready: false,
  });

  console.log(`[WS] Connection registered: ${socketId} (user: ${auth.userId}, company: ${auth.companyId || 'system'})`);

  return socketId;
}

/**
 * Validate that a socket belongs to the specified company
 * System users can access any company's sockets
 * @returns true if access is allowed
 */
export function validateSocketOwnership(socketId: string, companyId: string): boolean {
  const conn = connections.get(socketId);
  if (!conn) {
    return false;
  }

  // System users can access any socket
  if (conn.auth.isSystemUser) {
    return true;
  }

  // Non-system users must match company
  return conn.auth.companyId === companyId;
}

/**
 * Get auth info for a socket
 */
export function getSocketAuth(socketId: string): iSocketAuthInfo | undefined {
  return connections.get(socketId)?.auth;
}

/**
 * Update last activity timestamp for a connection
 */
export function updateActivity(socketId: string): void {
  const conn = connections.get(socketId);
  if (conn) {
    conn.lastActivity = new Date();
  }
}

/**
 * Mark a connection as ready after auth completes.
 * Messages arriving before this call are silently dropped by onMessage.
 */
export function markConnectionReady(socketId: string): void {
  const conn = connections.get(socketId);
  if (conn) conn.ready = true;
}

/**
 * Remove a WebSocket connection
 */
export function removeConnection(socketId: string): void {
  if (connections.has(socketId)) {
    connections.delete(socketId);
    console.log(`[WS] Connection removed: ${socketId}`);
  }
}

/**
 * Get a connection by socketId
 */
export function getConnection(socketId: string): iConnectionInfo | undefined {
  return connections.get(socketId);
}

/**
 * Check if a connection exists
 */
export function hasConnection(socketId: string): boolean {
  return connections.has(socketId);
}

/**
 * Maximum WebSocket message size (64KB)
 * Messages larger than this will be truncated with a warning
 */
const MAX_WS_MESSAGE_SIZE = 64 * 1024;

/**
 * Truncate data in a message to fit within size limits
 */
function truncateMessageData(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return message;
  }

  const obj = message as Record<string, unknown>;

  // Create truncated copy
  const truncated: Record<string, unknown> = {
    ...obj,
    _truncated: true,
    _truncatedReason: 'Response too large for WebSocket delivery',
  };

  // Remove or truncate data field
  if ('data' in truncated) {
    truncated.data = { truncated: true, message: 'Response data too large' };
  }

  // Truncate response.data if present
  if ('response' in truncated && typeof truncated.response === 'object' && truncated.response !== null) {
    const response = truncated.response as Record<string, unknown>;
    if ('data' in response) {
      truncated.response = {
        ...response,
        data: { truncated: true, message: 'Response data too large' },
      };
    }
  }

  return truncated;
}

/**
 * Send a message to a specific connection
 * Handles message size limits with truncation
 */
export function sendToConnection(socketId: string, message: unknown): boolean {
  const conn = connections.get(socketId);

  if (!conn) {
    console.warn(`[WS] Connection not found: ${socketId}`);
    return false;
  }

  try {
    let payload = typeof message === 'string' ? message : JSON.stringify(message);

    // Check size and truncate if necessary
    if (payload.length > MAX_WS_MESSAGE_SIZE) {
      console.warn(`[WS] Message truncated for ${socketId}`, {
        originalSize: payload.length,
        maxSize: MAX_WS_MESSAGE_SIZE,
      });

      // Truncate the message
      const truncatedMessage = truncateMessageData(message);
      payload = JSON.stringify(truncatedMessage);

      // If still too large after truncation, send error message
      if (payload.length > MAX_WS_MESSAGE_SIZE) {
        payload = JSON.stringify({
          type: 'error',
          error: 'Response too large to deliver via WebSocket',
          _truncated: true,
        });
      }
    }

    conn.ws.send(payload);
    return true;
  } catch (error) {
    console.error(`[WS] Failed to send to ${socketId}, removing dead connection:`, error);
    connections.delete(socketId);
    return false;
  }
}

/**
 * Broadcast a message to all connections
 */
export function broadcastMessage(message: unknown): void {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  for (const [socketId, conn] of connections) {
    try {
      conn.ws.send(payload);
    } catch (error) {
      console.error(`[WS] Failed to broadcast to ${socketId}:`, error);
    }
  }
}

/**
 * Get connection count
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Get all connection IDs
 */
export function getConnectionIds(): string[] {
  return Array.from(connections.keys());
}

/**
 * Close all connections
 */
export async function closeAllConnections(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [socketId, conn] of connections) {
    closePromises.push(
      new Promise<void>((resolve) => {
        try {
          conn.ws.close(1000, 'Server shutdown');
        } catch (error) {
          console.error(`[WS] Failed to close ${socketId}:`, error);
        }
        resolve();
      })
    );
  }

  await Promise.all(closePromises);
  connections.clear();
  console.log('[WS] All connections closed');
}

/**
 * Heartbeat interval reference
 */
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Heartbeat/ping interval in milliseconds
 */
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

/**
 * Connection timeout in milliseconds (no activity)
 */
const CONNECTION_TIMEOUT = 120000; // 2 minutes

/**
 * Start the heartbeat mechanism
 * Pings all connections and removes stale ones
 */
export function startHeartbeat(): void {
  if (heartbeatInterval) {
    return; // Already running
  }

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const staleConnections: string[] = [];

    for (const [socketId, conn] of connections) {
      const lastActivity = conn.lastActivity.getTime();
      const inactiveTime = now - lastActivity;

      if (inactiveTime > CONNECTION_TIMEOUT) {
        // Connection is stale, mark for removal
        staleConnections.push(socketId);
        console.warn(`[WS] Stale connection detected: ${socketId} (inactive ${Math.round(inactiveTime / 1000)}s)`);
      } else {
        // Send ping to keep connection alive
        try {
          conn.ws.send(JSON.stringify({
            type: 'ping',
            timestamp: new Date().toISOString(),
          }));
        } catch (error) {
          // Failed to send ping, mark as stale
          staleConnections.push(socketId);
          console.warn(`[WS] Failed to ping ${socketId}, marking as stale`);
        }
      }
    }

    // Remove stale connections
    for (const socketId of staleConnections) {
      const conn = connections.get(socketId);
      if (conn) {
        try {
          conn.ws.close(1001, 'Connection timeout');
        } catch {
          // Ignore close errors
        }
        connections.delete(socketId);
        console.log(`[WS] Removed stale connection: ${socketId}`);
      }
    }
  }, HEARTBEAT_INTERVAL);

  console.log('[WS] Heartbeat started');
}

/**
 * Stop the heartbeat mechanism
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[WS] Heartbeat stopped');
  }
}
