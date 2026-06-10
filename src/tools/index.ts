/**
 * Tool registry for the command-service agent.
 *
 * `buildTools(ctx)` is called once per agent run (inside buildAgent) and
 * returns a flat AgentTool[] composed of:
 *   - read_skill (builtin)
 *   - ats HTTP tools (jobs, applicants, email templates, scorecards, ...)
 *   - command_* consolidated helpers
 *   - client-side UI tools (present_choices, confirm_action, ...)
 *
 * Each ats tool is constructed with the current request's AtsClient, so it
 * carries the service auth + companyId for the lifetime of the run.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { tCustomMessage } from '../types/custom-messages';
import { AtsClient, type iAtsClientOptions } from './shared/ats-client';
import { readSkillTool } from './builtin/read-skill';
import { buildAtsTools } from './ats-tools';
import { buildCommandHelperTools } from './command-helpers';
import { buildUiTools, UI_TOOL_NAMES } from './ui-tools';

export { AtsClient, UI_TOOL_NAMES };
export type { iAtsClientOptions };

export interface iBuildToolsContext {
  apiKey: string;
  actAsUserId: string;
  companyId: string;
  requestId?: string;
  /** Emit a pi-agent-core custom message into the transcript (see runtime.ts). */
  emitCustomMessage: (msg: tCustomMessage) => Promise<void>;
}

export function buildTools(ctx: iBuildToolsContext): AgentTool<any>[] {
  const ats = new AtsClient({
    apiKey: ctx.apiKey,
    actAsUserId: ctx.actAsUserId,
    companyId: ctx.companyId,
    requestId: ctx.requestId,
  });

  return [
    readSkillTool,
    ...buildAtsTools(ats),
    ...buildCommandHelperTools(ats),
    ...buildUiTools({ emitCustomMessage: ctx.emitCustomMessage }),
  ];
}
