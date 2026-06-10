/**
 * Frontend route manifest — EXTENSION POINT.
 *
 * Single source of truth for the set of pages the agent is allowed to
 * navigate the user to. Consumed by the `navigate_to` tool in
 * `src/tools/ui-tools.ts`. Replace the sample entries below with your
 * frontend's routes.
 *
 * Each entry maps a kebab-case `page` id → a URL pattern using `:param`
 * placeholders. Adding a new route is:
 *   1. Append an entry here.
 *   2. If you keep a navigation skill (recommended once the list grows),
 *      add a matching row to its page table — the manifest and the skill's
 *      prose must stay in lockstep, or the LLM will navigate to wrong/
 *      unknown pages.
 *   3. Restart the service (skills are eager-loaded at boot).
 *
 * Tips from production use:
 *   - Don't add creation-form routes — let the agent create entities via
 *     tools instead of dumping users into empty forms.
 *   - Don't add unauthenticated surfaces (login, signup) — the agent only
 *     runs for authenticated users; those are dead ends.
 */

export const PAGE_PATTERNS: Record<string, string> = {
  // Samples — replace with your app's routes.
  'home': '/',
  'settings': '/settings',
  'item-detail': '/items/:code',
};

/**
 * Extract the `:param` placeholder names from a URL pattern.
 * e.g. `/items/:code/edit` → `['code']`.
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
 * this filter we'd build broken URLs like `/items/null/edit` or
 * `/items//edit`.
 */
export function buildNavigationUrl(
  page: string,
  params?: Record<string, string | number | null | undefined>,
): string {
  const pattern = PAGE_PATTERNS[page];
  if (!pattern) {
    throw new Error(
      `Unknown page "${page}". Known pages: ${Object.keys(PAGE_PATTERNS).join(', ')}.`,
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
