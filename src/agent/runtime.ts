/**
 * Agent runtime — builds a configured `Agent` instance for a single session.
 *
 * One Agent per active (sessionId × socket) pair. The runtime:
 *   1. Constructs the skill-aware system prompt
 *   2. Builds the tool list bound to an AppApiClient (service auth + company)
 *   3. Loads prior messages from Mongo (honoring compaction)
 *   4. Wires transformContext → compaction.maybeCompact
 *   5. Wires beforeToolCall / afterToolCall hooks
 *   6. Subscribes a single listener (`dispatch`) that forwards every AgentEvent
 *      to (a) the Mongo store and (b) the WebSocket connection. The same
 *      `dispatch` is also called directly by `emitCustomMessage` to inject
 *      pi-agent-core custom messages (e.g. `uiBlock`) into the transcript —
 *      same pattern as pi-mono/coding-agent's AgentSession.sendCustomMessage.
 *
 * Returns the agent + store + emitCustomMessage + teardown function.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { env } from '../config/env.config';
import { maybeCompact } from '../compaction';
import { resolveConfiguredModel, resolveThinkingLevel } from '../llm/model-resolver';
import { buildTools } from '../tools';
import type { tCustomMessage } from '../types/custom-messages';
import { MongoSessionStore } from './mongo-store';
import { buildSystemPrompt, type iPromptContext } from './system-prompt';
import { convertToLlm } from './convert-to-llm';
import { buildAfterToolCall, buildBeforeToolCall } from './hooks';
import { logAgentEvent } from './event-logger';

export type { iPromptContext } from './system-prompt';

/**
 * Rebuild the system prompt for an existing agent using fresh per-turn context
 * (pageUrl, entityRefs, etc.). Callers mutate `agent.state.systemPrompt` with
 * the result before the next `prompt()` / `followUp()` so the LLM sees the
 * latest environment on every turn.
 *
 * Mirrors pi-mono/packages/mom/src/agent.ts:666-675, which rebuilds its system
 * prompt with fresh memory/channel/user state before each run.
 */
export function rebuildSystemPrompt(
  opts: { companyId: string; userId: string },
  promptContext?: Omit<iPromptContext, 'companyId' | 'userId'>,
): string {
  return buildSystemPrompt({
    companyId: opts.companyId,
    userId: opts.userId,
    ...promptContext,
  });
}

export interface iBuildAgentOptions {
  sessionId: string;
  companyId: string;
  userId: string;
  /** Caller callback invoked for every AgentEvent — typically sends to WebSocket */
  onEvent: (event: AgentEvent) => void | Promise<void>;
  /** Optional prompt context (company name, user name, page URL, entity refs) */
  promptContext?: Omit<iPromptContext, 'companyId' | 'userId'>;
  /** Origin metadata recorded on the session header (page URL, trigger) */
  origin?: Record<string, unknown>;
}

export interface iBuiltAgent {
  agent: Agent;
  store: MongoSessionStore;
  /**
   * Inject a pi-agent-core custom message (`iUIBlockMessage` for rich UI
   * blocks, or `iRefreshResourceMessage` for silent refresh signals) into
   * the transcript. Mirrors pi-mono's `AgentSession.sendCustomMessage` by
   * pushing the message onto `agent.state.messages` and then dispatching
   * `message_start` + `message_end` events through the same pipeline that
   * real Agent-emitted events flow through (Mongo persistence + WebSocket).
   *
   * Call from inside a tool's `execute` or from an `afterToolCall` extension
   * when you need to emit a first-class custom message rather than stuffing
   * data into a tool result's `details`.
   */
  emitCustomMessage: (msg: tCustomMessage) => Promise<void>;
  /** Unsubscribe the event listener. Call when tearing down. */
  dispose: () => void;
}

/**
 * Construct a runtime-ready Agent for a session. Callers are responsible for
 * retaining the returned reference and calling `dispose()` when the WS
 * connection closes.
 */
