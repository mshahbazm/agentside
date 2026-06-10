/**
 * Skill Loader
 *
 * Loads SKILL.md files from src/skills/*\/SKILL.md at boot time, parses their
 * YAML frontmatter, validates them, and exposes:
 *   - `loadSkills()` → Skill[] (called once at startup)
 *   - `getSkillByName(name)` → Skill | undefined (used by the read_skill tool)
 *   - `formatSkillsForPrompt(skills)` → XML block injected into system prompt
 *
 * Security note: this loader enumerates a hard-coded directory (`src/skills/`)
 * relative to this file. The agent never sees paths and cannot read arbitrary
 * files — only registered SKILL.md contents, looked up by name.
 *
 * Derived from pi-mono/packages/coding-agent/src/core/skills.ts, trimmed to
 * remove filesystem walking, source tracking, diagnostics, and ignore-file
 * handling we don't need inside a containerized service.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/** Max name length per Agent Skills spec. */
const MAX_NAME_LENGTH = 64;

/** Max description length per Agent Skills spec. */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface iSkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  /**
   * When `true`, the skill is hidden from the `<available_skills>` catalog
   * in the system prompt so the model can't discover it automatically.
   * Matches pi-mono's frontmatter key verbatim (hyphenated form).
   *
   * We don't expose slash-command invocation today, so a skill with this
   * set to true is effectively disabled in our service. We still accept
   * the field so SKILL.md files stay portable between pi-mono and ours.
   */
  'disable-model-invocation'?: boolean;
  [key: string]: unknown;
}

export interface iSkill {
  /** Kebab-case identifier, matches parent folder name */
  name: string;
  /** Short description shown in <available_skills> catalog */
  description: string;
  /** Optional category metadata (not used by the loader itself) */
  category?: string;
  /** Absolute path to the SKILL.md file (used for logging only) */
  filePath: string;
  /**
   * Full markdown body without frontmatter — what read_skill returns.
   *
   * DIVERGENCE from pi-mono: pi-mono's `Skill` type doesn't include the
   * body; it loads bodies lazily via the read tool at query time. We
   * eager-load bodies into memory at boot so the `read_skill` tool can do
   * a pure in-memory lookup and the agent never touches the filesystem.
   */
  body: string;
  /**
   * Mirror of pi-mono's `disableModelInvocation`. When true, the skill is
   * filtered out of `formatSkillsForPrompt` output.
   */
  disableModelInvocation: boolean;
}

/**
 * Internal in-memory index populated by `loadSkills()`. The `read_skill` tool
 * looks up skills here — it never touches the filesystem.
 */
const skillIndex = new Map<string, iSkill>();

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match folder "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name must only contain a-z, 0-9, and hyphens');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens');
  }
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (!description || description.trim() === '') {
    return ['description is required'];
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`];
  }
  return [];
}

function parseSkillFile(filePath: string): iSkill | null {
  const raw = readFileSync(filePath, 'utf-8');
  const { data: frontmatter, content: body } = matter(raw);
  const fm = frontmatter as iSkillFrontmatter;

  const parentDirName = basename(dirname(filePath));
  const name = fm.name ?? parentDirName;

  const nameErrors = validateName(name, parentDirName);
  const descErrors = validateDescription(fm.description);
  const errors = [...nameErrors, ...descErrors];

  if (errors.length > 0) {
    console.warn(`[skills] Invalid skill at ${filePath}:`, errors.join('; '));
    // If description is missing entirely we must skip — the catalog needs it.
    if (descErrors.length > 0) return null;
    // Otherwise load anyway, warnings are enough.
  }

  return {
    name,
    description: (fm.description as string).trim(),
    category: typeof fm.category === 'string' ? fm.category : undefined,
    filePath,
    body: body.trimStart(),
    disableModelInvocation: fm['disable-model-invocation'] === true,
  };
}

/**
 * Scan `src/skills/` for `<skill-name>/SKILL.md` files and build the index.
 * Call once at service boot. Safe to call multiple times; it rebuilds the index.
 */
export function loadSkills(): iSkill[] {
  skillIndex.clear();

  // Resolve the skills directory relative to this file. Works under both
  // `bun run src/index.ts` (TS source) and a compiled `dist/` layout.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const skillsRoot = here;

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch (err) {
    console.error('[skills] Failed to enumerate skills directory', skillsRoot, err);
    return [];
  }

  const loaded: iSkill[] = [];
  for (const entry of entries) {
    const entryPath = join(skillsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const skillFile = join(entryPath, 'SKILL.md');
    try {
      const stats = statSync(skillFile);
      if (!stats.isFile()) continue;
    } catch {
      continue;
    }

    const skill = parseSkillFile(skillFile);
    if (!skill) continue;

    if (skillIndex.has(skill.name)) {
      console.warn(
        `[skills] Duplicate skill name "${skill.name}"; keeping ${skillIndex.get(skill.name)?.filePath}`,
      );
      continue;
    }

    skillIndex.set(skill.name, skill);
    loaded.push(skill);
  }

  console.log(`[skills] Loaded ${loaded.length} skill(s): ${loaded.map((s) => s.name).join(', ')}`);
  return loaded;
}

/**
 * Look up a skill by name. Accepts both kebab-case (`create-job`) and
 * snake_case (`create_job`) because LLMs will mix them up.
 * Returns undefined if not registered.
 */
export function getSkillByName(name: string): iSkill | undefined {
  if (skillIndex.has(name)) return skillIndex.get(name);
  const normalized = name.trim().replace(/_/g, '-').toLowerCase();
  return skillIndex.get(normalized);
}

/** Return all currently loaded skills. */
export function listSkills(): iSkill[] {
  return Array.from(skillIndex.values());
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format the skill catalog as an XML block for the system prompt.
 * Skill bodies are NOT embedded — only name + description. The agent must
 * load bodies lazily via the `read_skill` tool when it decides a skill is
 * relevant to the current user message.
 *
 * Skills with `disableModelInvocation: true` are hidden from the catalog —
 * matches pi-mono's behavior. They can only be invoked via an explicit
 * slash-command path (which we don't expose today, so they're effectively
 * dormant, but SKILL.md files stay portable).
 */
export function formatSkillsForPrompt(skills: iSkill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) return '';

  const lines: string[] = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'When a user message matches a skill description, call the `read_skill` tool with the skill name to load its full instructions, then follow them step by step.',
    '',
    '<available_skills>',
  ];

  for (const skill of visibleSkills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}
