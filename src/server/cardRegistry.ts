import type { MessageBlock, OutgoingMessage } from "../channel/message.js";
import type { ChatTarget } from "./notifications.js";

export interface RegisteredCard {
  messageId: string;
  target: ChatTarget;
  message: OutgoingMessage;
}

/**
 * TASK-1216: remembers the interactive cards we sent, so a toggle click can
 * re-render the card with the new selection and a submit click can be routed
 * back to the chat that owns it.
 *
 * This is presentation state, not conversation state: losing it (restart)
 * costs at most one re-render. The map is bounded so a long-lived bot cannot
 * grow without limit.
 */
export class CardRegistry {
  private readonly cards = new Map<string, RegisteredCard>();
  private readonly selections = new Map<string, string[]>();

  constructor(private readonly limit = 200) {}

  /** Registers only cards that actually carry a selectable group. */
  register(messageId: string, target: ChatTarget, message: OutgoingMessage): void {
    if (!messageId || !hasChoice(message)) {
      return;
    }
    this.cards.set(messageId, { messageId, target, message });
    while (this.cards.size > this.limit) {
      const oldest = this.cards.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cards.delete(oldest);
      for (const key of this.selections.keys()) {
        if (key.startsWith(`${oldest}:`)) {
          this.selections.delete(key);
        }
      }
    }
  }

  find(messageId: string): RegisteredCard | undefined {
    return this.cards.get(messageId);
  }

  selection(messageId: string, groupId: string): string[] {
    return this.selections.get(selectionKey(messageId, groupId)) ?? [];
  }

  /** Flips one option; returns the group's new selection. */
  toggle(
    messageId: string,
    groupId: string,
    optionId: string,
    multi: boolean,
  ): string[] {
    const current = this.selection(messageId, groupId);
    const next = multi
      ? current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      : current.includes(optionId)
        ? []
        : [optionId];
    this.selections.set(selectionKey(messageId, groupId), next);
    return next;
  }

  /** The registered card with every `choice` block's selection filled in. */
  selectedMessage(messageId: string): OutgoingMessage | undefined {
    const card = this.cards.get(messageId);
    if (!card) {
      return undefined;
    }
    return {
      ...card.message,
      blocks: (card.message.blocks ?? []).map((block) =>
        block.type === "choice"
          ? { ...block, selected: this.selection(messageId, block.id) }
          : block,
      ),
    };
  }

  forget(messageId: string): void {
    this.cards.delete(messageId);
  }
}

export function hasChoice(message: OutgoingMessage): boolean {
  return (message.blocks ?? []).some((block: MessageBlock) => block.type === "choice");
}

function selectionKey(messageId: string, groupId: string): string {
  return `${messageId}:${groupId}`;
}
