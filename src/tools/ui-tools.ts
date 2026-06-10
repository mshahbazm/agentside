/**
 * Client-side UI tools.
 *
 * These tools don't hit ats-api. They build a UI block (see
 * `src/types/ui-block.types.ts` for shapes), emit it as a pi-agent-core
 * custom message via `ctx.emitCustomMessage`, and return a plain text
 * acknowledgement as the `toolResult`. The LLM sees only the text ack;
 * the frontend sees the custom message and renders the rich UI.
 *
 * The `afterToolCall` hook in `src/agent/hooks.ts` still aborts the agent
 * run when a UI tool fires (`UI_TOOL_NAMES`) so the loop unwinds after
 * `turn_end` and the frontend can wait for the user's click. Emitting the
 * custom message before returning keeps `message_end` for the uiBlock
 * ordered *before* `tool_execution_end` / tool_result in the event stream.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { v4 as uuidv4 } from 'uuid';
import type {
  iSelectOneBlock,
  iActionButtonsBlock,
  iConfirmBlock,
  iSimpleListBlock,
  iInterviewQuestionsBlock,
  iContentDiffBlock,
  iNavigateBlock,
} from '../types/ui-block.types';
import type { tCustomMessage } from '../types/custom-messages';
import { buildNavigationUrl, PAGE_PATTERNS } from '../lib/route-manifest';

/** Names of tools whose execution should abort the agent run after completion. */
export const UI_TOOL_NAMES: ReadonlySet<string> = new Set([
  'present_choices',
  'confirm_action',
  'present_content_confirmation',
  'present_interview_questions',
  'show_simple_list',
]);

/** Context passed into `buildUiTools` — lets each tool emit custom messages. */
export interface iUiToolsContext {
  emitCustomMessage: (msg: tCustomMessage) => Promise<void>;
}

const deferredActionSchema = Type.Optional(
  Type.Object({
    toolName: Type.String(),
    arguments: Type.Record(Type.String(), Type.Any()),
  }),
);

/**
 * Normalize drift patterns common to all UI tools — runs before schema
 * validation via `AgentTool.prepareArguments`. Pi-mono's reference pattern is
 * `pi-mono/packages/coding-agent/src/core/tools/edit.ts:prepareEditArguments`.
 *
 * Why this exists: pi-ai ships our tool definitions to OpenAI with
 * `strict: false` (`pi-mono/packages/ai/src/providers/openai-responses.ts:213`),
 * so the LLM treats the JSON Schema as a suggestion and frequently omits
 * required nested fields. `prepareArguments` is the pi-agent-core idiomatic
 * place to fix that up before validation runs.
 *
 * Currently catches:
 *   - `deferredAction` provided without `arguments` → backfill `arguments: {}`.
 *
 * Extend here as new drift patterns surface in the wild.
 */
function prepareCommonUiArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input as Record<string, unknown>;
  const args = { ...(input as Record<string, unknown>) };
  const da = args.deferredAction;
  if (da && typeof da === 'object') {
    const obj = da as { toolName?: unknown; arguments?: unknown };
    if (obj.arguments === undefined || obj.arguments === null) {
      args.deferredAction = { ...obj, arguments: {} };
    }
  }
  return args;
}

/**
 * `navigate_to`-specific normalizer. Runs via `AgentTool.prepareArguments`
 * before TypeBox validation. Fixes drift we see in practice:
 *
 * - LLM sends `page` in mixed case ("Jobs") → lowercase it.
 * - LLM sends snake_case page id ("job_refine") → convert to kebab-case
 *   ("job-refine"). Same tolerance the skill loader applies in
 *   `getSkillByName` (`src/skills/loader.ts`).
 * - LLM sends leading/trailing whitespace → trim it.
 * - LLM sends `params: null` instead of omitting → drop it.
 * - LLM sends individual param values of `null` / `undefined` / `""` →
 *   drop the keys so the URL builder's missing-param check fires cleanly
 *   instead of interpolating `"null"` into the URL.
 * - LLM drops `params` entirely and puts the code into `title` instead
 *   ("Open workflow template #13") → for single-placeholder pages, recover
 *   the integer from `title` and inject it as the missing param. Mirrors
 *   pi-mono's `prepareEditArguments` (edit.ts) sibling-field salvage.
 */
function prepareNavigateToArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input as Record<string, unknown>;
  const args = { ...(input as Record<string, unknown>) };

  if (typeof args.page === 'string') {
    args.page = args.page.trim().toLowerCase().replace(/_/g, '-');
  }

  if (args.params === null) {
    delete args.params;
  } else if (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) {
    const cleaned: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(args.params as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (typeof value === 'string' || typeof value === 'number') {
        cleaned[key] = value;
      } else {
        // Coerce everything else to string — the URL builder trims again.
        cleaned[key] = String(value);
      }
    }
    args.params = cleaned;
  }

  // Sibling-field salvage: single-placeholder pages with missing params.
  // Only activate when the target pattern has exactly ONE `:placeholder` —
  // multi-param routes (e.g. job-candidate-detail) stay strict because
  // guessing the wrong code into the wrong slot would silently corrupt URLs.
  if (typeof args.page === 'string') {
    const pattern = PAGE_PATTERNS[args.page];
    if (pattern) {
      const placeholders = Array.from(
        pattern.matchAll(/\/:([a-zA-Z_][a-zA-Z0-9_]*)/g),
        (m) => m[1],
      );
      if (placeholders.length === 1) {
        const placeholder = placeholders[0];
        const existing = (args.params as Record<string, unknown> | undefined) ?? {};
        const has =
          existing[placeholder] !== undefined &&
          existing[placeholder] !== null &&
          existing[placeholder] !== '';
        if (!has && typeof args.title === 'string' && args.title.length > 0) {
          // Prefer "#<digits>" (the convention the skills instruct), fall
          // back to the last run of digits anywhere in the title.
          const hashMatch = args.title.match(/#(\d+)/);
          const tailMatch = args.title.match(/(\d+)(?!.*\d)/);
          const recovered = hashMatch?.[1] ?? tailMatch?.[1];
          if (recovered) {
            args.params = { ...existing, [placeholder]: Number(recovered) };
          }
        }
      }
    }
  }

  return args;
}

const KNOWN_BADGE_VARIANTS: ReadonlySet<string> = new Set([
  'green',
  'blue',
  'purple',
  'amber',
  'red',
  'gray',
  'neutral',
]);

/**
 * `show_simple_list`-specific normalizer. Wraps `prepareCommonUiArgs` and
 * additionally coerces unknown badge variants (e.g. `default`, `success`,
 * `info`, `primary`) to `'neutral'` so the schema check never rejects a list
 * just because the LLM picked a natural-language colour name.
 */
function prepareSimpleListArgs(input: unknown): Record<string, unknown> {
  const args = prepareCommonUiArgs(input);
  const items = args.items;
  if (Array.isArray(items)) {
    args.items = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = item as { badge?: { label?: unknown; variant?: unknown } };
      if (it.badge && typeof it.badge === 'object' && typeof it.badge.variant === 'string') {
        if (!KNOWN_BADGE_VARIANTS.has(it.badge.variant)) {
          return { ...it, badge: { ...it.badge, variant: 'neutral' } };
        }
      }
      return item;
    });
  }
  return args;
}

