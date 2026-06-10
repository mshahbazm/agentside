/**
 * MongoSessionStore — persists agent state for a single session.
 *
 * - `loadSession()` rebuilds the AgentMessage[] a session should start from,
 *   honoring any compaction entry (skip everything before `firstKeptSeq`).
 *   UI blocks live inside `messages` as `role: 'uiBlock'` custom messages —
 *   no separate stream, no extraction.
 * - `appendEvent(event)` takes an AgentEvent from the pi-agent-core subscriber
 *   AND from runtime.ts's `emitCustomMessage` helper, and writes exactly one
 *   row per *persistent* event: `message_end` (any role — user, assistant,
 *   toolResult, or custom like `uiBlock`) and compaction checkpoints. Streaming
 *   deltas (`message_update`) are NOT persisted — they exist only on the WebSocket.
 *
 * Sequence numbers are per-session monotonic integers used to order entries.
 * We pull `MAX(seq)` on first use and increment in memory; a race between
 * two concurrent writers in the same session would be harmless because we use
 * it only for replay ordering, not uniqueness.
 */

import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { AgentSessionEntry, AgentSessionHeader } from '../db/models/agent-session';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from '../compaction';

export interface iMongoStoreOptions {
  sessionId: string;
  companyId: string;
  userId: string;
}

export interface iLoadedSession {
  /** AgentMessages to seed Agent.initialState.messages with */
  messages: AgentMessage[];
}

export class MongoSessionStore {
  public readonly sessionId: string;
  public readonly companyId: string;
  public readonly userId: string;
  private nextSeq = 0;
  /**
   * Identities of messages already persisted in this process instance.
   * Used to dedupe the agent_end failure path (pi-agent-core pushes failure
   * messages straight into state.messages and emits agent_end without going
   * through message_end, so we need to catch them on agent_end without
   * re-persisting messages already captured via message_end).
   *
   * Key format: `${role}:${timestamp}` — good enough since messages within a
   * single session have distinct timestamps in practice.
   */
  private persistedMessageKeys = new Set<string>();

  constructor(opts: iMongoStoreOptions) {
    this.sessionId = opts.sessionId;
    this.companyId = opts.companyId;
    this.userId = opts.userId;
  }

  private messageKey(msg: AgentMessage): string {
    const ts = (msg as { timestamp?: number }).timestamp ?? 0;
    return `${msg.role}:${ts}`;
  }

  /**
   * Deserialize a persisted `entry.payload`.
   *
   * New writes (post-fix): payload is a `JSON.stringify`-ed string. Parse it.
   * Legacy writes (pre-fix, when the schema was `Schema.Types.Mixed`): payload
   * is a raw BSON object returned as-is by `.lean()`. Use without parsing.
   *
   * The string-based storage format is the one that's guaranteed lossless —
   * it mirrors pi-mono's file-based session store byte-for-byte and sidesteps
   * Mongoose Mixed's round-trip quirks (notably the one that was dropping
   * `toolCall.arguments` on replay, manifesting as OpenAI `input[N].arguments
   * missing` errors).
   */
  private parsePayload<T>(raw: unknown): T {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
  }

  /**
   * Ensure a session header exists. Safe to call multiple times — uses
   * findOneAndUpdate with upsert.
   */
  async ensureHeader(origin?: Record<string, unknown>, source: 'web' | 'slack' | 'teams' | 'email' = 'web'): Promise<void> {
    await AgentSessionHeader.findOneAndUpdate(
      { sessionId: this.sessionId },
      {
        $setOnInsert: {
          sessionId: this.sessionId,
          companyId: this.companyId,
          userId: this.userId,
          origin,
          source,
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true, new: true },
    );
  }

  /**
   * Load all messages for this session, honoring any compaction checkpoint.
   * The returned `messages` array includes `uiBlock` custom messages inline
   * in seq order — the frontend walks the same stream and renders them as
   * first-class transcript items.
   */
  async loadSession(): Promise<iLoadedSession> {
    const entries = await AgentSessionEntry.find({
      sessionId: this.sessionId,
      companyId: this.companyId,
      userId: this.userId,
    })
      .sort({ seq: 1 })
      .lean();

    // Initialise sequence cursor from the last entry.
    this.nextSeq = entries.length > 0 ? (entries[entries.length - 1].seq ?? 0) + 1 : 0;

    // Find the most recent compaction — everything before its `firstKeptSeq`
    // is dropped from the LLM-visible history but stays in Mongo for audit.
    let firstKeptSeq = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'compaction') {
        const payload = this.parsePayload<{ firstKeptSeq?: number; summary?: string } | undefined>(
          entries[i].payload,
        );
        firstKeptSeq = payload?.firstKeptSeq ?? 0;
        break;
      }
    }

