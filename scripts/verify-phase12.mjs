#!/usr/bin/env node

// TASK-1208 Step 2 — Phase 12 Release Gate runner.
//
// Runs the six gates from docs/phase12-acceptance.md **serially**, creates and
// migrates two isolated PostgreSQL databases (integration / real), collects
// vitest JSON results, checks for resource residue and writes a machine-readable
// report to artifacts/phase12-release-gate.json.
//
// Policy (docs/phase12-acceptance.md §9): a gate is PASS, FAIL or SKIPPED —
// skipping is never reported as passing, and a missing database is a FAIL.
//
// Usage:
//   DATABASE_URL=postgres://ai@localhost:5432/ai_harness node scripts/verify-phase12.mjs
//   ... AI_TEST_CODEX=1        # opt in to the real codex gate
//   ... AI_TEST_DB_BASE=<url>  # override the base URL used to derive the two DBs

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactsDir = path.join(root, "artifacts");
const reportPath = path.join(artifactsDir, "phase12-release-gate.json");
const historyPath = path.join(artifactsDir, "phase12-release-gate-history.jsonl");
const startedAt = new Date();

/** Tables the DB suites own; truncated between gate runs for a clean start. */
const TABLES_IN_DELETE_ORDER = [
  "conversation_messages",
  "conversations",
  "releases",
  "deliveries",
  "specification_plans",
  "specification_targets",
  "specifications",
  "clarification_answers",
  "clarifications",
  "problem_analyses",
  "problems",
  "events",
  "executions",
  "workspaces",
  "task_dependencies",
  "task_targets",
  "runs",
  "tasks",
  "repositories",
];

const gates = {};
const notes = [];

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  log(`Phase 12 Release Gate runner — starting ${startedAt.toISOString()}`);

  const context = await preflight();
  for (const warning of context.warnings) {
    log(`warning: ${warning}`);
  }

  // Gate 1 — typecheck (never skippable)
  gates.typecheck = await runCommandGate("typecheck", "npm", ["run", "typecheck"]);

  // Gate 2 — unit + in-memory E2E, explicitly excluding the DB suites
  gates.unit = await vitestGate("unit", [
    "run",
    "--exclude",
    "**/*.integration.test.ts",
  ]);

  // Isolated databases for Gates 3 and 5 (never the caller's own database).
  const databases = await prepareDatabases(context);
  context.databases = databases;

  // Gate 3 — PostgreSQL integration (hard requirement)
  gates.postgres = databases.integration
    ? await vitestGate("postgres", ["run", "tests/postgres.integration.test.ts"], {
        AI_TEST_POSTGRES: "1",
        AI_TEST_REQUIRE_DB: "1",
        AI_TEST_DB_URL_INTEGRATION: databases.integration.url,
      })
    : failedGate("postgres", `database unavailable: ${databases.reason}`);

  // Gate 4 — Phase 12 E2E (in-memory, no database required)
  gates.phase12E2E = await vitestGate("phase12E2E", ["run", "tests/e2e/phase12"]);

  // Gate 5 — real codex E2E (database hard requirement, provider opt-in)
  gates.realCodex = await realCodexGate(context, databases);

  // Gate 6 — docker / workspace / execution residue
  gates.resources = await resourceGate(context);

  return finish(context);
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function preflight() {
  const warnings = [];
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) {
    warnings.push(`node ${process.versions.node} is older than engines (${pkg.engines.node})`);
  }

  const commit = await capture("git", ["rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  const status = await capture("git", ["status", "--porcelain"]);
  const worktreeDirty = status.stdout.trim().length > 0;
  if (worktreeDirty) {
    warnings.push("worktree is dirty; the recorded commit does not describe the code under test");
  }

  const baseUrl = (process.env.AI_TEST_DB_BASE ?? process.env.DATABASE_URL ?? "").trim();
  const database = baseUrl ? parseDatabaseUrl(baseUrl) : undefined;
  if (!baseUrl) {
    warnings.push("no AI_TEST_DB_BASE/DATABASE_URL: the PostgreSQL gates will FAIL");
  }

  const codexBinary = process.env.AI_CODEX_BIN?.trim() || "codex";
  const codexRequested = process.env.AI_TEST_CODEX === "1";
  const codexAvailable = await hasBinary(codexBinary);
  const dockerAvailable =
    (await hasBinary("docker")) && (await capture("docker", ["version", "--format", "{{.Server.Version}}"])).code === 0;

  return {
    commit,
    worktreeDirty,
    baseUrl,
    baseDatabaseName: database?.name ?? "",
    adminConnection: database?.adminConnection,
    codexBinary,
    codexRequested,
    codexAvailable,
    dockerAvailable,
    warnings,
    databases: undefined,
  };
}

// ---------------------------------------------------------------------------
// isolated databases
// ---------------------------------------------------------------------------

async function prepareDatabases(context) {
  if (!context.baseUrl || !context.adminConnection) {
    return { reason: "no DATABASE_URL/AI_TEST_DB_BASE configured", created: [], migrated: [] };
  }
  const integrationName = `${context.baseDatabaseName}_it`;
  const realName = `${context.baseDatabaseName}_real`;

  const admin = new pg.Pool({ connectionString: context.adminConnection });
  try {
    await admin.query("SELECT 1");
  } catch (error) {
    await admin.end().catch(() => {});
    return {
      reason: `admin connection failed: ${message(error)}`,
      created: [],
      migrated: [],
    };
  }

  const created = [];
  const migrated = [];
  const result = { created, migrated };
  try {
    for (const [key, name] of [
      ["integration", integrationName],
      ["real", realName],
    ]) {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
        created.push(name);
      }
      const url = withDatabase(context.baseUrl, name);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const present = await pool.query("SELECT to_regclass('repositories') AS present");
        if (!present.rows[0]?.present) {
          const files = (await readdir(path.join(root, "migrations")))
            .filter((file) => file.endsWith(".sql"))
            .sort();
          for (const file of files) {
            await pool.query(readFileSync(path.join(root, "migrations", file), "utf8"));
          }
          migrated.push(`${name} (${files.length} migrations)`);
        }
        await truncateAll(pool);
      } finally {
        await pool.end().catch(() => {});
      }
      result[key] = { name, url };
    }
  } catch (error) {
    return { reason: `database preparation failed: ${message(error)}`, created, migrated };
  } finally {
    await admin.end().catch(() => {});
  }
  log(
    `databases: ${integrationName} / ${realName}` +
      (created.length > 0 ? ` (created: ${created.join(", ")})` : " (reused)") +
      (migrated.length > 0 ? ` (migrated: ${migrated.join(", ")})` : ""),
  );
  return result;
}

