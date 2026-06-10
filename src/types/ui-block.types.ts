/**
 * UI Block Types
 * Interactive UI elements rendered in AI chat responses
 */

export type tUIBlockType = 'select_one' | 'action_buttons' | 'navigate' | 'summary_card' | 'confirm' | 'simple_list' | 'content_diff';

export interface iUIBlockOption {
  /** Machine-readable value (e.g., location code "3") */
  value: string;
  /** Human-readable label (e.g., "London Office") */
  label: string;
  /** Optional subtitle (e.g., "United Kingdom") */
  description?: string;
}

export interface iUIBlockAction {
  /** Action identifier (e.g., "add_description") */
  id: string;
  /** Button text */
  label: string;
  /** Button style variant */
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
}

interface iUIBlockBase {
  /** Generated UUID */
  id: string;
  type: tUIBlockType;
  /** Prompt shown to user (e.g., "Which location?") */
  title: string;
  description?: string;
  /** Whether user has already responded */
  resolved?: boolean;
  /** What the user selected */
  resolvedValue?: string;
  /** Links back to the OpenAI tool_call.id that created this block */
  toolCallId?: string;
  /** Which tool created this block (e.g., 'confirm_action', 'present_choices') */
  toolName?: string;
  /** Pre-computed action to execute on user approval, skipping the LLM round-trip */
  deferredAction?: { toolName: string; arguments: Record<string, unknown> };
}

export interface iSelectOneBlock extends iUIBlockBase {
  type: 'select_one';
  options: iUIBlockOption[];
}

export interface iActionButtonsBlock extends iUIBlockBase {
  type: 'action_buttons';
  actions: iUIBlockAction[];
}

/** Navigate block — triggers frontend navigation */
export interface iNavigateBlock extends iUIBlockBase {
  type: 'navigate';
  url: string;
  autoNavigate: boolean;
}

/** Summary card block — displays structured data inline */
export interface iSummaryCardBlock extends iUIBlockBase {
  type: 'summary_card';
  /** App-defined card kind — your frontend decides how each kind renders. */
  cardType: string;
  subtitle?: string;
  fields: Array<{ label: string; value: string; type: 'text' | 'badge' | 'score' | 'link' }>;
  actions?: iUIBlockAction[];
  /** App-defined entity reference your frontend can use for linking. */
  entityRef?: { type: string; code: number; parentCode?: number };
}

/** Confirm block — structured confirmation before actions */
export interface iConfirmBlock extends iUIBlockBase {
  type: 'confirm';
  severity: 'info' | 'warning' | 'destructive';
  confirmLabel: string;
  cancelLabel: string;
  affectedItems?: Array<{ label: string; description?: string }>;
}

/** Badge with color variant for simple list items. `variant` is optional — omit (or use 'neutral') for non-semantic labels. */
export interface iSimpleListBadge {
  label: string;
  variant?: 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'gray' | 'neutral';
}

/** Highlight stat displayed prominently on the item's trailing side (numeric values only) */
export interface iSimpleListHighlightStat {
  value: number;
  label: string;
}

/** A flat list item for the simple list block */
export interface iSimpleListItem {
  /** Unique identifier */
  id: string;
  /** Primary text (required) */
  title: string;
  /** Secondary text below title */
  subtitle?: string;
  /** Colored badge pill */
  badge?: iSimpleListBadge;
  /** Small meta text (e.g. date, location) */
  meta?: string;
  /** Prominent stat on the right side (e.g. "85%", "Match Score") */
  highlightStat?: iSimpleListHighlightStat;
}

/** Simple list block — displays items in checkbox, numbered, or plain style */
export interface iSimpleListBlock extends iUIBlockBase {
  type: 'simple_list';
  /** List presentation style */
  listStyle: 'checkbox' | 'numbered' | 'plain';
  /** The list items */
  items: iSimpleListItem[];
  /** Action buttons (shown as bulk actions in checkbox mode when items selected) */
  actions?: iUIBlockAction[];
}

/** Content diff block — visual before/after text diff with Apply/Discard, or new content preview with Create/Cancel */
export interface iContentDiffBlock extends iUIBlockBase {
  type: 'content_diff';
  /** Display label, e.g. "Job Description · Senior Product Designer" */
  field: string;
  /** Original/current text content. Empty or omitted for new content mode. */
  before?: string;
  /** Proposed new text content */
  after: string;
  /** Which tab to show by default */
  defaultTab?: 'diff' | 'before' | 'after';
  /** Custom label for the confirm button (e.g. "Create", "Apply") */
  confirmLabel?: string;
  /** Custom label for the cancel button (e.g. "Cancel", "Discard") */
  cancelLabel?: string;
}

export type tUIBlock = iSelectOneBlock | iActionButtonsBlock | iNavigateBlock | iSummaryCardBlock | iConfirmBlock | iSimpleListBlock | iContentDiffBlock;