    const messages: AgentMessage[] = [];
    let pendingSummary: string | undefined;

    for (const entry of entries) {
      if (entry.type === 'compaction' && entry.seq >= firstKeptSeq - 1) {
        // Inject the compaction summary as a user message at the start of the
        // kept window so the LLM has context for earlier work.
        const payload = this.parsePayload<{ summary?: string } | undefined>(entry.payload);
        pendingSummary = payload?.summary;
        continue;
      }
      if (entry.seq < firstKeptSeq) continue;

      if (entry.type === 'message') {
        const msg = this.parsePayload<AgentMessage>(entry.payload);
        messages.push(msg);
        this.persistedMessageKeys.add(this.messageKey(msg));
      }
    }

    if (pendingSummary) {
      messages.unshift({
        role: 'user',
        content: [
          {
            type: 'text',
            text: COMPACTION_SUMMARY_PREFIX + pendingSummary + COMPACTION_SUMMARY_SUFFIX,
          },
        ],
        timestamp: Date.now(),
      });
    }

    return { messages };
  }

  /**
   * Persist exactly one entry to the session log.
   *
   * Payload is `JSON.stringify`-ed so Mongo stores an opaque blob rather than
   * routing through Mongoose `Schema.Types.Mixed` (which has been observed to
   * drop `toolCall.arguments` on replay — see `parsePayload` comment for the
   * full rationale).
   */
  private async appendEntry(type: string, payload: unknown): Promise<void> {
    const entry = new AgentSessionEntry({
      sessionId: this.sessionId,
      companyId: this.companyId,
      userId: this.userId,
      type,
      seq: this.nextSeq++,
      timestamp: new Date(),
      payload: JSON.stringify(payload),
    });
    await entry.save();

    // Bump the header `updatedAt` so list queries order correctly.
    await AgentSessionHeader.updateOne(
      { sessionId: this.sessionId },
      { $set: { updatedAt: new Date() } },
    );
  }

  /**
   * Translate an `AgentEvent` into a persisted entry (if it represents
   * durable state). Streaming updates are ignored — only terminal events are
   * stored.
   */
  async appendEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_end': {
        // Persist the finalized message — any role, including pi-agent-core
        // custom messages like `uiBlock`. The role discriminator is already
        // on the payload, so the load path replays it correctly.
        const msg = event.message as AgentMessage;
        await this.appendEntry('message', msg);
        this.persistedMessageKeys.add(this.messageKey(msg));
        break;
      }

      case 'agent_end': {
        // On failure, pi-agent-core pushes a synthetic error/abort assistant
        // message directly into state.messages and emits agent_end WITHOUT
        // going through message_end. Catch those here so error state survives
        // reconnect. Any message already captured via message_end is skipped
        // via the persistedMessageKeys set.
        for (const msg of event.messages) {
          if (!this.persistedMessageKeys.has(this.messageKey(msg))) {
            await this.appendEntry('message', msg);
            this.persistedMessageKeys.add(this.messageKey(msg));
          }
        }
        break;
      }

      case 'turn_end':
      case 'agent_start':
      case 'turn_start':
      case 'message_start':
      case 'message_update':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        // Non-persistent events: they either duplicate message_end data (the
        // final message is captured there) or are streaming-only.
        break;
    }
  }

  /** Record a compaction checkpoint so subsequent loads skip older entries. */
  async appendCompaction(summary: string, firstKeptSeq: number, tokensBefore: number): Promise<void> {
    await this.appendEntry('compaction', { summary, firstKeptSeq, tokensBefore });
  }

  /** Current next sequence number (exposed for tests and compaction hooks). */
  get currentSeq(): number {
    return this.nextSeq;
  }
}

/**
 * List sessions for a given user in descending updated order. Used by the
 * frontend to show the conversation history sidebar.
 */
export async function listSessionsForUser(
  companyId: string,
  userId: string,
  limit = 30,
): Promise<Array<{ sessionId: string; title?: string; updatedAt: Date; origin?: unknown }>> {
  const headers = await AgentSessionHeader.find({ companyId, userId })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  return headers.map((h) => ({
    sessionId: h.sessionId,
    title: h.title,
    updatedAt: h.updatedAt,
    origin: h.origin,
  }));
}
