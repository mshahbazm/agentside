/**
 * agentside public type exports.
 *
 * - `ui-block.types` is the frontend contract for interactive UI blocks.
 * - `auth.types` is the JWT payload shape verified at WebSocket upgrade.
 *
 * `custom-messages.ts` is intentionally NOT re-exported: it contains a
 * `declare module '@mariozechner/pi-agent-core'` augmentation that is only
 * meaningful inside this service (which depends on pi-agent-core).
 * Re-exporting it — even a single type — would force TS to parse the
 * augmentation in frontend consumers that have no reason to depend on
 * pi-agent-core and can't resolve the module.
 *
 * The plain string kind (`tRefreshResourceKind`) lives in its own
 * `refresh-resource.types.ts` so the frontend can import it without
 * dragging in the augmentation.
 */

export * from './auth.types';
export * from './ui-block.types';
export type { tRefreshResourceKind } from './refresh-resource.types';
