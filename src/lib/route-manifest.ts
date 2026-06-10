/**
 * @locked
 * This file is the authoritative mapping between `page` ids used by the AI
 * and concrete frontend URL patterns served by `ats-app`'s TanStack router.
 * Get user approval before modifying:
 *   - src/lib/route-manifest.ts (this file)
 *   - src/skills/navigate/SKILL.md (the prose mirror the LLM reads)
 *
 * Why locked: `PAGE_PATTERNS` and the `navigate` skill body must stay in
 * lockstep. If a row is added, renamed, or removed in one place but not the
 * other, the LLM will either fail to navigate (unknown id → tool throws) or
 * silently send users to a wrong URL. Both are hard to catch in review.
 * When touching routes in `ats-app`, update BOTH this file AND the skill
 * page table in the same change, and double-check against the actual router
 * files in `packages/ats-app/src/routes/_protected/_with-sidebar/**`.
 *
 * ---
 *
 * Frontend route manifest for the ats-app.
 *
 * Single source of truth for the set of pages the AI is allowed to navigate
 * the user to. Consumed by the `navigate_to` tool in `src/tools/ui-tools.ts`
 * and mirrored (in prose form) by `src/skills/navigate/SKILL.md`.
 *
 * Each entry maps a kebab-case `page` id → a TanStack Router URL pattern
 * using `:param` placeholders. Adding a new route is:
 *   1. Append an entry here.
 *   2. Add a matching row to the navigate skill's page table.
 *   3. Restart the service (skills are eager-loaded at boot).
 *
 * Deliberately excluded — do not add back without consideration:
 *   - Creation forms (`/workspace/locations/new`, `/workspace/roles/new`,
 *     `/templates/scorecards/new`) — the AI should use `command_*_create`
 *     tools instead of dumping users into empty forms.
 *   - Unauthenticated surfaces (`/login`, `/register/:inviteCode`,
 *     `/verify`, `/join-team`, `/subscribe`, `/onboard`) — command-service
 *     only runs for authenticated, onboarded users; these are dead ends.
 *   - Admin-only flows (`/candidates/privacy`,
 *     `/candidates/import/:importId/review`) — not end-user navigation.
 *   - `/templates/jd` — unclear purpose; add explicitly when a skill needs it.
 */

export const PAGE_PATTERNS: Record<string, string> = {
  // Home + top-level navigation
  'home': '/',
  'jobs': '/jobs',
  'candidates': '/candidates',
  'interviews': '/interviews',
  'companies': '/companies',
  'contacts': '/contacts',
  'chat': '/chat',

  // Templates
  'workflow-templates': '/templates/workflows',
  'email-templates': '/templates/email',
  'scorecard-templates': '/templates/scorecards',

  // Workspace
  'departments': '/workspace/departments',
  'locations': '/workspace/locations',
  'roles': '/workspace/roles',
  'team': '/workspace/team',
  'compliance': '/workspace/compliance',
  'billing': '/workspace/billing',
  'organization': '/workspace/organization',

  // Settings
  'settings-profile': '/settings/profile',
  'settings-preferences': '/settings/preferences',
  'settings-integrations': '/settings/integrations',

  // Job sub-pages
  'job-detail': '/jobs/:code',
  'job-refine': '/jobs/:code/refine',
  'job-refine-workflow': '/jobs/:code/refine/workflow',
  'job-refine-application-form': '/jobs/:code/refine/application-form',
  'job-board': '/jobs/:code/board',
  'job-table': '/jobs/:code/table-view',
  'job-pipeline': '/jobs/:code/live-list',
  'job-analytics': '/jobs/:code/analytics',
  'job-distribute': '/jobs/:code/distribute',
  'job-candidate-detail': '/jobs/:code/candidates/:candidateCode',
  'job-interview-review': '/jobs/:code/interviews/:interviewId',

  // Template refine
  'workflow-template-refine': '/templates/workflows/:code/refine',
  'email-template-refine': '/templates/email/:code/refine',
  'scorecard-template-refine': '/templates/scorecards/:code/refine',

  // Interview sub-pages
  'interview-detail': '/interviews/:code',
  'interview-refine': '/interviews/:code/refine',
  'interview-candidates': '/interviews/:code/candidates',

  // Workspace sub-pages
  'location-refine': '/workspace/locations/:code/refine',
  'role-refine': '/workspace/roles/:code/refine',

  // Company detail
  'company-detail': '/companies/:code',
};

/**
 * Extract the `:param` placeholder names from a URL pattern.
 * e.g. `/jobs/:code/refine` → `['code']`; `/jobs/:code/candidates/:candidateCode` → `['code', 'candidateCode']`.
 */
function requiredParamsForPattern(pattern: string): string[] {
  return Array.from(pattern.matchAll(/\/:([a-zA-Z_][a-zA-Z0-9_]*)/g), (m) => m[1]);
}

/**
 * Resolve a `page` id + optional params into a concrete URL.
 *
 * Throws with a clear, informative message if the page id is unknown or a
 * required `:param` wasn't filled. `navigate_to`'s `execute` lets the throw
 * propagate — pi-agent-core surfaces it as a `tool_result` with
 * `isError: true`, and the LLM retries if it chooses to. Error text stays
 * terse (pi-mono convention) — the retry guidance lives in the tool
 * description, not in the error string.
 *
 * Defensive value filtering: null, undefined, and empty-string values are
 * treated as "not provided" even if the key is present on the `params`
 * object. This matters because the LLM (with `strict: false` on tool
 * schemas) sometimes emits keys with `null` or `""` as placeholders. Without
 * this filter we'd build broken URLs like `/jobs/null/refine` or
 * `/jobs//refine`.
 */
export function buildNavigationUrl(
  page: string,
  params?: Record<string, string | number | null | undefined>,
): string {
  const pattern = PAGE_PATTERNS[page];
  if (!pattern) {
    throw new Error(
      `Unknown page "${page}". Call read_skill("navigate") to see available page ids.`,
    );
  }

  const cleaned: Record<string, string> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      const str = String(value).trim();
      if (str === '') continue;
      cleaned[key] = str;
    }
  }

  let url = pattern;
  for (const [key, value] of Object.entries(cleaned)) {
    url = url.replace(`:${key}`, encodeURIComponent(value));
  }

  const required = requiredParamsForPattern(pattern);
  const missing = required.filter((name) => url.includes(`:${name}`));
  if (missing.length > 0) {
    const provided = Object.keys(cleaned);
    throw new Error(
      `Page "${page}" requires params: {${required.join(', ')}}. ` +
        `Provided params: {${provided.join(', ')}} (missing: ${missing.join(', ')}).`,
    );
  }

  return url;
}
