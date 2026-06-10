/**
 * Resource kinds the AI can ask the user-facing UI to refresh after a
 * mutating action. Granularity is "what the recruiter sees on a page", not
 * API-route granularity. Standalone interviews are a `type:
 * 'standalone_interview'` job in the data model, but they share the
 * `interview` kind because that's how the user thinks of them.
 *
 * This union is kept in its own file (not `custom-messages.ts`) so it can be
 * re-exported to frontend consumers without pulling in the
 * `declare module '@mariozechner/pi-agent-core'` augmentation, which only
 * resolves inside command-service.
 */
export type tRefreshResourceKind =
  | 'interview'
  | 'job'
  | 'scorecard'
  | 'email-template'
  | 'workflow-template'
  | 'job-description-template';
