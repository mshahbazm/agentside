/**
 * convertToLlm — transforms an AgentMessage[] to the narrower Message[] the
 * LLM providers understand (user | assistant | toolResult).
 *
 * Filters out pi-agent-core custom messages declared in
 * `src/types/custom-messages.ts`. Today that's just `role: 'uiBlock'`, which
 * is a frontend-only rich UI artifact and must never be sent to the model.
 *
 * Mirrors pi-mono's pattern: coding-agent's `convertToLlm` in
 * `pi-mono/packages/coding-agent/src/core/convert-to-llm.ts` likewise strips
 * `bashExecution`, `custom`, `branchSummary`, etc. before handing to the LLM.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Message } from '@mariozechner/pi-ai';

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );
}
