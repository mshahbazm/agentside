/**
 * Context compaction for the agentside agent.
 *
 * Derived from pi-mono/packages/coding-agent/src/core/compaction/* but
 * radically trimmed for our use case:
 *   - No session-entry / session-manager coupling — we work directly on AgentMessage[]
 *   - No file-tracking, no branch summaries, no split-turn handling
 *   - No extension hooks
 *
 * Public surface mirrors pi-mono's: `calculateContextTokens`,
 * `estimateTokens`, `estimateContextTokens`, `shouldCompact`, plus the
 * convenience wrapper `maybeCompact` we wire into `Agent.transformContext`.
 *
 * When the output is injected back as a synthetic user message, we wrap it
 * in the SAME `<summary>` tags pi-mono uses (see COMPACTION_SUMMARY_PREFIX /
 * SUFFIX below) so a compacted conversation looks identical whether it was
 * produced by our service or by pi-mono's coding-agent.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Message, Model, Usage } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';

// ============================================================================
// Summary tags — copied verbatim from pi-mono/coding-agent/src/core/messages.ts
// so compacted messages are shape-compatible with pi-mono's conventions.
// ============================================================================

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// ============================================================================
// Token estimation
// ============================================================================

export interface iCompactionSettings {
  /** Reserve this many tokens below the context window for output + overhead */
  reserveTokens: number;
  /** After compaction, keep at least this many tokens of recent history */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: iCompactionSettings = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** Total context tokens from a Usage record (prefers native totalTokens). */
function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Cheap chars/4 heuristic for messages without a reported usage.
 *
 * Mirrors pi-mono's `estimateTokens` export from
 * `coding-agent/src/core/compaction/compaction.ts` — kept as a top-level
 * export so anyone reading the two codebases finds the same symbol.
 */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  switch (message.role) {
    case 'user': {
      const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
      if (typeof content === 'string') {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) chars += block.text.length;
          if (block.type === 'image') chars += 4800;
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'assistant': {
      const asst = message as AssistantMessage;
      for (const block of asst.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case 'toolResult': {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
        if (block.type === 'image') chars += 4800;
      }
      return Math.ceil(chars / 4);
    }
    default:
      // Custom message types (ui_block, etc.) — conservative estimate
      return 50;
  }
}

function getLastAssistantUsage(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const asst = msg as AssistantMessage;
    if (asst.stopReason === 'error' || asst.stopReason === 'aborted') continue;
    if (asst.usage) return { usage: asst.usage, index: i };
  }
  return undefined;
}

export interface iContextUsageEstimate {
  tokens: number;
  lastUsageIndex: number | null;
}

/**
 * Predicate matching pi-mono's `shouldCompact` export. Returns true when
 * the context has grown close enough to the model's window that we should
 * compact. Settings default to {@link DEFAULT_COMPACTION_SETTINGS}.
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: iCompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Estimate current context tokens. Uses the last provider-reported usage as the
 * baseline (accurate) and only estimates tokens for anything newer (heuristic).
 */
export function estimateContextTokens(messages: AgentMessage[]): iContextUsageEstimate {
  const usageInfo = getLastAssistantUsage(messages);

  if (!usageInfo) {
    let tokens = 0;
    for (const m of messages) tokens += estimateTokens(m);
    return { tokens, lastUsageIndex: null };
  }

  let tokens = calculateContextTokens(usageInfo.usage);
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    tokens += estimateTokens(messages[i]);
  }
  return { tokens, lastUsageIndex: usageInfo.index };
}

// ============================================================================
// Cut-point detection
// ============================================================================

/**
 * Walk backwards from the end, accumulating token estimates. Find the oldest
 * message index we can still "keep" while staying under `keepRecentTokens`.
 * We never cut in the middle of a tool-call/tool-result pair — if the cut point
 * lands on a `toolResult`, we back up to the preceding `user` or `assistant`.
 */
function findCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
  let accumulated = 0;
  let cutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      cutIndex = i;
      break;
    }
  }

  // Don't cut mid-turn: back up until the kept window starts with a user message.
  while (cutIndex > 0 && messages[cutIndex].role !== 'user') {
    cutIndex--;
  }

  return cutIndex;
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant inside an ATS (applicant tracking system) AI agent. Your job is to read a conversation between a user and an AI assistant and produce a structured summary that another assistant can use to continue the work.

Do NOT continue the conversation. Do NOT answer any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_USER_PROMPT = `The messages above are a conversation to summarize. Create a compact context checkpoint another AI can use to continue seamlessly.

Use this exact format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [Completed actions (jobs created, templates saved, stages added, etc.)]

### In Progress
- [Current work]

## Key Decisions
- [Decisions, field values chosen, skills loaded]

## Next Steps
1. [What should happen next]

## Critical Context
- [Codes, names, IDs, anything the next turn needs]

Keep each section terse. Preserve exact codes (job-5, email-2), field values, and error messages.`;

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('');
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'toolCall') {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ');
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join('\n')}`);
      if (toolCalls.length > 0) parts.push(`[Tool calls]: ${toolCalls.join('; ')}`);
    } else if (msg.role === 'toolResult') {
      const text = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) {
        const truncated = text.length > 2000 ? `${text.slice(0, 2000)}… [truncated]` : text;
        parts.push(`[Tool result]: ${truncated}`);
      }
    }
  }
  return parts.join('\n\n');
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );
}

async function generateSummary(
  messagesToSummarize: AgentMessage[],
  model: Model<any>,
  settings: iCompactionSettings,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string> {
  const maxTokens = Math.floor(0.8 * settings.reserveTokens);
  const conversationText = serializeConversation(convertToLlm(messagesToSummarize));
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_USER_PROMPT}`;

  const response = await completeSimple(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, signal, apiKey },
  );

  if (response.stopReason === 'error') {
    throw new Error(`Compaction summarization failed: ${response.errorMessage ?? 'unknown error'}`);
  }

  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * If the current context is within budget, return messages unchanged.
 * Otherwise, summarize everything before the cut point and replace it with a
 * single synthetic user message containing the summary.
 *
 * Called from `Agent.transformContext`. Must not throw — on error, returns the
 * original messages array so the LLM request still proceeds (it might overflow
 * the context window, but that failure is visible and recoverable).
 */
export async function maybeCompact(
  messages: AgentMessage[],
  model: Model<any>,
  apiKey?: string,
  signal?: AbortSignal,
  settings: iCompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): Promise<AgentMessage[]> {
  try {
    const estimate = estimateContextTokens(messages);

    if (!shouldCompact(estimate.tokens, model.contextWindow, settings)) {
      return messages;
    }

    const cutIndex = findCutIndex(messages, settings.keepRecentTokens);
    if (cutIndex <= 0) {
      // Nothing safe to cut — bail out and let the request through as-is.
      return messages;
    }

    const toSummarize = messages.slice(0, cutIndex);
    const toKeep = messages.slice(cutIndex);

    const budget = model.contextWindow - settings.reserveTokens;
    console.log(
      `[compaction] Context ${estimate.tokens} tokens exceeds ${budget} budget; summarizing ${toSummarize.length} messages, keeping ${toKeep.length}`,
    );

    const summary = await generateSummary(toSummarize, model, settings, apiKey, signal);

    const summaryMessage: AgentMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
        },
      ],
      timestamp: Date.now(),
    };

    return [summaryMessage, ...toKeep];
  } catch (err) {
    console.warn('[compaction] Failed, returning original messages:', err);
    return messages;
  }
}
