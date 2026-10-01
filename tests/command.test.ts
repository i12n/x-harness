import { describe, expect, it } from "vitest";
import {
  CommandDispatcher,
  COMMAND_SCHEMAS,
  COMMAND_TYPES,
  CommandValidationError,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  validateCommand,
  type AuthorizationContext,
  type IntentEngine,
  type IntentInput,
  type Role,
} from "../src/command/index.js";

function context(roles: Role[], userId = "ou_user_1"): AuthorizationContext {
  return { channel: "feishu", userId, roles };
}

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cmd-001",
    type: "task.show",
    version: 1,
    actor: { channel: "feishu", userId: "ou_user_1" },
    conversation: { id: "conv-001" },
    payload: { taskId: "TASK-001" },
    idempotencyKey: "feishu:message-001:task.show",
    ...overrides,
  };
}

function message(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    channel: "feishu",
    conversationId: "conv-001",
    messageId: "message-001",
    senderId: "ou_user_1",
    text: "显示 TASK-001",
    ...overrides,
  };
}

describe("Command catalog and validation (TASK-1106)", () => {
  it("defines a schema with roles for every command type", () => {
    for (const type of COMMAND_TYPES) {
      expect(COMMAND_SCHEMAS[type], type).toBeDefined();
      expect(COMMAND_SCHEMAS[type].roles.length, type).toBeGreaterThan(0);
    }
  });

  it("rejects unknown commands, bad payloads, missing fields and versions", async () => {
    const dispatcher = new CommandDispatcher({ handlers: {} });

    await expect(
      dispatcher.dispatch({ ...command(), type: "docker.exec" }, context(["admin"])),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "unsupported_command" },
    });

    await expect(
      dispatcher.dispatch({ ...command(), payload: { taskId: 123 } }, context(["admin"])),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_field_type" },
    });

    await expect(
      dispatcher.dispatch(
        { ...command(), type: "task.run", payload: {} },
        context(["admin"]),
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "missing_field" } });

    await expect(
      dispatcher.dispatch({ ...command(), version: 2 }, context(["admin"])),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "unsupported_version" },
    });

    await expect(
      dispatcher.dispatch(
        { ...command(), payload: { taskId: "TASK-001", store: "repositories" } },
        context(["admin"]),
      ),
      ).resolves.toMatchObject({ status: "rejected", error: { code: "unknown_field" } });
  });

  it("accepts string[] fields only as trimmed non-empty lists (TASK-1210)", () => {
    const parsed = validateCommand({
      ...command(),
      type: "spec.create",
      payload: {
        problemId: "prob-001",
        acceptance: ["  可以打开专辑页  ", "可以播放曲目"],
      },
      idempotencyKey: "feishu:message-001:spec.create",
    });
    expect(parsed.payload).toEqual({
      problemId: "prob-001",
      acceptance: ["可以打开专辑页", "可以播放曲目"],
    });

    const badValues: unknown[] = ["字符串", 7, null, [["嵌套"]], ["可以打开专辑页", "   "]];
    for (const bad of badValues) {
      expect(() =>
        validateCommand({
          ...command(),
          type: "spec.create",
          payload: { problemId: "prob-001", acceptance: bad },
          idempotencyKey: "feishu:message-001:spec.create",
        }),
      ).toThrow(CommandValidationError);
    }
  });

  it("normalizes a valid command and keeps only schema fields", () => {
    const parsed = validateCommand(command());
    expect(parsed).toMatchObject({
      id: "cmd-001",
      type: "task.show",
      version: 1,
      actor: { channel: "feishu", userId: "ou_user_1" },
      payload: { taskId: "TASK-001" },
    });
    expect(() =>
      validateCommand({ ...command(), idempotencyKey: "" }),
    ).toThrow(CommandValidationError);
  });
});

