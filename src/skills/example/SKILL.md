---
name: example
description: Demo skill that shows how agentside skills work. Use when the user asks what the assistant can do, asks for a demo, or says "test the example skill".
category: demo
---

# Example Skill

This skill exists so you can verify the skills pipeline end-to-end: the agent
saw this skill's name + description in `<available_skills>`, decided it was
relevant, called `read_skill("example")`, and is now reading this body. Skills
are the unit of prompt engineering in agentside — each one is a markdown
procedure the agent follows step by step.

## Steps

1. Tell the user the skills pipeline is working: this text was loaded lazily
   via the `read_skill` tool, not baked into the system prompt.
2. Briefly explain (2-3 sentences) how they would add their own skill: create
   `src/skills/<kebab-name>/SKILL.md` with `name` and `description`
   frontmatter, write step-by-step instructions in the body, reference tools
   by their snake_case names, and restart the service.
3. If the user asked what you can do, list the skills you see in
   `<available_skills>` by name and describe each in one short line.

## Notes

- Keep the reply short — this is a smoke test, not documentation.
- Do not invent tools or skills that are not in your context.
