/**
 * Mongo schema for the append-only agent session log.
 *
 * Each document represents one entry in a session. Sessions are identified by
 * `sessionId` and scoped by `(companyId, userId)`. Entries are ordered by
 * `timestamp`. On load we filter out nothing — we rebuild `AgentMessage[]` from
 * the persisted entries and hand them to the Agent.
 *
 * Entries
 * TTL-expire after 90 days.
 */

import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type tCommandEntryType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'compaction';

export interface iAgentSessionEntry extends Document {
  sessionId: string;
  companyId: string;
  userId: string;
  type: tCommandEntryType;
  /** Sequence number within the session — monotonic, assigned on append */
  seq: number;
  timestamp: Date;
  /**
   * Serialized payload. For `message` entries this holds `JSON.stringify` of
   * the full AgentMessage as produced by pi-agent-core (user, assistant with
   * tool calls, toolResult, or one of our pi-agent-core custom messages like
   * `uiBlock` declared in `src/types/custom-messages.ts`). For `compaction`
   * it holds `JSON.stringify({ summary, firstKeptSeq, tokensBefore })`.
   *
   * Typed as `unknown` (not `string`) because legacy documents written before
   * the String-schema switchover still contain raw BSON objects. The read
   * path in `mongo-store.ts` handles both shapes via `parsePayload` —
   * typeof-string → JSON.parse, otherwise use as-is.
   *
   * Why JSON-string-in-Mongo instead of Mongoose's `Schema.Types.Mixed`:
   * Mixed is not guaranteed lossless for deeply nested object shapes (one
   * documented case is `minimize: true` stripping empty sub-objects; there
   * are anecdotal reports of other Mongoose/BSON round-trip quirks around
   * specific nested keys). Storing the payload as a JSON string mirrors
   * pi-mono's file-based session store exactly and sidesteps every Mongoose
   * quirk by construction.
   */
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface iAgentSessionHeader extends Document {
  sessionId: string;
  companyId: string;
  userId: string;
  title?: string;
  /** Origin metadata — page URL, entity refs at creation time */
  origin?: Record<string, unknown>;
  /** Source channel */
  source: 'web' | 'slack' | 'teams' | 'email';
  createdAt: Date;
  updatedAt: Date;
}

const EntrySchema = new Schema<iAgentSessionEntry>(
  {
    sessionId: { type: String, required: true },
    companyId: { type: String, required: true },
    userId: { type: String, required: true },
    type: { type: String, required: true },
    seq: { type: Number, required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    // Stored as a JSON-stringified blob. See the `payload` JSDoc on
    // `iAgentSessionEntry` for the rationale.
    payload: { type: String, required: true },
  },
  { timestamps: true },
);

// Replay order within a session
EntrySchema.index({ sessionId: 1, seq: 1 });
// List-conversations query (most recent first for a user)
EntrySchema.index({ companyId: 1, userId: 1, updatedAt: -1 });
// 90-day TTL based on updatedAt
EntrySchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const SessionHeaderSchema = new Schema<iAgentSessionHeader>(
  {
    sessionId: { type: String, required: true, unique: true },
    companyId: { type: String, required: true },
    userId: { type: String, required: true },
    title: String,
    origin: Schema.Types.Mixed,
    source: { type: String, required: true, default: 'web' },
  },
  { timestamps: true },
);

SessionHeaderSchema.index({ companyId: 1, userId: 1, updatedAt: -1 });
SessionHeaderSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AgentSessionEntry: Model<iAgentSessionEntry> =
  mongoose.models.AgentSessionEntry ||
  mongoose.model<iAgentSessionEntry>('AgentSessionEntry', EntrySchema, 'agent_session_entries');

export const AgentSessionHeader: Model<iAgentSessionHeader> =
  mongoose.models.AgentSessionHeader ||
  mongoose.model<iAgentSessionHeader>('AgentSessionHeader', SessionHeaderSchema, 'agent_sessions');
