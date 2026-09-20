/**
 * TASK-1208 Step 1: per-suite PostgreSQL databases.
 *
 * The two DB-backed suites used to share `DATABASE_URL` and both truncated the
 * same tables, so running them together deleted each other's data. Each suite
 * now resolves its own database:
 *
 *   integration → AI_TEST_DB_URL_INTEGRATION ?? DATABASE_URL
 *   real        → AI_TEST_DB_URL_REAL         ?? DATABASE_URL
 *
 * Without the dedicated variables the behavior is exactly the old one (single
 * suite, shared database) — the gate runner creates and migrates two separate
 * databases and injects both variables.
 *
 * `AI_TEST_REQUIRE_DB=1` turns "environment missing" into a hard failure so a
 * release gate can never pass because a suite silently skipped.
 */

export type TestDatabaseSuite = "integration" | "real";

export interface ResolvedTestDatabase {
  suite: TestDatabaseSuite;
  /** The URL to connect with (undefined when nothing was configured). */
  url?: string;
  /** Database name parsed from the URL (for reports), if available. */
  databaseName?: string;
  /** True when the suite should run instead of skipping. */
  enabled: boolean;
  /** True when the URL came from the shared DATABASE_URL fallback. */
  sharedFallback: boolean;
  /** Environment variables this suite requires to be "1". */
  missingFlags: string[];
  /** Human-readable notes to surface in the suite/gate log. */
  warnings: string[];
}

export interface ResolveTestDatabaseOptions {
  suite: TestDatabaseSuite;
  /** Env flags that must be "1" for this suite to run (e.g. AI_TEST_POSTGRES). */
  requiredEnv?: string[];
  env?: NodeJS.ProcessEnv;
}

const SUITE_URL_VARIABLES: Record<TestDatabaseSuite, string> = {
  integration: "AI_TEST_DB_URL_INTEGRATION",
  real: "AI_TEST_DB_URL_REAL",
};

export function resolveTestDatabase(
  options: ResolveTestDatabaseOptions,
): ResolvedTestDatabase {
  const env = options.env ?? process.env;
  const requiredEnv = options.requiredEnv ?? [];
  const urlVariable = SUITE_URL_VARIABLES[options.suite];
  const dedicated = trimmed(env[urlVariable]);
  const shared = trimmed(env.DATABASE_URL);
  const url = dedicated ?? shared;
  const missingFlags = requiredEnv.filter((name) => env[name] !== "1");
  const requireDb = env.AI_TEST_REQUIRE_DB === "1";
  const enabled = missingFlags.length === 0 && Boolean(url);

  if (requireDb && !enabled) {
    const missing = [
      ...missingFlags.map((name) => `${name}=1`),
      ...(url ? [] : [`${urlVariable} or DATABASE_URL`]),
    ];
    throw new Error(
      `AI_TEST_REQUIRE_DB=1 but the ${options.suite} test database is not configured ` +
        `(missing: ${missing.join(", ")}). This suite may not be skipped in a release gate.`,
    );
  }

  const warnings: string[] = [];
  const sharedFallback = Boolean(url) && dedicated === undefined;
  if (sharedFallback && enabled) {
    warnings.push(
      `${options.suite} suite is using the shared DATABASE_URL (${databaseNameOf(url) ?? "?"}); ` +
        `set ${urlVariable} to run DB suites in parallel`,
    );
  }

  return {
    suite: options.suite,
    url,
    databaseName: databaseNameOf(url),
    enabled,
    sharedFallback,
    missingFlags,
    warnings,
  };
}

/**
 * Warns when two suites resolve to the same database: they truncate the same
 * tables and therefore must not run concurrently.
 */
export function assertDistinctDatabases(
  left: Pick<ResolvedTestDatabase, "suite" | "url">,
  right: Pick<ResolvedTestDatabase, "suite" | "url">,
): string[] {
  if (!left.url || !right.url) {
    return [];
  }
  if (normalizeUrl(left.url) !== normalizeUrl(right.url)) {
    return [];
  }
  return [
    `${left.suite} and ${right.suite} suites resolve to the same database ` +
      `(${databaseNameOf(left.url) ?? "?"}); they truncate the same tables and ` +
      "must not run in parallel",
  ];
}

/** Fails fast with a clear message instead of a wall of pg connection errors. */
export async function checkDatabaseReachable(
  db: { query: (sql: string) => Promise<unknown> },
  label: string,
): Promise<void> {
  try {
    await db.query("SELECT 1");
  } catch (error) {
    throw new Error(
      `${label} test database is unreachable: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** `postgres://user:secret@host:5432/db?sslmode=require` → `host:5432/db`. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "(unparseable database url)";
  }
}

export function databaseNameOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrl(url: string): string {
  return describeDatabaseUrl(url);
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}
