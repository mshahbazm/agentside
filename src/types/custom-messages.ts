/**
 * Custom AgentMessages for command-service.
 *
 * Follows pi-agent-core's declaration-merging pattern for extending the
 * AgentMessage union with app-specific roles. See
 * `pi-mono/packages/coding-agent/src/core/messages.ts` for the reference
 * pattern — coding-agent adds `bashExecution`, `custom`, `branchSummary`,
 * `compactionSummary`.
 *
 * Roles:
 * - `uiBlock` — rich UI artifact (confirm card, choice list, navigate prompt, …)
 *   the frontend renders as its own transcript item.
 * - `refreshResource` — silent side-channel signal asking the user-facing UI
 *   to refetch a resource the AI just mutated. No transcript rendering.
 *
 * Both are excluded from LLM context by the inclusive filter in
 * `src/agent/convert-to-llm.ts` (only keeps user/assistant/toolResult).
 */

import type { tUIBlock } from './ui-block.types';
import type { tRefreshResourceKind } from './refresh-resource.types';

export interface iUIBlockMessage {
  role: 'uiBlock';
  block: tUIBlock;
  /** toolCallId of the UI tool that produced this block — used by the frontend for response routing */
  toolCallId: string;
  timestamp: number;
}

export interface iRefreshResourceMessage {
  role: 'refreshResource';
  resource: tRefreshResourceKind;
  /** UUID of the entity, if the AI has it. */
  id?: string;
  /** Numeric short code of the entity, if the AI has it. */
  code?: number;
  timestamp: number;
}

/** Union of every custom-message kind command-service can inject into the transcript. */
export type tCustomMessage = iUIBlockMessage | iRefreshResourceMessage;

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    uiBlock: iUIBlockMessage;
    refreshResource: iRefreshResourceMessage;
  }
}