describe("Authorization (TASK-1106)", () => {
  function dispatcherWithSpy() {
    const calls: string[] = [];
    const dispatcher = new CommandDispatcher({
      handlers: {
        "task.show": () => {
          calls.push("task.show");
          return { ok: true };
        },
        "task.run": () => {
          calls.push("task.run");
          return { runId: "RUN-001" };
        },
        "review.approve": () => {
          calls.push("review.approve");
          return { approved: true };
        },
      },
    });
    return { dispatcher, calls };
  }

  it("allows permitted roles", async () => {
    const { dispatcher, calls } = dispatcherWithSpy();
    await expect(dispatcher.dispatch(command(), context(["guest"]))).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      dispatcher.dispatch(
        {
          ...command(),
          type: "review.approve",
          payload: { taskId: "TASK-001" },
          idempotencyKey: "k-approve",
        },
        context(["reviewer"]),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toEqual(["task.show", "review.approve"]);
  });

  it("rejects disallowed roles without invoking the handler", async () => {
    const { dispatcher, calls } = dispatcherWithSpy();

    const result = await dispatcher.dispatch(
      {
        ...command(),
        type: "task.run",
        payload: { taskId: "TASK-001" },
        idempotencyKey: "k-run",
      },
      context(["guest"]),
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "unauthorized" },
    });
    expect(result.error?.message).toContain("requires one of");
    expect(calls).toEqual([]);
  });
});

describe("Command idempotency (TASK-1106)", () => {
  it("executes once and replays the first result", async () => {
    let calls = 0;
    const dispatcher = new CommandDispatcher({
      idempotency: new InMemoryIdempotencyStore(),
      handlers: {
        "task.run": () => {
          calls += 1;
          return { runId: `RUN-00${calls}` };
        },
      },
    });
    const runCommand = {
      ...command(),
      type: "task.run",
      payload: { taskId: "TASK-001" },
      idempotencyKey: "feishu:message-123:task.run",
    };

    const first = await dispatcher.dispatch(runCommand, context(["developer"]));
    const retry = await dispatcher.dispatch(runCommand, context(["developer"]));

    expect(first).toMatchObject({ status: "succeeded", data: { runId: "RUN-001" } });
    expect(retry).toMatchObject({
      status: "succeeded",
      data: { runId: "RUN-001" },
      replayed: true,
    });
    expect(calls).toBe(1);
  });

  it("does not double-execute review.approve on retries", async () => {
    let approvals = 0;
    const dispatcher = new CommandDispatcher({
      idempotency: new InMemoryIdempotencyStore(),
      handlers: {
        "review.approve": () => {
          approvals += 1;
          return { taskId: "TASK-001", status: "DONE" };
        },
      },
    });
    const approve = {
      ...command(),
      type: "review.approve",
      payload: { taskId: "TASK-001" },
      idempotencyKey: "feishu:message-9:review.approve",
    };

    await dispatcher.dispatch(approve, context(["reviewer"]));
    const second = await dispatcher.dispatch(approve, context(["reviewer"]));

    expect(approvals).toBe(1);
    expect(second.replayed).toBe(true);
  });
});

describe("Command dispatcher routing (TASK-1106)", () => {
  it("only routes to explicitly configured handlers", async () => {
    const dispatcher = new CommandDispatcher({ handlers: {} });
    const result = await dispatcher.dispatch(command(), context(["admin"]));
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "handler_not_configured" },
    });
  });

  it("never invokes internal methods named by the payload", async () => {
    const called: string[] = [];
    const application = {
      dropDatabase: () => called.push("dropDatabase"),
    };
    const dispatcher = new CommandDispatcher({
      handlers: {
        "task.show": (payload) => {
          void application;
          return { taskId: payload.taskId };
        },
      },
    });

    const result = await dispatcher.dispatch(
      { ...command(), payload: { taskId: "TASK-001", method: "dropDatabase" } },
      context(["admin"]),
    );

    expect(result.status).toBe("rejected");
    expect(called).toEqual([]);
  });

  it("converts handler exceptions into CommandResult failures", async () => {
    const dispatcher = new CommandDispatcher({
      handlers: {
        "task.show": () => {
          throw new Error("task storage unavailable");
        },
      },
    });

    await expect(dispatcher.dispatch(command(), context(["guest"]))).resolves.toMatchObject({
      status: "failed",
      error: { code: "handler_error", message: "task storage unavailable" },
    });
  });
});

