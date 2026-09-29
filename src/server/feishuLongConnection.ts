import { FEISHU_MESSAGE_EVENT } from "../channel/feishu/events.js";

export interface FeishuLongConnectionOptions {
  appId: string;
  appSecret: string;
  /** Receives an `im.message.receive_v1` envelope, already JSON-shaped. */
  onEvent: (envelope: Record<string, unknown>) => Promise<void> | void;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

interface LarkWsClientLike {
  start(options: { eventDispatcher: unknown }): Promise<unknown>;
  close(options?: { force?: boolean }): void;
}

/**
 * Feishu event subscription over a WebSocket long connection.
 *
 * Long connection mode needs no public callback URL, no reverse proxy and no
 * inbound port — the app dials out to Feishu, which keeps the deployment on a
 * box that already serves other (unrelated) production services untouched.
 * The connection is authenticated with the app credentials, so incoming events
 * are trusted without the webhook signature dance (that path still exists for
 * HTTP callbacks).
 */
export class FeishuLongConnection {
  private client: LarkWsClientLike | undefined;
  private stopping = false;

  constructor(private readonly options: FeishuLongConnectionOptions) {}

  async start(): Promise<void> {
    if (this.client) {
      return;
    }
    const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkModuleLike;
    const dispatcher = new lark.EventDispatcher({}).register({
      [FEISHU_MESSAGE_EVENT]: async (data: unknown) => {
        if (this.stopping) {
          return;
        }
        try {
          await this.options.onEvent({
            schema: "2.0",
            header: { event_type: FEISHU_MESSAGE_EVENT },
            event: data as Record<string, unknown>,
          });
        } catch (error) {
          this.options.errorLog?.(
            `event handler failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
    const client = new lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: lark.LoggerLevel?.info,
    });
    this.client = client as unknown as LarkWsClientLike;
    this.options.log?.("establishing Feishu long connection…");
    await this.client.start({ eventDispatcher: dispatcher });
    this.options.log?.("Feishu long connection established");
  }

  stop(): void {
    this.stopping = true;
    try {
      this.client?.close({ force: true });
    } catch {
      // Closing a dead socket is not an error worth surfacing.
    }
    this.client = undefined;
  }
}

/** Structural typing for the pieces of the SDK we use (kept import-free). */
interface LarkModuleLike {
  WSClient: new (options: {
    appId: string;
    appSecret: string;
    loggerLevel?: unknown;
  }) => unknown;
  EventDispatcher: new (options: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => Promise<void> | void>): unknown;
  };
  LoggerLevel?: { info?: unknown };
}
