/**
 * Rewritten WebSocket server.
 *
 * Protocol (client → server):
 *   { type: "ack" }                                         — mark connection ready
 *   { type: "ping" } / { type: "pong" }                     — keep-alive
 *   { type: "user_message", sessionId, content, origin? }   — prompt/followUp routing
 *   { type: "close_session", sessionId }                    — dispose agent instance
 *
 * Protocol (server → client):
 *   { type: "connected", socketId }                         — assigned after upgrade
 *   { type: "session_ready", sessionId, messages }       — after load / creation (UI blocks are `role: 'uiBlock'` entries inside `messages`)
 *   { type: "agent_event", sessionId, event: AgentEvent }   — every pi-agent-core event
 *   { type: "error", message, sessionId? }                  — protocol or runtime error
 *   { type: "ping" } / { type: "pong" }                     — keep-alive
 *
 * A single pi-agent-core `Agent` lives per (socketId × sessionId) key. If the
 * user starts a new session mid-connection, a fresh agent is lazily created.
 *
 * Routing: a new user message either starts a fresh run via `agent.prompt`
 * (when the agent is idle) or queues via `agent.followUp` (when
 * isStreaming === true). Steering is disabled in the UI for v1 per the plan.
 */

import type { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { v4 as uuidv4 } from 'uuid';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { authenticateFromCookie } from '../auth';
import {
  registerConnection,
  removeConnection,
  updateActivity,
  markConnectionReady,
  sendToConnection,
  getConnection,
  getConnectionCount,
  type iSocketAuthInfo,
} from './connections';
import {
  buildAgent,
  rebuildSystemPrompt,
  type iBuiltAgent,
  type iPromptContext,
} from '../agent/runtime';
import { listSessionsForUser } from '../agent/mongo-store';
import type { tUIBlock } from '../types/ui-block.types';

/**
 * Shape of `promptContext` without companyId/userId — those two come from
 * the authenticated session and never from the client.
 */
type tPromptContext = Omit<iPromptContext, 'companyId' | 'userId'>;

/**
 * Translate the client-sent `origin` bag into a typed `promptContext` that
 * `buildSystemPrompt` knows how to render. Returns undefined if there's
 * nothing useful to include so callers can skip the rebuild.
 *
 * Only whitelisted fields are read — anything else the client sends on
 * `origin` is ignored for prompt purposes (it still lands on the Mongo
 * session header for debugging).
 */
function originToPromptContext(
  origin: Record<string, unknown> | undefined,
): tPromptContext | undefined {
  if (!origin) return undefined;

  const pageUrl = typeof origin.pageUrl === 'string' ? origin.pageUrl : undefined;
  const currentView = typeof origin.currentView === 'string' ? origin.currentView : undefined;

  let entityRefs: Record<string, number[]> | undefined;
  if (origin.entityRefs && typeof origin.entityRefs === 'object') {
    const raw = origin.entityRefs as Record<string, unknown>;
    const coerced: Record<string, number[]> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (!Array.isArray(val)) continue;
      const nums = val.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      if (nums.length > 0) coerced[key] = nums;
    }
    if (Object.keys(coerced).length > 0) entityRefs = coerced;
  }

  if (!pageUrl && !currentView && !entityRefs) return undefined;
  return { pageUrl, currentView, entityRefs };
}

// ============================================================================
// Per-socket agent registry
// ============================================================================

interface iSessionState {
  sessionId: string;
  agent: iBuiltAgent;
  /**
   * Texts that the user sent while the agent was already streaming and that
   * we routed to `agent.followUp()`. Mirrors pi-mono's session-side
   * `_followUpMessages` tracking — pi-agent-core's own queue is private, so
   * we keep a parallel copy so we can tell the frontend what's pending.
   *
   * Entries are removed when pi-agent-core actually picks them up, which we
   * detect via a `message_start` event with role=user whose text matches.
   */
  followUpTexts: string[];
}

/** socketId → active session state (one per socket at a time) */
const socketAgents = new Map<string, iSessionState>();

/** Send the current follow-up queue state to a socket. */
function sendQueueUpdate(socketId: string, sessionId: string, followUps: readonly string[]): void {
  sendToConnection(socketId, {
    type: 'queue_update',
    sessionId,
    followUps: [...followUps],
  });
}

