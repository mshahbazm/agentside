/**
 * read_skill tool — the only filesystem-adjacent tool exposed to the agent.
 *
 * Takes a skill name, looks it up in the in-memory skill index populated at
 * boot by `skills/loader.ts`, and returns the raw markdown body. The agent
 * never sees a path. If the name is unknown, the tool throws and the error
 * is relayed to the LLM as a tool_result with isError=true, which prompts it
 * to try again or fall back.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { getSkillByName, listSkills } from '../../skills/loader';

const parameters = Type.Object({
  name: Type.String({
    description:
      'The skill name to load (kebab-case, e.g. "create-job"). Must exactly match one of the names listed in <available_skills> in the system prompt.',
  }),
});

type tParams = Static<typeof parameters>;

export const readSkillTool: AgentTool<typeof parameters> = {
  name: 'read_skill',
  label: 'Read skill',
  description:
    'Load the full instructions for a skill by name. Call this when a user message matches a skill described in <available_skills> — the returned markdown contains step-by-step instructions you should follow exactly.',
  parameters,
  async execute(_toolCallId, params: tParams) {
    const skill = getSkillByName(params.name);
    if (!skill) {
      const available = listSkills()
        .map((s) => s.name)
        .join(', ');
      throw new Error(
        `No skill named "${params.name}". Available skills: ${available || '(none loaded)'}`,
      );
    }

    return {
      content: [{ type: 'text' as const, text: skill.body }],
      details: {
        name: skill.name,
        description: skill.description,
        category: skill.category,
      },
    };
  },
};
