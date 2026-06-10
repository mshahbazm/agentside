/**
 * Resource kinds the AI can ask the user-facing UI to refresh after a
 * mutating action. Granularity is "what the user sees on a page", not
 * API-route granularity.
 *
 * Kept as `string` so the core stays app-agnostic. Narrow it to your own
 * union in your app for type safety, e.g.:
 *
 *   export type tRefreshResourceKind = 'invoice' | 'customer' | 'project';
 *
 * This union is kept in its own file (not `custom-messages.ts`) so it can be
 * re-exported to frontend consumers without pulling in the
 * `declare module '@mariozechner/pi-agent-core'` augmentation, which only
 * resolves inside this service.
 */
export type tRefreshResourceKind = string;
