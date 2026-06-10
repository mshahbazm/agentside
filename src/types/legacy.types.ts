/**
 * Legacy scout WebSocket type shims.
 *
 * DEPRECATED — These types describe the OLD `scout_*` WebSocket envelope that
 * was deleted in the pi-mono port. They are kept here ONLY so that the
 * `ats-app` frontend continues to TypeScript-compile while its own migration
 * to the new `agent_event` envelope is pending.
 *
 * Nothing in the command-service runtime consumes these — they exist purely
 * as a type-only backwards compatibility surface for the frontend. Delete
 * this file once `ats-app` has been migrated to speak the new protocol
 * (see packages/command-service/CLAUDE.md "WebSocket protocol" for the new
 * shapes).
 *
 * DO NOT ADD NEW USAGES TO THESE TYPES.
 */

import type { tUIBlock } from './ui-block.types';

// ============================================================================
// Progress status (legacy)
// ============================================================================

export type tProgressStatus =
  | 'queued'
  | 'understanding'
  | 'selecting_tool'
  | 'preparing'
  | 'executing'
  | 'finalizing';

export type tWebSocketMessageType =
  | 'connected'
  | 'command_queued'
  | 'command_error'
  | 'ping'
  | 'pong';

export interface iWebSocketMessage {
  type: tWebSocketMessageType;
  commandId?: string;
  socketId?: string;
  message?: string;
  result?: Record<string, unknown>;
  timestamp: string;
}

export interface iCommandResult {
  commandId: string;
  success: boolean;
  intent?: string;
  resourceId?: string;
  resourceType?: string;
  error?: string;
  data?: unknown;
}

// ============================================================================
// Scout WS message envelope (legacy)
// ============================================================================

export interface iWsCommandMessage {
  type: 'command';
  commandId: string;
  text: string;
  conversationId?: string;
  source?: 'web' | 'slack' | 'teams' | 'email';
  priority?: 0 | 1 | 2 | 3;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: string;
}

export interface iCommandQueuedMessage {
  type: 'command_queued';
  commandId: string;
  conversationId: string;
  idempotencyKey: string;
  timestamp: string;
}

export interface iCommandErrorMessage {
  type: 'command_error';
  error: string;
  retryAfter?: number;
  timestamp: string;
}

export interface iScoutTypingMessage {
  type: 'scout_typing';
  conversationId: string;
  timestamp: string;
}

export interface iScoutToolCallingMessage {
  type: 'scout_tool_calling';
  conversationId: string;
  toolName: string;
  timestamp: string;
}

export type tScoutResponseType = 'message' | 'tool_result' | 'final' | 'error';

export interface iScoutToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface iScoutResponse {
  type: tScoutResponseType;
  content?: string;
  toolCalls?: iScoutToolCall[];
  data?: Record<string, unknown>;
  uiBlocks?: tUIBlock[];
  conversationId?: string;
}

export interface iScoutResponseMessage {
  type: 'scout_response';
  conversationId: string;
  response: iScoutResponse;
  timestamp: string;
}

export interface iScoutErrorMessage {
  type: 'scout_error';
  conversationId: string;
  error: string;
  timestamp: string;
}

// ============================================================================
// Tool invocation state (legacy streaming updates)
// ============================================================================

export type tToolInvocationState =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'error'
  | 'approval-requested'
  | 'approval-responded';

export interface iToolInvocationUpdate {
  toolCallId: string;
  toolName: string;
  state: tToolInvocationState;
  uiBlock?: tUIBlock;
  result?: unknown;
  error?: string;
  iteration?: number;
}

export interface iScoutToolStateMessage {
  type: 'scout_tool_state';
  conversationId: string;
  invocation: iToolInvocationUpdate;
  timestamp: string;
}

export interface iScoutToolResultMessage {
  type: 'scout_tool_result';
  conversationId: string;
  toolCallId: string;
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  iteration?: number;
  timestamp: string;
}

export interface iScoutIntermediateMessage {
  type: 'scout_intermediate';
  conversationId: string;
  content: string;
  iteration: number;
  hasMoreToolCalls: boolean;
  timestamp: string;
}

// ============================================================================
// Scout conversation messages (persisted history)
// ============================================================================

export interface iScoutMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: iScoutToolCall[];
  toolResults?: Array<{
    toolCallId: string;
    success: boolean;
    result?: unknown;
    error?: string;
  }>;
  timestamp: Date | string;
  idempotencyKey?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  uiBlocks?: tUIBlock[];
  internal?: boolean;
}

// ============================================================================
// Sync messages (legacy reconnect flow)
// ============================================================================

export interface iSyncMessage {
  type: 'sync';
  conversationId: string;
  timestamp: string;
}

export interface iSyncByIdempotencyMessage {
  type: 'sync_by_idempotency';
  idempotencyKeys: string[];
  timestamp: string;
}

export interface iSyncResponseMessage {
  type: 'sync_response';
  conversationId: string;
  messages: iScoutMessage[];
  timestamp: string;
}

export interface iSyncErrorMessage {
  type: 'sync_error';
  error: string;
  conversationId?: string;
  timestamp: string;
}

// ============================================================================
// Combined envelope type (legacy)
// ============================================================================

export type tScoutWebSocketMessageType =
  | 'scout_typing'
  | 'scout_tool_calling'
  | 'scout_tool_state'
  | 'scout_tool_result'
  | 'scout_intermediate'
  | 'scout_response'
  | 'scout_error'
  | 'command_queued'
  | 'command_error'
  | 'sync_response'
  | 'sync_error';

export type tScoutWebSocketMessage =
  | iScoutTypingMessage
  | iScoutToolCallingMessage
  | iScoutToolStateMessage
  | iScoutToolResultMessage
  | iScoutIntermediateMessage
  | iScoutResponseMessage
  | iScoutErrorMessage
  | iCommandQueuedMessage
  | iCommandErrorMessage
  | iSyncResponseMessage
  | iSyncErrorMessage;