async function disposeSocketAgent(socketId: string): Promise<void> {
  const existing = socketAgents.get(socketId);
  if (existing) {
    existing.agent.dispose();
    socketAgents.delete(socketId);
  }
}

/**
 * Extract plain text from a user AgentMessage's content (which may be a
 * string or a content-block array). Used to match incoming
 * `message_start(user)` events against queued follow-up texts.
 */
function extractUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== 'user') return undefined;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
      )
      .map((b) => b.text)
      .join('');
  }
  return undefined;
}

async function getOrCreateAgent(
  socketId: string,
  sessionId: string,
  auth: iSocketAuthInfo,
  origin?: Record<string, unknown>,
  promptContext?: tPromptContext,
): Promise<iBuiltAgent | null> {
  const existing = socketAgents.get(socketId);
  if (existing && existing.sessionId === sessionId) return existing.agent;

  // Switching sessions — tear down the old one.
  if (existing) {
    existing.agent.dispose();
    socketAgents.delete(socketId);
  }

  if (!auth.companyId || !auth.userId) {
    sendToConnection(socketId, {
      type: 'error',
      message: 'Session is missing authentication. Reconnect and try again.',
      sessionId,
    });
    return null;
  }

  const built = await buildAgent({
    sessionId,
    companyId: auth.companyId,
    userId: auth.userId,
    origin,
    promptContext,
    onEvent: (event: AgentEvent) => {
      // Intercept user message_start events to dequeue matching follow-ups
      // BEFORE forwarding the event, so the frontend sees the queue update
      // first (matches pi-mono's agent-session._processAgentEvent pattern).
      if (event.type === 'message_start') {
        const text = extractUserMessageText(event.message);
        if (text) {
          const state = socketAgents.get(socketId);
          if (state && state.sessionId === sessionId) {
            const idx = state.followUpTexts.indexOf(text);
            if (idx !== -1) {
              state.followUpTexts.splice(idx, 1);
              sendQueueUpdate(socketId, sessionId, state.followUpTexts);
            }
          }
        }
      }

      sendToConnection(socketId, {
        type: 'agent_event',
        sessionId,
        event,
      });
    },
  });

  socketAgents.set(socketId, { sessionId, agent: built, followUpTexts: [] });
  return built;
}

// ============================================================================
// Message handlers
// ============================================================================

interface iUserMessagePayload {
  sessionId: string;
  content: string;
  origin?: Record<string, unknown>;
}

/**
 * Duplicate-send guard — we no longer have idempotency keys in the new
 * protocol, so protect against double-clicks and stale client retries by
 * dropping any user_message with the same (socket, session, content) as one
 * seen in the last `DEDUPE_WINDOW_MS`.
 *
 * Scoped per-socket because two tabs with the same session legitimately may
 * want to send the same prompt simultaneously (edge case but possible), and
 * this layer is meant to catch single-client glitches, not coordinate across
 * clients.
 */
const DEDUPE_WINDOW_MS = 2_000;
const recentSends = new Map<string, { content: string; at: number }>();