export function buildUiTools(ctx: iUiToolsContext): AgentTool<any>[] {
  const emitBlock = async (
    block:
      | iSelectOneBlock
      | iActionButtonsBlock
      | iConfirmBlock
      | iSimpleListBlock
      | iInterviewQuestionsBlock
      | iContentDiffBlock
      | iNavigateBlock,
    toolCallId: string,
  ): Promise<void> => {
    await ctx.emitCustomMessage({
      role: 'uiBlock',
      block,
      toolCallId,
      timestamp: Date.now(),
    });
  };

  // ==========================================================================
  // present_choices
  // ==========================================================================
  const presentChoicesParams = Type.Object({
    type: Type.Union([Type.Literal('select_one'), Type.Literal('action_buttons')]),
    title: Type.String({ description: 'Prompt shown to user (e.g., "Which location?")' }),
    description: Type.Optional(Type.String()),
    options: Type.Optional(
      Type.Array(
        Type.Object({
          value: Type.String({ description: 'Machine-readable value' }),
          label: Type.String({ description: 'Human-readable label' }),
          description: Type.Optional(Type.String()),
        }),
      ),
    ),
    actions: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          variant: Type.Optional(
            Type.Union([
              Type.Literal('primary'),
              Type.Literal('secondary'),
              Type.Literal('outline'),
            ]),
          ),
        }),
      ),
    ),
    deferredAction: deferredActionSchema,
  });

  const presentChoicesTool: AgentTool<typeof presentChoicesParams> = {
    name: 'present_choices',
    label: 'Present choices',
    description:
      'Present interactive choices as clickable UI elements. Use `select_one` when the user must pick from existing options (locations, departments, templates). Use `action_buttons` for suggested next steps after an action. The turn ends after this tool runs — the user clicks an option and the next turn continues with their choice.',
    parameters: presentChoicesParams,
    prepareArguments: (i) => prepareCommonUiArgs(i) as Static<typeof presentChoicesParams>,
    async execute(toolCallId, params: Static<typeof presentChoicesParams>) {
      const block: iSelectOneBlock | iActionButtonsBlock =
        params.type === 'select_one'
          ? {
              id: uuidv4(),
              type: 'select_one',
              title: params.title,
              description: params.description,
              options: params.options ?? [],
              toolCallId,
              toolName: 'present_choices',
              deferredAction: params.deferredAction,
            }
          : {
              id: uuidv4(),
              type: 'action_buttons',
              title: params.title,
              description: params.description,
              actions: params.actions ?? [],
              toolCallId,
              toolName: 'present_choices',
              deferredAction: params.deferredAction,
            };
      await emitBlock(block, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Presented ${params.type} UI block to user. Waiting for their response.`,
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // confirm_action
  // ==========================================================================
  const confirmActionParams = Type.Object({
    action: Type.String({ description: 'Short action label, max ~60 chars' }),
    details: Type.Optional(Type.String({ description: 'Brief summary, max ~150 chars' })),
    severity: Type.Optional(
      Type.Union([
        Type.Literal('info'),
        Type.Literal('warning'),
        Type.Literal('destructive'),
      ]),
    ),
    confirmLabel: Type.Optional(Type.String()),
    cancelLabel: Type.Optional(Type.String()),
    affectedItems: Type.Optional(
      Type.Array(
        Type.Object({
          label: Type.String(),
          description: Type.Optional(Type.String()),
        }),
      ),
    ),
    deferredAction: deferredActionSchema,
  });

  const confirmActionTool: AgentTool<typeof confirmActionParams> = {
    name: 'confirm_action',
    label: 'Confirm action',
    description:
      'Request user confirmation before a significant action (bulk moves, rejections, sending emails). Renders a compact confirmation card. Keep action short and details brief. Include a deferredAction so the action executes on approval without another LLM round-trip. The turn ends after this tool runs.',
    parameters: confirmActionParams,
    prepareArguments: (i) => prepareCommonUiArgs(i) as Static<typeof confirmActionParams>,
    async execute(toolCallId, params: Static<typeof confirmActionParams>) {
      const block: iConfirmBlock = {
        id: uuidv4(),
        type: 'confirm',
        title: params.action,
        description: params.details,
        severity: params.severity ?? 'warning',
        confirmLabel: params.confirmLabel ?? 'Confirm',
        cancelLabel: params.cancelLabel ?? 'Cancel',
        affectedItems: params.affectedItems,
        toolCallId,
        toolName: 'confirm_action',
        deferredAction: params.deferredAction,
      };
      await emitBlock(block, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Asked user to confirm: ${params.action}. Waiting for response.`,
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // present_content_confirmation
  // ==========================================================================
  const presentContentConfirmationParams = Type.Object({
    field: Type.String({ description: 'Display label, e.g. "Job Description · [title]"' }),
    before: Type.Optional(Type.String({ description: 'Original text (omit for new content)' })),
    after: Type.String({ description: 'Proposed new text' }),
    defaultTab: Type.Optional(
      Type.Union([Type.Literal('diff'), Type.Literal('before'), Type.Literal('after')]),
    ),
    confirmLabel: Type.Optional(Type.String()),
    cancelLabel: Type.Optional(Type.String()),
    deferredAction: deferredActionSchema,
  });

  const presentContentConfirmationTool: AgentTool<typeof presentContentConfirmationParams> = {
    name: 'present_content_confirmation',
    label: 'Present content confirmation',
    description:
      'Present content for user review. (1) New content: pass only `after`. (2) Diff mode: pass both `before` and `after`. Returns "applied"/"discarded" when the user acts. Always include a deferredAction so the save executes on approval. The turn ends after this tool runs.',
    parameters: presentContentConfirmationParams,
    prepareArguments: (i) => prepareCommonUiArgs(i) as Static<typeof presentContentConfirmationParams>,
    async execute(toolCallId, params: Static<typeof presentContentConfirmationParams>) {
      const block: iContentDiffBlock = {
        id: uuidv4(),
        type: 'content_diff',
        title: params.field,
        field: params.field,
        before: params.before,
        after: params.after,
        defaultTab: params.defaultTab,
        confirmLabel: params.confirmLabel,
        cancelLabel: params.cancelLabel,
        toolCallId,
        toolName: 'present_content_confirmation',
        deferredAction: params.deferredAction,
      };
      await emitBlock(block, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Presented content diff for "${params.field}" to user. Waiting for their response.`,
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // present_interview_questions
  // ==========================================================================
  const presentInterviewQuestionsParams = Type.Object({
    headerLabel: Type.String(),
    questions: Type.Array(
      Type.Object({
        id: Type.String(),
        text: Type.String(),
        source: Type.Union([Type.Literal('existing'), Type.Literal('ai')]),
        status: Type.Optional(
          Type.Union([Type.Literal('keep'), Type.Literal('removed')]),
        ),
        aiReason: Type.Optional(Type.String()),
      }),
    ),
    confirmLabel: Type.Optional(Type.String()),
    cancelLabel: Type.Optional(Type.String()),
    deferredAction: deferredActionSchema,
  });

  const presentInterviewQuestionsTool: AgentTool<typeof presentInterviewQuestionsParams> = {
    name: 'present_interview_questions',
    label: 'Present interview questions',
    description:
      'Show interview questions to the user in a review panel for confirmation. Only include questions you want to keep. Returns the confirmed question list when the user approves. The turn ends after this tool runs.',
    parameters: presentInterviewQuestionsParams,
    prepareArguments: (i) => prepareCommonUiArgs(i) as Static<typeof presentInterviewQuestionsParams>,
    async execute(toolCallId, params: Static<typeof presentInterviewQuestionsParams>) {
      const block: iInterviewQuestionsBlock = {
        id: uuidv4(),
        type: 'interview_questions',
        title: params.headerLabel,
        headerLabel: params.headerLabel,
        questions: params.questions.map((q) => ({
          id: q.id,
          text: q.text,
          source: q.source,
          status: q.status ?? 'keep',
          aiReason: q.aiReason,
        })),
        confirmLabel: params.confirmLabel ?? 'Confirm & Save',
        cancelLabel: params.cancelLabel ?? 'Cancel',
        toolCallId,
        toolName: 'present_interview_questions',
        deferredAction: params.deferredAction,
      };
      await emitBlock(block, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Presented interview questions for review. Waiting for user confirmation.',
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // show_simple_list
  // ==========================================================================
  const showSimpleListParams = Type.Object({
    title: Type.String(),
    description: Type.Optional(Type.String()),
    listStyle: Type.Union([
      Type.Literal('checkbox'),
      Type.Literal('numbered'),
      Type.Literal('plain'),
    ]),
    items: Type.Array(
      Type.Object({
        id: Type.String(),
        title: Type.String(),
        subtitle: Type.Optional(Type.String()),
        badge: Type.Optional(
          Type.Object({
            label: Type.String(),
            variant: Type.Optional(
              Type.Union(
                [
                  Type.Literal('green'),
                  Type.Literal('blue'),
                  Type.Literal('purple'),
                  Type.Literal('amber'),
                  Type.Literal('red'),
                  Type.Literal('gray'),
                  Type.Literal('neutral'),
                ],
                { description: 'Optional. Omit (or use "neutral") for non-semantic badges.' },
              ),
            ),
          }),
        ),
        meta: Type.Optional(Type.String()),
        highlightStat: Type.Optional(
          Type.Object({
            value: Type.Number(),
            label: Type.String(),
          }),
        ),
      }),
    ),
    actions: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          variant: Type.Optional(
            Type.Union([
              Type.Literal('primary'),
              Type.Literal('secondary'),
              Type.Literal('danger'),
            ]),
          ),
        }),
      ),
    ),
    deferredAction: deferredActionSchema,
  });

  const showSimpleListTool: AgentTool<typeof showSimpleListParams> = {
    name: 'show_simple_list',
    label: 'Show list',
    description:
      'Display items as an interactive list. Use `checkbox` for entity lists (with action buttons), `numbered` for ranked lists, `plain` for simple bullets. Always use this instead of plain text for multiple items. The turn ends after this tool runs.',
    parameters: showSimpleListParams,
    prepareArguments: (i) => prepareSimpleListArgs(i) as Static<typeof showSimpleListParams>,
    async execute(toolCallId, params: Static<typeof showSimpleListParams>) {
      const block: iSimpleListBlock = {
        id: uuidv4(),
        type: 'simple_list',
        title: params.title,
        description: params.description,
        listStyle: params.listStyle,
        items: params.items,
        actions: params.actions,
        toolCallId,
        toolName: 'show_simple_list',
        deferredAction: params.deferredAction,
      };
      await emitBlock(block, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Rendered ${params.items.length}-item list to user.`,
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // navigate_to
  //
  // Generic client-side navigation. Always emits a navigate uiBlock with a
  // clickable pill, regardless of `autoNavigate`. With `autoNavigate: true`
  // the frontend redirects AND leaves the pill in the transcript; with
  // `autoNavigate: false` the pill is the only outcome. This makes silent
  // navigation failures impossible by construction — the user always has a
  // manual path.
  //
  // NOTE: deliberately NOT in UI_TOOL_NAMES. Navigation is fire-and-forget —
  // there's no user click to wait for. The agent loop keeps running so the
  // LLM can write a success message in the same turn.
  // ==========================================================================
  const navigateToParams = Type.Object({
    page: Type.String({
      description:
        'Page id from the navigate skill sitemap, kebab-case. Examples: "jobs", "job-refine", "workflow-template-refine". Call read_skill("navigate") to see the full list.',
    }),
    params: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
        description:
          'URL params: { code: 5 } for entity pages, { code: 5, candidateCode: 12 } for candidate-in-job.',
      }),
    ),
    autoNavigate: Type.Optional(
      Type.Boolean({
        description:
          'true = redirect the user immediately. false = render only a clickable link in the chat. Default false.',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: 'Short label for the link, e.g. "Open workflow template #42".',
      }),
    ),
  });

  const navigateToTool: AgentTool<typeof navigateToParams> = {
    name: 'navigate_to',
    label: 'Navigate',
    description:
      'Navigate the user to a page in the app or render a clickable navigation link. ' +
      'Use `autoNavigate: true` when the user explicitly asked to GO somewhere ' +
      '("take me to", "open", "show me"). Use `autoNavigate: false` to offer a suggested link ' +
      'after answering a question. ' +
      '**For pages with :param placeholders (any *-refine, *-detail, job-* sub-page), the `params` ' +
      'field is REQUIRED — put the code there, NOT in `title`. `title` is display-only and does ' +
      'NOT fill URL placeholders. If this tool errors about missing params, call it again in the ' +
      'same turn with `params` filled in before writing any user-facing message.** ' +
      'Call `read_skill("navigate")` to see available page ids. Do not call this tool if the ' +
      'user is already on the target page (check the active entity in the system prompt).',
    parameters: navigateToParams,
    prepareArguments: (i) => prepareNavigateToArgs(i) as Static<typeof navigateToParams>,
    async execute(toolCallId, params: Static<typeof navigateToParams>) {
      const url = buildNavigationUrl(params.page, params.params);
      const autoNavigate = params.autoNavigate ?? false;
      const title = params.title ?? `Open ${url}`;

      const block: iNavigateBlock = {
        id: uuidv4(),
        type: 'navigate',
        title,
        url,
        autoNavigate,
        toolCallId,
        toolName: 'navigate_to',
      };
      await emitBlock(block, toolCallId);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Navigation link emitted: ${url} (autoNavigate=${autoNavigate}).`,
          },
        ],
        details: {},
      };
    },
  };

  // ==========================================================================
  // refresh_resource
  //
  // Silent side-channel signal: tells the user-facing UI to refetch a
  // resource the AI just mutated. Emits a `refreshResource` custom message
  // (declared in src/types/custom-messages.ts); the frontend handles it in
  // chat.store.ts → invalidateQueriesForResource. No transcript rendering.
  //
  // NOT in UI_TOOL_NAMES — fire-and-forget, agent loop keeps running so
  // the LLM can write a wrap-up message in the same turn (same pattern as
  // navigate_to).
  // ==========================================================================
  const refreshResourceParams = Type.Object({
    resource: Type.Union(
      [
        Type.Literal('interview'),
        Type.Literal('job'),
        Type.Literal('scorecard'),
        Type.Literal('email-template'),
        Type.Literal('workflow-template'),
        Type.Literal('job-description-template'),
      ],
      {
        description:
          'Resource kind the user-facing editor for this entity should refetch. Pick the kind that matches what you just mutated — "interview" covers both job-stage interviews and standalone interviews.',
      },
    ),
    id: Type.Optional(
      Type.String({
        description: 'UUID of the entity, if you have it from the tool result.',
      }),
    ),
    code: Type.Optional(
      Type.Number({
        description: 'Numeric code of the entity, if you have it from the tool result.',
      }),
    ),
  });

  const refreshResourceTool: AgentTool<typeof refreshResourceParams> = {
    name: 'refresh_resource',
    label: 'Refresh resource',
    description:
      'Tell the user-facing UI to refetch a resource you just modified. Call this immediately after a successful mutating tool (e.g. after `stage_interview_update`, `standalone_interview_update`, `scorecard_update`, …). Silent — no UI is rendered in chat; only the relevant editor on the user\'s page reloads its data. Pass `id` and/or `code` if you have them — pass either, both, or neither.',
    parameters: refreshResourceParams,
    async execute(_toolCallId, params: Static<typeof refreshResourceParams>) {
      await ctx.emitCustomMessage({
        role: 'refreshResource',
        resource: params.resource,
        id: params.id,
        code: params.code,
        timestamp: Date.now(),
      });
      return {
        content: [{ type: 'text' as const, text: `Refresh signaled: ${params.resource}.` }],
        details: {},
      };
    },
  };

  return [
    presentChoicesTool,
    confirmActionTool,
    presentContentConfirmationTool,
    presentInterviewQuestionsTool,
    showSimpleListTool,
    navigateToTool,
    refreshResourceTool,
  ];
}