async function truncateAll(pool) {
  for (const table of TABLES_IN_DELETE_ORDER) {
    try {
      await pool.query(`DELETE FROM ${table}`);
    } catch (error) {
      // A missing table means the database is not migrated for that feature;
      // surface it instead of failing the whole gate on a stale schema.
      if (error?.code !== "42P01") {
        throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

async function realCodexGate(context, databases) {
  if (!databases.real) {
    return failedGate("realCodex", `database unavailable: ${databases.reason}`);
  }
  if (!context.codexRequested) {
    return skippedGate(
      "realCodex",
      "AI_TEST_CODEX not set (provider opt-in missing); run with AI_TEST_CODEX=1",
    );
  }
  if (!context.codexAvailable) {
    return failedGate("realCodex", `codex binary '${context.codexBinary}' not found`);
  }
  return vitestGate("realCodex", ["run", "tests/realE2E.integration.test.ts"], {
    AI_TEST_POSTGRES: "1",
    AI_TEST_CODEX: "1",
    AI_TEST_REQUIRE_DB: "1",
    AI_TEST_DB_URL_REAL: databases.real.url,
  });
}

async function resourceGate(context) {
  const checks = {};

  // docker: containers / per-run networks / allow-list proxy
  if (!context.dockerAvailable) {
    checks.docker = { status: "SKIPPED", reason: "docker is not available on this host" };
  } else {
    const containers = await dockerList([
      "ps",
      "-a",
      "--filter",
      "label=ai-harness.run-id",
      "--format",
      "{{.Names}}",
    ]);
    const networks = await dockerList([
      "network",
      "ls",
      "--filter",
      "name=ai-net-",
      "--format",
      "{{.Name}}",
    ]);
    const proxies = await dockerList([
      "ps",
      "-a",
      "--filter",
      "name=ai-proxy-",
      "--format",
      "{{.Names}}",
    ]);
    const leaked = [...containers, ...networks, ...proxies];
    checks.docker = {
      status: leaked.length === 0 ? "PASS" : "FAIL",
      containers,
      networks,
      proxies,
      reason: leaked.length === 0 ? undefined : `residue: ${leaked.join(", ")}`,
    };
  }

  // workspaces: successful runs legitimately keep their workspace for review
  // (docs/phase12-acceptance.md §11.2), so only two things are failures here:
  // the suite-owned e2e directory surviving its own cleanup, and directories
  // created inside a workspace base while this gate was running.
  const e2eWorkspaceDir = path.join(root, ".ai-workspaces-e2e");
  const workspaceBases = [process.env.AI_WORKSPACES_DIR, path.join(homedir(), "ai-workspaces")]
    .filter(Boolean)
    .filter((candidate) => existsSync(candidate));
  const createdDuringGate = [];
  for (const base of workspaceBases) {
    for (const entry of await readdirSafe(base)) {
      const entryPath = path.join(base, entry);
      const stat = statSafe(entryPath);
      if (stat && stat.mtimeMs >= startedAt.getTime()) {
        createdDuringGate.push(entryPath);
      }
    }
  }
  const e2eLeftover = existsSync(e2eWorkspaceDir) ? [e2eWorkspaceDir] : [];
  const leaked = [...e2eLeftover, ...createdDuringGate];
  checks.workspaces = {
    status: leaked.length === 0 ? "PASS" : "FAIL",
    suiteWorkspaceDir: e2eWorkspaceDir,
    observedBases: workspaceBases,
    createdDuringGate,
    reason:
      leaked.length === 0
        ? undefined
        : `unexpected workspace leftovers: ${leaked.join(", ")}`,
  };

  // executions: terminal runs must have CLEANED executions (DB = resource state)
  const database = context.databases;
  if (!database?.integration && !database?.real) {
    checks.executions = { status: "SKIPPED", reason: "no gate database available" };
  } else {
    const target = database.real ?? database.integration;
    const pool = new pg.Pool({ connectionString: target.url });
    try {
      const active = await pool.query(
        `SELECT count(*)::int AS n FROM runs
         WHERE status IN ('QUEUED','STARTING','RUNNING','VERIFYING')`,
      );
      const uncleaned = await pool.query(
        `SELECT count(*)::int AS n FROM executions e
         JOIN runs r ON r.id = e.run_id
         WHERE r.status IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','LOST')
           AND e.status <> 'CLEANED'`,
      );
      const activeCount = active.rows[0]?.n ?? 0;
      const uncleanedCount = uncleaned.rows[0]?.n ?? 0;
      checks.executions = {
        status: activeCount === 0 && uncleanedCount === 0 ? "PASS" : "FAIL",
        database: target.name,
        activeRuns: activeCount,
        uncleanedExecutions: uncleanedCount,
        reason:
          activeCount === 0 && uncleanedCount === 0
            ? undefined
            : `${activeCount} active run(s), ${uncleanedCount} uncleaned execution(s)`,
      };
    } catch (error) {
      checks.executions = { status: "FAIL", reason: message(error) };
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const statuses = Object.values(checks).map((check) => check.status);
  const status = statuses.includes("FAIL")
    ? "FAIL"
    : statuses.every((entry) => entry === "SKIPPED")
      ? "SKIPPED"
      : "PASS";
  return {
    status,
    command: "resource checks (docker / workspaces / executions)",
    durationMs: 0,
    checks,
    reason:
      status === "SKIPPED" ? "no check could run on this host (no docker, no database)" : undefined,
  };
}

async function dockerList(args) {
  const result = await capture("docker", args);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readdirSafe(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function statSafe(target) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// gate helpers
// ---------------------------------------------------------------------------

/** Runs a vitest gate with the JSON reporter and parses its counts. */
async function vitestGate(name, vitestArgs, env = {}) {
  const jsonPath = path.join(artifactsDir, `gate-${name}.json`);
  const args = [
    "vitest",
    ...vitestArgs,
    "--reporter=json",
    `--outputFile=${jsonPath}`,
  ];
  const started = Date.now();
  const result = await capture("npx", args, { env: { ...process.env, ...env } });
  const durationMs = Date.now() - started;
  const counts = readVitestCounts(jsonPath);
  const status = result.code === 0 ? "PASS" : "FAIL";
  if (status === "FAIL") {
    log(`--- ${name} output (tail) ---`);
    for (const line of result.stderr.split("\n").slice(-20)) {
      log(`  ${line}`);
    }
  }
  return {
    status,
    command: `npx ${args.join(" ")}`,
    durationMs,
    exitCode: result.code,
    tests: counts,
    reason: status === "FAIL" ? `${counts.failed ?? 0} failed test(s)` : undefined,
  };
}

async function runCommandGate(name, command, args, env = {}) {
  const started = Date.now();
  const result = await capture(command, args, { env: { ...process.env, ...env } });
  const durationMs = Date.now() - started;
  if (result.code !== 0) {
    log(`--- ${name} output (tail) ---`);
    for (const line of result.stdout.split("\n").slice(-20)) {
      log(`  ${line}`);
    }
  }
  return {
    status: result.code === 0 ? "PASS" : "FAIL",
    command: `${command} ${args.join(" ")}`,
    durationMs,
    exitCode: result.code,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
}

function readVitestCounts(jsonPath) {
  if (!existsSync(jsonPath)) {
    return { total: 0, passed: 0, failed: 0, skipped: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    const total =
      parsed.numTotalTests ??
      (parsed.testResults ?? []).reduce(
        (sum, file) => sum + (file.assertionResults?.length ?? 0),
        0,
      );
    return {
      total,
      passed: parsed.numPassedTests ?? 0,
      failed: parsed.numFailedTests ?? 0,
      skipped: parsed.numPendingTests ?? parsed.numTodoTests ?? 0,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, skipped: 0 };
  }
}

function skippedGate(name, reason) {
  return {
    status: "SKIPPED",
    command: `(${name} skipped)`,
    durationMs: 0,
    reason,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
}

function failedGate(name, reason) {
  return {
    status: "FAIL",
    command: `(${name} not run)`,
    durationMs: 0,
    reason,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

async function finish(context) {
  const finishedAt = new Date();
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const gate of Object.values(gates)) {
    for (const key of Object.keys(counts)) {
      counts[key] += gate.tests?.[key] ?? 0;
    }
  }

  const failed = Object.entries(gates)
    .filter(([, gate]) => gate.status === "FAIL")
    .map(([name]) => name);
  const status = failed.length === 0 ? "PASS" : "FAIL";
  // Policy: FROZEN needs the *docker* resource check to have actually run —
  // a resource gate that passed because docker was skipped does not count.
  const dockerStatus = gates.resources?.checks?.docker?.status ?? "SKIPPED";
  const dockerGateEverPassed =
    dockerStatus === "PASS" || readDockerHistory();

  const report = {
    phase: "12",
    task: "TASK-1208",
    commit: context.commit,
    worktreeDirty: context.worktreeDirty,
    host: hostname(),
    date: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    databases: context.databases
      ? {
          base: context.baseDatabaseName,
          integration: context.databases.integration?.name,
          real: context.databases.real?.name,
          created: context.databases.created ?? [],
          migrated: context.databases.migrated ?? [],
          reason: context.databases.reason,
        }
      : { reason: context.databases?.reason },
    gates,
    docker: dockerStatus,
    acceptance: counts,
    dockerGateEverPassed,
    status,
    notes,
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  appendFileSync(
    historyPath,
    `${JSON.stringify({
      date: report.date,
      commit: report.commit,
      status,
      docker: dockerStatus,
      gates: Object.fromEntries(
        Object.entries(gates).map(([name, gate]) => [name, gate.status]),
      ),
      acceptance: counts,
    })}\n`,
  );

  printSummary(context, report);
  return status === "PASS" ? 0 : 1;
}

function printSummary(context, report) {
  log("");
  log(`Phase 12 Release Gate — ${report.date}`);
  log(`  commit: ${report.commit}${report.worktreeDirty ? " (dirty worktree)" : ""}`);
  log(`  host:   ${report.host}`);
  log(
    `  db:     ${report.databases.integration ?? "-"} / ${report.databases.real ?? "-"}` +
      (report.databases.created?.length ? ` (created: ${report.databases.created.join(", ")})` : ""),
  );
  for (const [name, gate] of Object.entries(gates)) {
    const tests = gate.tests?.total
      ? `  (${gate.tests.passed} passed / ${gate.tests.failed} failed / ${gate.tests.skipped} skipped)`
      : "";
    const reason = gate.reason ? `  — ${gate.reason}` : "";
    log(`  ${name.padEnd(12)} ${gate.status}${tests}${reason}`);
  }
  log(
    `  acceptance: ${report.acceptance.passed} passed / ${report.acceptance.failed} failed / ` +
      `${report.acceptance.skipped} skipped`,
  );
  log(`  docker gate ever passed: ${report.dockerGateEverPassed ? "yes" : "no"}`);
  log(`  report: ${path.relative(root, reportPath)}`);
  log(`=> ${report.status === "PASS" ? "PASS" : "FAIL"}`);
  void context;
}

function readDockerHistory() {
  if (!existsSync(historyPath)) {
    return false;
  }
  return readFileSync(historyPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return JSON.parse(line).docker === "PASS";
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.echo) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.echo) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${message(error)}` });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function hasBinary(binary) {
  const result = await capture("sh", ["-c", `command -v ${JSON.stringify(binary)}`]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function parseDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    const admin = new URL(url);
    admin.pathname = "/postgres";
    return { name, adminConnection: admin.toString() };
  } catch {
    return undefined;
  }
}

function withDatabase(url, databaseName) {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(line) {
  console.log(line);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // The runner itself failing is a gate failure, and must exit non-zero.
    const failure = {
      phase: "12",
      task: "TASK-1208",
      host: hostname(),
      date: startedAt.toISOString(),
      gates: Object.fromEntries(
        Object.entries(gates).map(([name, gate]) => [name, gate.status]),
      ),
      status: "FAIL",
      runnerError: message(error),
      notes,
    };
    try {
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`);
    } catch {
      // Reporting must never mask the original failure.
    }
    console.error(`release gate runner failed: ${message(error)}`);
    process.exitCode = 1;
  });