function isDuplicateSend(socketId: string, sessionId: string, content: string): boolean {
  const key = `${socketId}:${sessionId}`;
  const prev = recentSends.get(key);
  const now = Date.now();
  if (prev && prev.content === content && now - prev.at < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentSends.set(key, { content, at: now });
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (recentSends.size > 1000) {
    for (const [k, v] of recentSends) {
      if (now - v.at > DEDUPE_WINDOW_MS) recentSends.delete(k);
    }
  }
  return false;
}

async function handleUserMessage(
  socketId: string,
  auth: iSocketAuthInfo,
  payload: iUserMessagePayload,
): Promise<void> {
  if (!payload.sessionId || typeof payload.content !== 'string' || payload.content.trim() === '') {
    sendToConnection(socketId, {
      type: 'error',
      message: 'user_message requires sessionId and non-empty content',
    });
    return;
  }

  if (isDuplicateSend(socketId, payload.sessionId, payload.content)) {
    console.log(`[ws] dropped duplicate user_message on ${socketId}/${payload.sessionId}`);
    return;
  }

  // Translate origin → promptContext BEFORE getOrCreateAgent so the first
  // turn of a fresh session sees page context in the baked initial prompt.
  // For subsequent turns we rebuild below (same ctx, fresh per-turn values).
  const promptContext = originToPromptContext(payload.origin);

  const built = await getOrCreateAgent(
    socketId,
    payload.sessionId,
    auth,
    payload.origin,
    promptContext,
  );
  if (!built) return;

  // Per-turn system prompt refresh. Matches pi-mono's mom/agent.ts:666-675
  // pattern: rebuild with fresh environment data and mutate
  // agent.state.systemPrompt. createContextSnapshot() inside pi-agent-core
  // reads _state.systemPrompt fresh on every run, so follow-ups picked off
  // the queue later will also see the latest prompt.
  //
  // Skip if promptContext is undefined (no origin from the client) so the
  // prompt stays whatever buildAgent set at construction time.
  if (promptContext && auth.companyId) {
    built.agent.state.systemPrompt = rebuildSystemPrompt(
      { companyId: auth.companyId, userId: auth.userId },
      promptContext,
    );
  }

  // Send `session_ready` on first attach so the frontend can rehydrate. UI
  // blocks live inline in `messages` as `role: 'uiBlock'` custom messages.
  if (!socketAgents.get(socketId)?.agent.agent.state.messages.length) {
    sendToConnection(socketId, {
      type: 'session_ready',
      sessionId: payload.sessionId,
      messages: built.agent.state.messages,
    });
  }

  const userMessage = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: payload.content }],
    timestamp: Date.now(),
  };

  try {
    if (built.agent.state.isStreaming) {
      // Agent is currently working — queue via agent.followUp() AND track it
      // in our parallel array so we can tell the frontend what's pending.
      // Matches pi-mono's agent-session pattern: session owns a
      // `_followUpMessages` array that mirrors pi-agent-core's private queue
      // and gets cleared when message_start(user) fires for that text.
      built.agent.followUp(userMessage);
      const state = socketAgents.get(socketId);
      if (state && state.sessionId === payload.sessionId) {
        state.followUpTexts.push(payload.content);
        sendQueueUpdate(socketId, payload.sessionId, state.followUpTexts);
      }
    } else {
      await built.agent.prompt(userMessage);
    }
  } catch (err) {
    console.error('[ws] agent.prompt failed', err);
    sendToConnection(socketId, {
      type: 'error',
      sessionId: payload.sessionId,
      message: err instanceof Error ? err.message : 'Agent run failed',
    });
  }
}

async function handleListSessions(socketId: string, auth: iSocketAuthInfo): Promise<void> {
  if (!auth.companyId) return;
  const sessions = await listSessionsForUser(auth.companyId, auth.userId);
  sendToConnection(socketId, { type: 'session_list', sessions });
}

/**
 * User-initiated cancel. Looks up the active agent for this socket and calls
 * `agent.abort()`. pi-agent-core's loop unwinds, emits `agent_end` with
 * stopReason="aborted", and our mongo-store captures the synthetic failure
 * assistant message via the agent_end dedupe path.
 *
 * No-ops silently if the agent isn't running — it's user-initiated, not a
 * server error.
 */
function handleAbort(socketId: string, sessionId: string): void {
  const existing = socketAgents.get(socketId);
  if (!existing || existing.sessionId !== sessionId) return;

  // Clear any queued follow-ups — they won't be processed once we abort.
  // Also tell pi-agent-core to drop its internal queue.
  if (existing.followUpTexts.length > 0) {
    existing.followUpTexts = [];
    sendQueueUpdate(socketId, sessionId, existing.followUpTexts);
  }
  try {
    existing.agent.agent.clearFollowUpQueue();
  } catch {
    /* ignore */
  }

  if (!existing.agent.agent.state.isStreaming) return;
  try {
    existing.agent.agent.abort();
    console.log(`[ws] abort requested on ${socketId}/${sessionId}`);
  } catch (err) {
    console.error('[ws] agent.abort() failed', err);
  }
}

/**
 * Drop the follow-up queue for this session WITHOUT aborting the running
 * agent. Matches pi-mono's handleDequeue — lets the client pull the text
 * back into the editor for editing while the current run keeps going.
 */
