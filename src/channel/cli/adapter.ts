import type { Channel, IncomingHandler } from "../channel.js";
import type { IncomingMessage, MessageBlock, OutgoingMessage } from "../message.js";

export interface CliChannelOptions {
  /** Optional inbound handler (Conversation/Application wiring lands later). */
  onMessage?: IncomingHandler;
  /** Output sink; defaults to console.log (behavior-identical to the old CLI). */
  write?: (line: string) => void;
}

/**
 * CLI as the first Channel (TASK-1101). `send()` renders outgoing messages the
 * same way the CLI printed before, so existing behavior is unchanged; later
 * adapters (Feishu) reuse the same message model.
 */
export class CliChannel implements Channel {
  readonly id = "cli";
  private readonly handler: IncomingHandler | undefined;
  private readonly write: (line: string) => void;

  constructor(options: CliChannelOptions = {}) {
    this.handler = options.onMessage;
    this.write = options.write ?? ((line) => console.log(line));
  }

  async receive(message: IncomingMessage): Promise<void> {
    if (!this.handler) {
      return;
    }
    const reply = await this.handler(message);
    if (reply) {
      await this.send(reply);
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    for (const line of renderOutgoingMessage(message)) {
      this.write(line);
    }
  }
}

/** Renders an OutgoingMessage to plain text lines (testable, transport-free). */
export function renderOutgoingMessage(message: OutgoingMessage): string[] {
  const lines: string[] = [];
  if (message.text) {
    lines.push(message.text);
  }
  for (const block of message.blocks ?? []) {
    lines.push(...renderBlock(block));
  }
  return lines;
}

function renderBlock(block: MessageBlock): string[] {
  switch (block.type) {
    case "text":
    case "markdown":
      return [block.text];
    case "code":
      return block.language
        ? [`\`\`\`${block.language}`, block.text, "```"]
        : [block.text];
    case "divider":
      return ["---"];
    case "section":
      return block.title ? [block.title, block.text] : [block.text];
    case "actions":
      return [block.actions.map((action) => `[${action.label}]`).join(" ")];
    case "choice":
      return [
        [
          ...block.options.map(
            (option) =>
              `[${block.selected?.includes(option.id) ? "✅" : "⬜"} ${option.label}]`,
          ),
          ...(block.submit ? [`[${block.submit.label}]`] : []),
        ].join(" "),
      ];
    case "input":
      return [
        `[输入：${block.label ?? block.placeholder ?? block.name}]`,
        `[${block.submit.label}]`,
      ];
  }
}
