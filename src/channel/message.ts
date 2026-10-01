/** Channel-agnostic message models (Phase 11 / TASK-1101). */

export interface IncomingMessage {
  /** Channel id, e.g. "cli" or "feishu". */
  channel: string;
  conversationId: string;
  messageId: string;
  senderId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface MessageAction {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  value?: string;
}

export interface MessageChoiceOption {
  id: string;
  label: string;
}

/**
 * Interactive "pick one or several, then submit" group (TASK-1216).
 *
 * The transport renders every option as a toggle button plus one submit
 * button. Clicking an option toggles it and re-renders the card (so the
 * selection is always visible); the submit button carries the whole selection
 * in a single callback, so several options are committed atomically.
 */
export interface MessageChoice {
  type: "choice";
  /** Stable group id, unique inside one card. */
  id: string;
  title?: string;
  options: MessageChoiceOption[];
  /** true = several options may be selected and submitted together. */
  multi: boolean;
  /** Current selection; filled in every time the card is (re-)rendered. */
  selected?: string[];
  submit: {
    /** Command type dispatched when the user presses submit. */
    action: string;
    label: string;
    /** Extra command payload fields merged with the selected option ids. */
    payload?: Record<string, unknown>;
    /**
     * Payload field the selected option ids are written to. Defaults to
     * `optionIds`; a batch action that wants `taskIds` sets it explicitly.
     */
    selectionField?: string;
  };
}

/** Internal card action: toggle one option of a {@link MessageChoice}. */
export const CARD_CHOICE_TOGGLE = "card.choice.toggle";

/** Transport-agnostic presentation blocks shared by all renderers. */
export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "divider" }
  | { type: "section"; title?: string; text: string }
  | { type: "actions"; actions: MessageAction[] }
  | MessageChoice;

export interface OutgoingMessage {
  conversationId: string;
  text?: string;
  blocks?: MessageBlock[];
  metadata?: Record<string, unknown>;
}
