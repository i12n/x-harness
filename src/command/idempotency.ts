import type { CommandResult } from "./types.js";

/** TASK-1106: command-level idempotency (separate from message dedupe). */
export interface IdempotencyStore {
  get(key: string): Promise<CommandResult | undefined>;
  set(key: string, result: CommandResult): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly results = new Map<string, CommandResult>();

  async get(key: string): Promise<CommandResult | undefined> {
    return this.results.get(key);
  }

  async set(key: string, result: CommandResult): Promise<void> {
    this.results.set(key, result);
  }
}