export async function buildAgent(opts: iBuildAgentOptions): Promise<iBuiltAgent> {
  const store = new MongoSessionStore({
    sessionId: opts.sessionId,
    companyId: opts.companyId,
    userId: opts.userId,
  });

  await store.ensureHeader(opts.origin);

  const { messages: historyMessages } = await store.loadSession();

  // Single event pipeline. Both the `agent.subscribe` listener (real events
  // emitted by pi-agent-core) and `emitCustomMessage` (synthetic events we
  // fire ourselves when injecting custom messages) funnel through this
  // function so Mongo persistence + WebSocket forwarding see exactly one
  // stream of events regardless of source. Mirrors pi-mono's pattern where
  // `AgentSession` owns a single `_emit` and everyone funnels through it.
  const dispatch = async (event: AgentEvent): Promise<void> => {
    logAgentEvent(opts.sessionId, event);
    try {
      await store.appendEvent(event);
    } catch (err) {
      console.error('[agent] mongo appendEvent failed', err);
    }
    try {
      await opts.onEvent(event);
    } catch (err) {
      console.error('[agent] onEvent callback failed', err);
    }
  };

  // Forward-declared so tools can capture it by closure. Populated below,
  // once `agent` exists, because emitCustomMessage needs to push onto
  // `agent.state.messages`.
  let emitCustomMessage: (msg: tCustomMessage) => Promise<void> = async () => {
    throw new Error('emitCustomMessage called before agent was built');
  };

  const tools = buildTools({
    apiKey: env.APP_API_KEY,
    actAsUserId: opts.userId,
    companyId: opts.companyId,
    requestId: opts.sessionId,
    emitCustomMessage: (msg) => emitCustomMessage(msg),
  });

  const resolvedModel = resolveConfiguredModel({
    selector: env.LLM_MODEL,
    apiKey: env.LLM_KEY,
  });
  const { model } = resolvedModel;
  const thinkingLevel = resolveThinkingLevel(model);

  const systemPrompt = buildSystemPrompt({
    companyId: opts.companyId,
    userId: opts.userId,
    ...opts.promptContext,
  });

  // Build the agent first so hooks can reference it by closure.
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
      messages: historyMessages,
    },
    convertToLlm,
    transformContext: async (messages, signal) =>
      maybeCompact(messages, model, resolvedModel.apiKey, signal),
    getApiKey: () => resolvedModel.apiKey,
    steeringMode: 'one-at-a-time',
    followUpMode: 'all',
    toolExecution: 'parallel',
    sessionId: opts.sessionId,
  });

  // Now that `agent` exists, populate the real emitCustomMessage.
  //
  // We can't route through `agent.subscribe`'s private listener iteration to
  // inject events — `Agent.processEvents` throws if invoked outside an active
  // run (`pi-mono/packages/agent/src/agent.ts:532`). Instead we mirror what
  // `processEvents` would do for `message_end` (push to `state.messages`),
  // then fan out through `dispatch` directly. This keeps Mongo + the
  // WebSocket in sync with the in-memory transcript without touching the
  // Agent's run machinery.
  emitCustomMessage = async (msg: tCustomMessage): Promise<void> => {
    agent.state.messages.push(msg);
    await dispatch({ type: 'message_start', message: msg });
    await dispatch({ type: 'message_end', message: msg });
  };

  const toolStartTimes = new Map<string, number>();
  const hookOpts = {
    agent,
    companyId: opts.companyId,
    userId: opts.userId,
  };
  agent.beforeToolCall = buildBeforeToolCall(hookOpts, toolStartTimes);
  agent.afterToolCall = buildAfterToolCall(hookOpts, toolStartTimes);

  // Subscribe our single listener so pi-agent-core-emitted events flow
  // through the same dispatch() function that emitCustomMessage uses.
  const unsubscribe = agent.subscribe(async (event) => {
    await dispatch(event);
  });

  return {
    agent,
    store,
    emitCustomMessage: (msg: tCustomMessage) => emitCustomMessage(msg),
    dispose: () => {
      unsubscribe();
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
