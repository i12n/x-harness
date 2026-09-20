import { describe, expect, it } from "vitest";
import {
  assertDistinctDatabases,
  databaseNameOf,
  describeDatabaseUrl,
  resolveTestDatabase,
} from "./helpers/testDatabases.js";

const BASE = "postgres://ai:secret@localhost:55432/ai_harness";

describe("test database isolation (TASK-1208 Step 1)", () => {
  it("prefers the suite-specific URL over DATABASE_URL", () => {
    const resolved = resolveTestDatabase({
      suite: "integration",
      requiredEnv: ["AI_TEST_POSTGRES"],
      env: {
        AI_TEST_POSTGRES: "1",
        DATABASE_URL: BASE,
        AI_TEST_DB_URL_INTEGRATION: "postgres://ai@localhost:55432/ai_harness_it",
      },
    });

    expect(resolved).toMatchObject({
      enabled: true,
      sharedFallback: false,
      databaseName: "ai_harness_it",
      warnings: [],
    });
  });

  it("falls back to DATABASE_URL and warns about the shared database", () => {
    const resolved = resolveTestDatabase({
      suite: "real",
      requiredEnv: ["AI_TEST_POSTGRES", "AI_TEST_CODEX"],
      env: {
        AI_TEST_POSTGRES: "1",
        AI_TEST_CODEX: "1",
        DATABASE_URL: BASE,
      },
    });

    expect(resolved).toMatchObject({
      enabled: true,
      sharedFallback: true,
      databaseName: "ai_harness",
    });
    expect(resolved.warnings[0]).toContain("shared DATABASE_URL");
    expect(resolved.warnings[0]).toContain("AI_TEST_DB_URL_REAL");
  });

  it("skips by default when the suite flags are absent", () => {
    const resolved = resolveTestDatabase({
      suite: "integration",
      requiredEnv: ["AI_TEST_POSTGRES"],
      env: { DATABASE_URL: BASE },
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.missingFlags).toEqual(["AI_TEST_POSTGRES"]);
    // No throw without AI_TEST_REQUIRE_DB: local/offline runs keep skipping.
    expect(resolved.warnings).toEqual([]);
  });

  it("fails hard when AI_TEST_REQUIRE_DB=1 and the environment is missing", () => {
    expect(() =>
      resolveTestDatabase({
        suite: "integration",
        requiredEnv: ["AI_TEST_POSTGRES"],
        env: { AI_TEST_REQUIRE_DB: "1", DATABASE_URL: BASE },
      }),
    ).toThrow(/AI_TEST_REQUIRE_DB=1.*AI_TEST_POSTGRES=1/s);

    expect(() =>
      resolveTestDatabase({
        suite: "real",
        requiredEnv: ["AI_TEST_POSTGRES", "AI_TEST_CODEX"],
        env: { AI_TEST_REQUIRE_DB: "1", AI_TEST_POSTGRES: "1", AI_TEST_CODEX: "1" },
      }),
    ).toThrow(/AI_TEST_DB_URL_REAL or DATABASE_URL/);
  });

  it("still enforces the DB requirement when only the URL is missing", () => {
    const resolved = resolveTestDatabase({
      suite: "real",
      requiredEnv: ["AI_TEST_POSTGRES", "AI_TEST_CODEX"],
      env: {
        AI_TEST_POSTGRES: "1",
        AI_TEST_CODEX: "1",
        AI_TEST_DB_URL_REAL: "postgres://ai@localhost:55432/ai_harness_e2e",
        AI_TEST_REQUIRE_DB: "1",
      },
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.databaseName).toBe("ai_harness_e2e");
  });

  it("detects two suites pointing at the same database", () => {
    const left = { suite: "integration" as const, url: BASE };
    const right = { suite: "real" as const, url: `${BASE}?sslmode=disable` };

    const warnings = assertDistinctDatabases(left, right);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("same database");
    expect(warnings[0]).toContain("must not run in parallel");

    expect(
      assertDistinctDatabases(left, {
        suite: "real",
        url: "postgres://ai@localhost:55432/ai_harness_e2e",
      }),
    ).toEqual([]);
    expect(assertDistinctDatabases(left, { suite: "real", url: undefined })).toEqual([]);
  });

  it("parses database names and never leaks credentials in reports", () => {
    expect(databaseNameOf(BASE)).toBe("ai_harness");
    expect(databaseNameOf("postgres://ai@localhost:55432/db?sslmode=require")).toBe("db");
    expect(databaseNameOf("postgres://ai@localhost:55432/")).toBeUndefined();
    expect(databaseNameOf("not-a-url")).toBeUndefined();

    const described = describeDatabaseUrl(BASE);
    expect(described).toBe("localhost:55432/ai_harness");
    expect(described).not.toContain("secret");
    expect(describeDatabaseUrl("not-a-url")).toBe("(unparseable database url)");
  });
});
