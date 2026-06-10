/**
 * Verbose agent-event logger for dev/debug.
 *
 * pi-agent-core emits a stream of typed AgentEvents (agent_start, turn_start,
 * tool_execution_start/end, message_end, agent_end, ...). In production we
 * only care about Mongo persistence + WebSocket fan-out. In dev we want a
 * grep-able stdout trail so we can answer questions like "did read_skill
 * actually fire for that csharp-expert turn, or did the LLM hallucinate?".
 *
 * Enabled via the `VERBOSE_AGENT_LOG=true` env var. When off,
 * `logAgentEvent` is a cheap early-return. We never log the bodies of tool
 * results — only isError + call metadata — because result payloads can be
 * large (job lists, applicant lists, etc.).
 */

import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type {
    AssistantMessage,
    Message,
    TextContent,
    ToolCall,
    ToolResultMessage,
    UserMessage,
} from '@mariozechner/pi-ai';
import { env } from '../config/env.config';

const VERBOSE = env.VERBOSE_AGENT_LOG;

function previewText(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Walk a message's content array and pull out the concatenated plain text.
 * Handles user/assistant/toolResult uniformly — skips images, thinking blocks,
 * and toolCall blocks (those are summarised separately).
 */
function extractText(message: Message): string {
  const content = (message as UserMessage | AssistantMessage | ToolResultMessage).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
      const text = (block as TextContent).text;
      if (text) parts.push(text);
    }
  }
  return parts.join(' ');
}

function summariseToolCalls(message: AssistantMessage): { count: number; names: string[] } {
  const names: string[] = [];
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      names.push((block as ToolCall).name);
    }
  }
  return { count: names.length, names };
}

function truncateJson(value: unknown, max = 200): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? {});
  } catch {
    json = '[unserialisable]';
  }
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/**
 * Pull a short text preview out of a tool result. pi-agent-core wraps results
 * as `{ content: [{type:'text', text}], details, isError }`. For error logs we
 * only want the first text block, truncated — never the details object (which
 * may contain large lists).
 */
function previewToolResult(result: unknown, max = 240): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) {
    // Defensive: tool returned a non-standard shape — JSON.stringify the
    // whole thing so we never log a literal "[object Object]".
    try {
      const json = JSON.stringify(r);
      return json.length > max ? `${json.slice(0, max)}…` : json;
    } catch {
      return '';
    }
  }
  const parts: string[] = [];
  for (const block of r.content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      } else if (text != null) {
        // Defensive: text block with a non-string payload — JSON it instead
        // of letting `Array.join` produce "[object Object]".
        try {
          parts.push(JSON.stringify(text));
        } catch {
          /* skip unserialisable block */
        }
      }
    }
  }
  const joined = parts.join(' ').trim().replace(/\s+/g, ' ');
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

/**
 * Emit one line per interesting AgentEvent. Silently drops streaming deltas
 * (`message_update`, `tool_execution_update`) because they fire dozens of
 * times per turn and would drown the useful signal.
 */
export function logAgentEvent(sessionId: string, event: AgentEvent): void {
  if (!VERBOSE) return;

  switch (event.type) {
    case 'agent_start':
      console.log(`[agent] ${sessionId} agent_start`);
      return;

    case 'turn_start':
      console.log(`[agent] ${sessionId} turn_start`);
      return;

    case 'message_start': {
      // Only log user messages here. Assistant message_start fires before the
      // final content is known; message_end has the full picture.
      if (event.message.role === 'user') {
        const text = previewText(extractText(event.message as UserMessage));
        console.log(`[agent] ${sessionId} message_start role=user text="${text}"`);
      }
      return;
    }

    case 'message_end': {
      const m = event.message;
      if (m.role === 'assistant') {
        const { count, names } = summariseToolCalls(m as AssistantMessage);
        const text = previewText(extractText(m));
        const stopReason = (m as AssistantMessage).stopReason;
        if (count > 0) {
          console.log(
            `[agent] ${sessionId} message_end role=assistant stopReason=${stopReason} toolCalls=${count} names=${names.join(',')}${text ? ` text="${text}"` : ''}`,
          );
        } else {
          console.log(
            `[agent] ${sessionId} message_end role=assistant stopReason=${stopReason} toolCalls=0 text="${text}"`,
          );
        }
      } else if (m.role === 'toolResult') {
        const tr = m as ToolResultMessage;
        const isErr = tr.isError === true;
        const errPreview = isErr ? previewText(extractText(tr), 240) : '';
        const errSuffix = isErr && errPreview ? ` error="${errPreview}"` : '';
        console.log(
          `[agent] ${sessionId} message_end role=toolResult tool=${tr.toolName} id=${tr.toolCallId} isError=${isErr}${errSuffix}`,
        );
      } else if (m.role === 'refreshResource') {
        const rm = m as { resource: string; id?: string; code?: number };
        const idSuffix = rm.id ? ` id=${rm.id}` : '';
        const codeSuffix = rm.code !== undefined ? ` code=${rm.code}` : '';
        console.log(
          `[agent] ${sessionId} message_end role=refreshResource resource=${rm.resource}${idSuffix}${codeSuffix}`,
        );
      } else if (m.role === 'uiBlock') {
        const um = m as { block?: { type?: string; id?: string }; toolCallId?: string };
        console.log(
          `[agent] ${sessionId} message_end role=uiBlock blockType=${um.block?.type ?? '?'} blockId=${um.block?.id ?? '?'} toolCallId=${um.toolCallId ?? '?'}`,
        );
      }
      return;
    }

    case 'tool_execution_start':
      console.log(
        `[agent] ${sessionId} tool_start name=${event.toolName} id=${event.toolCallId} args=${truncateJson(event.args)}`,
      );
      return;

    case 'tool_execution_end': {
      const isErr = event.isError === true;
      const errPreview = isErr ? previewToolResult(event.result) : '';
      const errSuffix = isErr && errPreview ? ` error="${errPreview}"` : '';
      console.log(
        `[agent] ${sessionId} tool_end name=${event.toolName} id=${event.toolCallId} isError=${isErr}${errSuffix}`,
      );
      return;
    }

    case 'turn_end': {
      const toolResults = event.toolResults?.length ?? 0;
      console.log(`[agent] ${sessionId} turn_end toolResults=${toolResults}`);
      return;
    }

    case 'agent_end':
      console.log(`[agent] ${sessionId} agent_end messages=${event.messages.length}`);
      return;

    // Silenced: message_update (streaming text deltas), tool_execution_update
    default:
      return;
  }
}
