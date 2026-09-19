/**
 * Thrown by command handlers when the Harness (not the LLM) rejects the
 * request on domain grounds, e.g. required clarifications still open.
 */
export class CommandRejectionError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CommandRejectionError";
    this.code = code;
    this.details = details;
  }
}
