/**
 * Tool registry for the agentside agent.
 *
 * `buildTools(ctx)` is called once per agent run (inside buildAgent) and
 * returns a flat AgentTool[] composed of:
 *   - read_skill (builtin)
 *   - your app's HTTP tools (see app-tools.ts — the main extension point)
 *   - client-side UI tools (present_choices, confirm_action, ...)
 *
 * Each HTTP tool is constructed with the current request's AppApiClient, so it
 * carries the service auth + companyId for the lifetime of the run.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { tCustomMessage } from '../types/custom-messages';
import { AppApiClient, type iAppApiClientOptions } from './shared/api-client';
import { readSkillTool } from './builtin/read-skill';
import { buildAppTools } from './app-tools';
import { buildUiTools, UI_TOOL_NAMES } from './ui-tools';

export { AppApiClient, UI_TOOL_NAMES };
export type { iAppApiClientOptions };

export interface iBuildToolsContext {
  apiKey: string;
  actAsUserId: string;
  companyId: string;
  requestId?: string;
  /** Emit a pi-agent-core custom message into the transcript (see runtime.ts). */
  emitCustomMessage: (msg: tCustomMessage) => Promise<void>;
}

export function buildTools(ctx: iBuildToolsContext): AgentTool<any>[] {
  const api = new AppApiClient({
    apiKey: ctx.apiKey,
    actAsUserId: ctx.actAsUserId,
    companyId: ctx.companyId,
    requestId: ctx.requestId,
  });

  return [
    readSkillTool,
    ...buildAppTools(api),
    ...buildUiTools({ emitCustomMessage: ctx.emitCustomMessage }),
  ];
}