describe("Intent engine and pipeline (TASK-1106)", () => {
  it("runs IncomingMessage → Intent → Command → Dispatcher", async () => {
    const received: Record<string, unknown>[] = [];
    const dispatcher = new CommandDispatcher({
      handlers: {
        "task.show": (payload, cmd) => {
          received.push({ payload, actor: cmd.actor, idempotencyKey: cmd.idempotencyKey });
          return { taskId: payload.taskId };
        },
      },
    });
    const engine = new ScriptedIntentEngine({
      command: { type: "task.show", payload: { taskId: "TASK-001" } },
    });

    const result = await handleIntent(message(), context(["guest"]), {
      engine,
      dispatcher,
    });

    expect(result).toMatchObject({ status: "succeeded", data: { taskId: "TASK-001" } });
    expect(received[0]).toMatchObject({
      payload: { taskId: "TASK-001" },
      actor: { channel: "feishu", userId: "ou_user_1" },
      idempotencyKey: "feishu:message-001:task.show",
    });
  });

  it("ignores actor/conversation spoofing attempted by the engine", async () => {
    let seenActor: unknown;
    const dispatcher = new CommandDispatcher({
      handlers: {
        "task.show": (_payload, cmd) => {
          seenActor = cmd.actor;
          return {};
        },
      },
    });
    const engine = new ScriptedIntentEngine({
      command: {
        type: "task.show",
        payload: { taskId: "TASK-001" },
        actor: { channel: "slack", userId: "spoofed" },
        conversation: { id: "spoofed-conv" },
        idempotencyKey: "spoofed",
      },
    });

    await handleIntent(message(), context(["guest"]), { engine, dispatcher });

    expect(seenActor).toEqual({ channel: "feishu", userId: "ou_user_1" });
  });

  it("cannot bypass authorization through the engine", async () => {
    let approvals = 0;
    const dispatcher = new CommandDispatcher({
      handlers: {
        "review.approve": () => {
          approvals += 1;
          return { approved: true };
        },
      },
    });
    const engine = new ScriptedIntentEngine({
      command: { type: "review.approve", payload: { taskId: "TASK-001" } },
    });

    const result = await handleIntent(message(), context(["guest"]), {
      engine,
      dispatcher,
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "unauthorized" },
    });
    expect(approvals).toBe(0);
  });

  it("rejects malformed intents safely", async () => {
    const dispatcher = new CommandDispatcher({
      handlers: { "task.show": () => ({}) },
    });

    const notAnObject = await handleIntent(
      message(),
      context(["guest"]),
      { engine: new ScriptedIntentEngine({ command: "task.show" }), dispatcher },
    );
    expect(notAnObject).toMatchObject({
      status: "rejected",
      error: { code: "unsupported_command" },
    });

    const missingPayload = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({ command: { type: "task.show" } }),
        dispatcher,
      },
    );
    expect(missingPayload).toMatchObject({
      status: "rejected",
      error: { code: "missing_field" },
    });
  });

  it("accepts any IntentEngine implementation without changing the dispatcher", async () => {
    class StaticEngine implements IntentEngine {
      async parse(): Promise<{ command: unknown }> {
        return { command: { type: "task.show", payload: { taskId: "TASK-42" } } };
      }
    }
    const dispatcher = new CommandDispatcher({
      handlers: { "task.show": (payload) => ({ taskId: payload.taskId }) },
    });

    const result = await handleIntent(message(), context(["guest"]), {
      engine: new StaticEngine(),
      dispatcher,
    });

    expect(result).toMatchObject({ status: "succeeded", data: { taskId: "TASK-42" } });
  });

  it("supports queued scripted intents", async () => {
    const engine = new ScriptedIntentEngine([
      { command: { type: "task.show", payload: { taskId: "TASK-1" } } },
      { command: { type: "run.show", payload: { runId: "RUN-1" } } },
    ]);

    expect((await engine.parse(message())).command).toMatchObject({ type: "task.show" });
    expect((await engine.parse(message())).command).toMatchObject({ type: "run.show" });
  });
});
