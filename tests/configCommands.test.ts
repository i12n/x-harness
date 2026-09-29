import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigCommandHandlers } from "../src/command/handlers/config.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import type { CommandResult, Role } from "../src/command/types.js";
import { createConfigAdminPort } from "../src/server/deployment/configPort.js";
import { parseEnvFile } from "../src/server/deployment/envFile.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

let dir: string;
let envFile: string;
let events: InMemoryEventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-configcmd-"));
  envFile = join(dir, "ai-harness.env");
  events = new InMemoryEventStore();
  writeFileSync(
    envFile,
    [
      "FEISHU_APP_ID=cli_abc",
      "FEISHU_APP_SECRET=super-secret",
      "FEISHU_ALLOWED_OPEN_IDS=ou_owner",
      "AI_MAX_CONCURRENCY=2",
      "AI_EXECUTION_DRIVER=docker",
    ].join("\n"),
    { mode: 0o600 },
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dispatcher() {
  const port = createConfigAdminPort({ envFile, env: { AI_ENV_FILE: envFile }, events });
  return new CommandDispatcher({
    handlers: createConfigCommandHandlers({ config: port }),
    idempotency: new InMemoryIdempotencyStore(),
  });
}

function command(type: string, payload: Record<string, unknown>, id = type) {
  return {
    id: `cmd-${id}`,
    type,
    version: 1,
    actor: { channel: "feishu", userId: "ou_admin" },
    conversation: { id: "conv-1" },
    payload,
    idempotencyKey: `feishu:om-${id}:${type}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function dispatch(type: string, payload: Record<string, unknown>, roles: Role[]) {
  return dispatcher().dispatch(command(type, payload), {
    channel: "feishu",
    userId: "ou_admin",
    roles,
  });
}

const textOf = (result: CommandResult): string =>
  JSON.stringify((result.data as { message?: unknown } | undefined)?.message ?? result.data ?? "");

describe("config command authorization", () => {
  it("is admin-only for all three commands", () => {
    for (const type of ["config.show", "config.set", "config.apply"] as const) {
      expect(COMMAND_SCHEMAS[type].roles).toEqual(["admin"]);
    }
  });

  it("rejects a developer", async () => {
    const result = await dispatch("config.show", {}, ["developer"]);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("unauthorized");
  });
});

describe("config.show", () => {
  it("lists configured values and never reveals secrets", async () => {
    const result = await dispatch("config.show", {}, ["admin"]);
    expect(result.status).toBe("succeeded");

    const entries = (result.data as { entries: { key: string; value?: string | null; isSecret: boolean }[] })
      .entries;
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("AI_MAX_CONCURRENCY")?.value).toBe("2");
    expect(byKey.get("FEISHU_APP_SECRET")?.value).toBeNull();
    expect(byKey.get("FEISHU_APP_SECRET")?.isSecret).toBe(true);
    expect(byKey.get("AI_LOOP_INTERVAL_MS")?.value).toBeUndefined();

    const rendered = textOf(result);
    expect(rendered).toContain("已设置");
    expect(rendered).toContain("设置 <KEY> <值>");
    expect(rendered).not.toContain("super-secret");
  });

  it("can narrow to one key and rejects an unknown one", async () => {
    const single = await dispatch("config.show", { key: "AI_MAX_CONCURRENCY" }, ["admin"]);
    expect(single.status).toBe("succeeded");
    expect((single.data as { entries: unknown[] }).entries).toHaveLength(1);

    const unknown = await dispatch("config.show", { key: "NOPE_KEY" }, ["admin"]);
    expect(unknown.status).toBe("rejected");
    expect(unknown.error?.code).toBe("unknown_config_key");
  });

  it("reports pending changes that need a restart", async () => {
    const result = await dispatch("config.show", {}, ["admin"]);
    // The file holds five keys; the injected process env holds none of them.
    expect((result.data as { pendingChanges: number }).pendingChanges).toBeGreaterThan(0);
  });
});

describe("config.set", () => {
  it("writes the env file and reports the diff", async () => {
    const result = await dispatch(
      "config.set",
      { key: "FEISHU_ALLOWED_OPEN_IDS", value: "ou_owner, ou_dev" },
      ["admin"],
    );
    expect(result.status).toBe("succeeded");
    expect(textOf(result)).toContain("已保存 FEISHU_ALLOWED_OPEN_IDS");
    // List values are normalized (trimmed, deduped) before they are stored.
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_ALLOWED_OPEN_IDS).toBe(
      "ou_owner,ou_dev",
    );
  });

  it("marks self-referential keys as risky", async () => {
    const risky = await dispatch("config.set", { key: "FEISHU_APP_ID", value: "cli_new" }, [
      "admin",
    ]);
    expect((risky.data as { risky: boolean }).risky).toBe(true);
    expect(textOf(risky)).toContain("只能上服务器");

    const safe = await dispatch("config.set", { key: "AI_MAX_CONCURRENCY", value: "1" }, [
      "admin",
    ]);
    expect((safe.data as { risky: boolean }).risky).toBe(false);
  });

  it("refuses secrets so they never land in chat history", async () => {
    const result = await dispatch(
      "config.set",
      { key: "FEISHU_APP_SECRET", value: "leaked-secret" },
      ["admin"],
    );
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("secret_not_accepted_in_chat");
    expect(readFileSync(envFile, "utf8")).not.toContain("leaked-secret");
  });

  it("validates the value before writing", async () => {
    const before = readFileSync(envFile, "utf8");
    const result = await dispatch("config.set", { key: "AI_MAX_CONCURRENCY", value: "0" }, [
      "admin",
    ]);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("invalid_config_value");
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("records an audit event without the actor being able to forge it", async () => {
    await dispatch("config.set", { key: "AI_MAX_CONCURRENCY", value: "3" }, ["admin"]);
    const recorded = await events.listEvents({ type: "config.changed" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      key: "AI_MAX_CONCURRENCY",
      previous: "2",
      value: "3",
      actor: "feishu:ou_admin",
    });
  });
});

describe("config.apply", () => {
  it("reports the number of pending changes and audits the request", async () => {
    const result = await dispatch("config.apply", {}, ["admin"]);
    expect(result.status).toBe("succeeded");
    expect((result.data as { pending: number }).pending).toBeGreaterThan(0);
    expect(textOf(result)).toContain("重启");
    expect(await events.listEvents({ type: "config.apply_requested" })).toHaveLength(1);
  });
});

describe("access commands", () => {
  it("merges a new user into the allow-list instead of overwriting it", async () => {
    const result = await dispatch(
      "access.grant",
      { openId: "ou_dev1234", role: "developer" },
      ["admin"],
    );
    expect(result.status).toBe("succeeded");
    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    expect(values.FEISHU_ALLOWED_OPEN_IDS).toBe("ou_owner,ou_dev1234");
    expect(values.FEISHU_ROLE_MAP).toBe("ou_dev1234=developer");
    expect(textOf(result)).toContain("ou_owner");
  });

  it("normalizes the ':' separator models like to emit", async () => {
    await dispatch("access.grant", { openId: "ou_dev1234" }, ["admin"]);
    const direct = await dispatch(
      "config.set",
      { key: "FEISHU_ROLE_MAP", value: "ou_dev1234:reviewer" },
      ["admin"],
    );
    expect(direct.status).toBe("succeeded");
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_ROLE_MAP).toBe(
      "ou_dev1234=reviewer",
    );
  });

  it("refuses to shrink a list from chat", async () => {
    const result = await dispatch(
      "config.set",
      { key: "FEISHU_ALLOWED_OPEN_IDS", value: "ou_someone_else" },
      ["admin"],
    );
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("config_list_shrink_refused");
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_ALLOWED_OPEN_IDS).toBe(
      "ou_owner",
    );
  });

  it("revokes one user, and protects the last one", async () => {
    await dispatch("access.grant", { openId: "ou_dev1234", role: "developer" }, ["admin"]);

    const revoked = await dispatch("access.revoke", { openId: "ou_dev1234" }, ["admin"]);
    expect(revoked.status).toBe("succeeded");
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_ALLOWED_OPEN_IDS).toBe(
      "ou_owner",
    );

    const last = await dispatch("access.revoke", { openId: "ou_owner" }, ["admin"]);
    expect(last.status).toBe("rejected");
    expect(last.error?.code).toBe("last_admin_protected");
    expect(parseEnvFile(readFileSync(envFile, "utf8")).FEISHU_ALLOWED_OPEN_IDS).toBe(
      "ou_owner",
    );
  });

  it("rejects a malformed open_id", async () => {
    const result = await dispatch("access.grant", { openId: "张三" }, ["admin"]);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("invalid_open_id");
  });

  it("audits grants and revocations", async () => {
    await dispatch("access.grant", { openId: "ou_dev1234", role: "developer" }, ["admin"]);
    await dispatch("access.revoke", { openId: "ou_dev1234" }, ["admin"]);
    expect(await events.listEvents({ type: "access.granted" })).toHaveLength(1);
    expect(await events.listEvents({ type: "access.revoked" })).toHaveLength(1);
  });
});
