import type { OutgoingMessage } from "../message.js";

/** Transport-only rendering: no Problem/Task/Run semantics live here. */
export function renderFeishuText(message: OutgoingMessage): string {
  const parts: string[] = [];
  if (message.text) {
    parts.push(message.text);
  }
  for (const block of message.blocks ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "markdown":
        parts.push(block.text);
        break;
      case "code":
        parts.push(block.language ? `\`\`\`${block.language}\n${block.text}\n\`\`\`` : block.text);
        break;
      case "divider":
        parts.push("---");
        break;
      case "section":
        parts.push(block.title ? `${block.title}\n${block.text}` : block.text);
        break;
      case "actions":
        parts.push(block.actions.map((action) => `[${action.label}]`).join(" "));
        break;
    }
  }
  return parts.join("\n");
}

export interface FeishuCard {
  config: { wide_screen_mode: boolean };
  elements: Record<string, unknown>[];
}

/** Renders an OutgoingMessage into a generic card (markdown + dividers). */
export function renderFeishuCard(message: OutgoingMessage): FeishuCard {
  const elements: Record<string, unknown>[] = [];
  const markdown = (content: string): void => {
    if (content) {
      elements.push({ tag: "div", text: { tag: "lark_md", content } });
    }
  };

  markdown(message.text ?? "");
  for (const block of message.blocks ?? []) {
    switch (block.type) {
      case "text":
        markdown(block.text);
        break;
      case "markdown":
        markdown(block.text);
        break;
      case "code":
        markdown(block.language ? `\`\`\`${block.language}\n${block.text}\n\`\`\`` : block.text);
        break;
      case "divider":
        elements.push({ tag: "hr" });
        break;
      case "section":
        markdown(block.title ? `**${block.title}**\n${block.text}` : block.text);
        break;
      case "actions":
        elements.push({
          tag: "action",
          actions: block.actions.map((action) => ({
            tag: "button",
            text: { tag: "plain_text", content: action.label },
            type: action.style ?? "default",
            value: { action: action.id, value: action.value },
          })),
        });
        break;
    }
  }
  if (elements.length === 0) {
    markdown("(empty message)");
  }
  return { config: { wide_screen_mode: true }, elements };
}
