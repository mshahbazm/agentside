/**
 * Agent lifecycle hooks.
 *
 * - `beforeToolCall`:
 *     * Rate-limit check (per user+company) for ats-calling tools. Blocks the
 *       tool call with a user-friendly error if the hard limit is exceeded,
 *       or sleeps by `delayMs` if the soft limit is crossed.
 *     * No check for UI tools / read_skill — they're either client-side or
 *       cheap bundled reads.
 *     * Per-tool start time recorded in a Map keyed by toolCallId so the
 *       after hook can compute duration for analytics.
 *
 * - `afterToolCall` (pipeline, in order):
 *     1. Record tool usage analytics (best-effort, fire-and-forget).
 *
 * Navigation (auto-redirect after entity creation and user-driven "take me
 * to X" requests) is handled by the `navigate_to` tool and the `navigate`
 * skill, not by a lifecycle extension. Creation skills explicitly call
 * `navigate_to` on success, which keeps per-shape knowledge where it
 * belongs (in the skill that knows its own tool's result shape) and lets
 * skills decide when NOT to navigate (e.g. batch operations).
 */

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@mariozechner/pi-agent-core';
import { UI_TOOL_NAMES } from '../tools';
import { checkRateLimit } from '../services/rate-limiter.service';
import { recordToolUsage } from '../services/analytics.service';

export interface iHookOptions {
  /** The active agent — needed so afterToolCall can abort it when a UI tool runs. */
  agent: Agent;
  /** Company ID for rate limit scoping + analytics */
  companyId: string;
  /** User ID for rate limit scoping */
  userId: string;
}

/**
 * Tools that don't count against rate limits.
 *
 * `navigate_to` is listed explicitly because it's a pure client-side tool
 * (no HTTP, no DB) but is deliberately NOT in `UI_TOOL_NAMES` — UI tools
 * there are the ones that pause the turn for a user click, and navigation
 * is fire-and-forget. The rate-limit exemption and the UI_TOOL_NAMES abort
 * semantics are orthogonal concerns even though UI tools happen to need
 * both.
 */
const EXEMPT_FROM_RATE_LIMIT: ReadonlySet<string> = new Set([
  'read_skill',
  'navigate_to',
  ...UI_TOOL_NAMES,
]);

export function buildBeforeToolCall(
  opts: iHookOptions,
  startTimes: Map<string, number>,
): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (ctx, _signal) => {
    const toolName = ctx.toolCall.name;
    startTimes.set(ctx.toolCall.id, Date.now());

    if (EXEMPT_FROM_RATE_LIMIT.has(toolName)) {
      return undefined;
    }

    const rl = await checkRateLimit(opts.companyId, opts.userId);
    if (!rl.allowed) {
      return {
        block: true,
        reason: `You're running actions too fast. Please wait a few seconds and try again. (rate-limited by ${rl.limitedBy ?? 'system'})`,
      };
    }
    if (rl.delayMs > 0) {
      // Soft limit crossed — delay to smooth out the burst.
      await new Promise((resolve) => setTimeout(resolve, Math.min(rl.delayMs, 10_000)));
    }
    return undefined;
  };
}

export function buildAfterToolCall(
  opts: iHookOptions,
  startTimes: Map<string, number>,
): (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
  return async (ctx, _signal) => {
    const toolName = ctx.toolCall.name;
    const startedAt = startTimes.get(ctx.toolCall.id);
    startTimes.delete(ctx.toolCall.id);
    const durationMs = startedAt ? Date.now() - startedAt : 0;

    // Fire-and-forget analytics. Swallow errors — never block a tool result.
    void recordToolUsage({
      toolName,
      companyId: opts.companyId,
      success: !ctx.isError,
      durationMs,
    }).catch(() => undefined);

    return undefined;
  };
}
