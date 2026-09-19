import type { IncomingMessage, OutgoingMessage } from "./message.js";

/**
 * A Channel is transport only: it moves messages in and out. It must not know
 * about Problem / Task / Run / Review semantics (those live in the Harness
 * Application layer and are reached through Conversation → Command).
 */
export interface Channel {
  readonly id: string;

  /** Inbound: the transport delivers a message to the harness. */
  receive(message: IncomingMessage): Promise<void>;

  /** Outbound: the harness sends a message back to the transport. */
  send(message: OutgoingMessage): Promise<void>;
}

export type IncomingHandler = (
  message: IncomingMessage,
) => Promise<OutgoingMessage | undefined> | OutgoingMessage | undefined;
