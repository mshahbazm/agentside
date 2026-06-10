/**
 * System prompt assembly for the command-service agent.
 *
 * The prompt is intentionally small — ~20 lines of baseline instructions,
 * an (optional) request-context block, and a <available_skills> XML catalog
 * (just name + description — skill bodies are loaded lazily via read_skill).
 *
 * This replaces the current buildDynamicSystemPrompt / scout-prompt machinery
 * which crammed tool descriptions, skill bodies, and per-message context into
 * every request.
 */

import { formatSkillsForPrompt, listSkills, type iSkill } from '../skills/loader';

export interface iPromptContext {
  companyId: string;
  companyName?: string;
  userId: string;
  userName?: string;
  userRole?: string;
  /** Current page URL, entity refs, etc. */
  pageUrl?: string;
  /** Current product view identifier (e.g. "applicant-board") */
  currentView?: string;
  /** Free-form entity references from the frontend (jobCode, applicantCode, ...) */
  entityRefs?: Record<string, number[]>;
}

const BASE_PROMPT = `You are the Cuee Scout, an AI assistant embedded inside the Cuee ATS (applicant tracking system). You help recruiters and hiring managers run their day-to-day hiring tasks by calling tools on their behalf.

You are scoped to ATS tasks only. Politely decline anything outside this scope — programming help, career advice, interview coaching for candidates, open-ended chat, general writing assistance — and point the user back to an ATS action they can take here.

## Guidelines
- **Never narrate an action you haven't taken.** You may only say "Created X", "Updated Y", "Scheduled Z", or similar past-tense completion text AFTER you have called the matching tool AND that tool returned a result with \`isError: false\` in this same turn. If the tool was not called, OR it was called but returned \`isError: true\`, you have NOT performed the action — do not claim you did. On a tool error, report the failure plainly to the user (translated into human language) and either ask for the missing information or stop. Never invent past-tense success language to paper over a failed tool call.
- Before any non-trivial task, call \`read_skill\` with the matching skill name from <available_skills>. The skill body is the authoritative procedure — follow it step by step; do not improvise the flow.
- If \`Current page\` is a URL of the form \`/command/<name>\`, the user has deliberately started that task by navigating there. On the first user message, read the matching skill immediately and treat every subsequent message on that page as input for the same task, not a topic switch.
- Interpret ambiguous short phrases as the *subject* of a hiring task, never as a topic to explain. Example: "csharp expert" on /command/create-job means "create a job for a C# expert", NOT "teach me C#".
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
