/**
 * System prompt assembly for the agentside agent.
 *
 * The prompt is intentionally small — baseline instructions, an (optional)
 * request-context block, and a <available_skills> XML catalog (just name +
 * description — skill bodies are loaded lazily via read_skill).
 *
 * Tailor the persona for your app here: `APP_NAME` (env) fills the assistant's
 * identity line; edit BASE_PROMPT directly for deeper changes (tone, scope,
 * domain examples). The guidelines below are deliberately generic and
 * battle-tested — keep them unless you have a reason not to.
 */

import { env } from '../config/env.config';
import { formatSkillsForPrompt, listSkills, type iSkill } from '../skills/loader';

export interface iPromptContext {
  companyId: string;
  companyName?: string;
  userId: string;
  userName?: string;
  userRole?: string;
  /** Current page URL, entity refs, etc. */
  pageUrl?: string;
  /** Current product view identifier (e.g. "dashboard") */
  currentView?: string;
  /** Free-form entity references from the frontend (e.g. invoiceCode, projectCode, ...) */
  entityRefs?: Record<string, number[]>;
}

const BASE_PROMPT = `You are the in-app AI assistant for ${env.APP_NAME}. You help users get their work done in this application by calling tools on their behalf.

You are scoped to tasks in this application only. Politely decline anything outside this scope — programming help, open-ended chat, general writing assistance — and point the user back to an action they can take here.

## Guidelines
- **Never narrate an action you haven't taken.** You may only say "Created X", "Updated Y", "Scheduled Z", or similar past-tense completion text AFTER you have called the matching tool AND that tool returned a result with \`isError: false\` in this same turn. If the tool was not called, OR it was called but returned \`isError: true\`, you have NOT performed the action — do not claim you did. On a tool error, report the failure plainly to the user (translated into human language) and either ask for the missing information or stop. Never invent past-tense success language to paper over a failed tool call.
- Before any non-trivial task, call \`read_skill\` with the matching skill name from <available_skills>. The skill body is the authoritative procedure — follow it step by step; do not improvise the flow.
- Interpret ambiguous short phrases as the *subject* of a task, never as a topic to explain.
- Prefer acting over asking. Infer fields from the Request Context (current page, active entities) and the conversation history before prompting.
- Keep text responses short. The frontend renders tool results (UI blocks, lists) directly — do not repeat their content in your reply.
- Translate API errors to short, human-readable messages. Never expose stack traces or raw error payloads.
- For destructive or bulk actions, call \`confirm_action\` first with a \`deferredAction\` so approval runs the action without another round-trip.`;

function formatContext(ctx: iPromptContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('## Request Context');
  if (ctx.companyName || ctx.companyId) {
    lines.push(`- Company: ${ctx.companyName ?? ''} (${ctx.companyId})`);
  }
  if (ctx.userName || ctx.userId) {
    lines.push(`- User: ${ctx.userName ?? ''} (${ctx.userId})${ctx.userRole ? ` — role: ${ctx.userRole}` : ''}`);
  }
  if (ctx.pageUrl) {
    lines.push(`- Current page: ${ctx.pageUrl}`);
  }
  if (ctx.currentView) {
    lines.push(`- Current view: ${ctx.currentView}`);
  }
  if (ctx.entityRefs && Object.keys(ctx.entityRefs).length > 0) {
    const refs = Object.entries(ctx.entityRefs)
      .map(([k, v]) => `${k}=${v.join(',')}`)
      .join(', ');
    lines.push(`- Active entities: ${refs}`);
  }
  return lines.join('\n');
}

/**
 * Build the system prompt for the current request.
 * @param ctx - Request context (company, user, page)
 * @param skills - Optional pre-loaded skill list; defaults to `listSkills()`
 */
export function buildSystemPrompt(ctx: iPromptContext, skills?: iSkill[]): string {
  const skillList = skills ?? listSkills();
  const sections: string[] = [BASE_PROMPT];

  const contextBlock = formatContext(ctx);
  if (contextBlock.trim()) sections.push(contextBlock);

  const skillBlock = formatSkillsForPrompt(skillList);
  if (skillBlock) sections.push(skillBlock);

  sections.push(`\nCurrent date: ${new Date().toISOString().slice(0, 10)}`);

  return sections.join('\n');
}