function handleDequeueFollowUps(socketId: string, sessionId: string): void {
  const existing = socketAgents.get(socketId);
  if (!existing || existing.sessionId !== sessionId) return;

  if (existing.followUpTexts.length > 0) {
    existing.followUpTexts = [];
    sendQueueUpdate(socketId, sessionId, existing.followUpTexts);
  }
  try {
    existing.agent.agent.clearFollowUpQueue();
  } catch {
    /* ignore */
  }
  console.log(`[ws] followup queue dequeued on ${socketId}/${sessionId}`);
}

async function handleLoadSession(
  socketId: string,
  auth: iSocketAuthInfo,
  sessionId: string,
): Promise<void> {
  const built = await getOrCreateAgent(socketId, sessionId, auth);
  if (!built) return;

  const messages = built.agent.state.messages;

  sendToConnection(socketId, {
    type: 'session_ready',
    sessionId,
    messages,
  });
}

// ============================================================================
// Server setup
// ============================================================================

export function setupWebSocket(app: Hono) {
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app: app as any });

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      let socketId: string | null = null;
      let auth: iSocketAuthInfo | null = null;

      const cookieHeader = c.req.header('cookie');
      const jwt = authenticateFromCookie(cookieHeader);
      if (jwt) {
        auth = {
          userId: jwt.sub,
          companyId: jwt.companyId,
          isSystemUser: jwt.isSystemUser || false,
        };
      }

      return {
        async onOpen(_event, ws) {
          if (!auth) {
            console.warn('[ws] rejecting unauthenticated connection');
            ws.close(4001, 'Authentication required');
            return;
          }

          socketId = registerConnection(ws, auth);
          markConnectionReady(socketId);

          sendToConnection(socketId, {
            type: 'connected',
            socketId,
            message: 'Connected to agentside',
          });

          console.log(`[ws] client connected. total: ${getConnectionCount()}`);
        },

        async onMessage(event, ws) {
          if (!socketId || !auth) return;
          updateActivity(socketId);

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(event.data.toString());
          } catch {
            return;
          }

          const conn = getConnection(socketId);
          if (!conn) return;

          // Allow heartbeat / ack even before ready.
          if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (data.type === 'pong' || data.type === 'ack') return;

          // Silently drop anything else that arrives before auth completes.
          // The frontend gates on the server's `connected` event, so this
          // guard is defense-in-depth only.
          if (!conn.ready) {
            console.log(`[ws] dropped pre-ready message type=${data.type} on ${socketId}`);
            return;
          }

          auth = conn.auth;

          switch (data.type) {

            case 'user_message': {
              await handleUserMessage(
                socketId,
                auth,
                data as unknown as iUserMessagePayload,
              );
              return;
            }

            case 'abort': {
              const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
              if (sessionId) handleAbort(socketId, sessionId);
              return;
            }

            case 'dequeue_followups': {
              const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
              if (sessionId) handleDequeueFollowUps(socketId, sessionId);
              return;
            }

            case 'list_sessions': {
              await handleListSessions(socketId, auth);
              return;
            }

            case 'load_session': {
              const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
              if (!sessionId) return;
              await handleLoadSession(socketId, auth, sessionId);
              return;
            }

            case 'new_session': {
              // Client asks for a fresh sessionId — we just echo one.
              const sessionId = uuidv4();
              sendToConnection(socketId, { type: 'session_created', sessionId });
              return;
            }

            case 'close_session': {
              await disposeSocketAgent(socketId);
              sendToConnection(socketId, { type: 'session_closed' });
              return;
            }

            default:
              // Unknown message — ignore
              return;
          }
        },

        async onClose(_event, _ws) {
          if (socketId) {
            await disposeSocketAgent(socketId);
            removeConnection(socketId);
            // Clear any dedupe entries scoped to this socket.
            for (const key of recentSends.keys()) {
              if (key.startsWith(`${socketId}:`)) recentSends.delete(key);
            }
          }
          console.log(`[ws] clients remaining: ${getConnectionCount()}`);
        },

        onError(event, _ws) {
          console.error('[ws] error', event);
          if (socketId) {
            disposeSocketAgent(socketId).catch(() => {});
            removeConnection(socketId);
            for (const key of recentSends.keys()) {
              if (key.startsWith(`${socketId}:`)) recentSends.delete(key);
            }
          }
        },
      };
    }),
  );

  return { injectWebSocket };
}

export { type tUIBlock };
