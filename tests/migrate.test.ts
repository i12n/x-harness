import { describe, expect, it } from "vitest";
import {
  runMigrations,
  type MigrationDb,
  type MigrationQueryResult,
  type MigrationSource,
} from "../src/db/migrate.js";

class FakeDb implements MigrationDb {
  applied = new Set<string>();
  executed: string[] = [];
  failedFile: string | undefined;

  async query(sql: string, params?: unknown[]): Promise<MigrationQueryResult> {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      return { rows: [] };
    }
    if (sql.startsWith("SELECT filename FROM schema_migrations")) {
      return { rows: [...this.applied].map((filename) => ({ filename })) };
    }
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      this.applied.add(String(params?.[0]));
      return { rows: [] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (this.failedFile && sql.includes(this.failedFile)) {
      const error = new Error('relation "repositories" already exists') as Error & {
        code: string;
      };
      error.code = "42P07";
      throw error;
    }
    this.executed.push(sql);
    return { rows: [] };
  }
}

function source(files: string[]): MigrationSource {
  return {
    list: async () => [...files],
    read: async (name) => `-- ${name}`,
  };
}

const FILES = ["001_init.sql", "002_problems.sql"];

describe("runMigrations", () => {
  it("applies pending migrations in order and records them", async () => {
    const db = new FakeDb();
    const report = await runMigrations(db, source(FILES));

    expect(report.applied).toEqual(FILES);
    expect(report.skipped).toEqual([]);
    expect(db.executed).toEqual(["-- 001_init.sql", "-- 002_problems.sql"]);
    expect([...db.applied]).toEqual(FILES);
  });

  it("is idempotent: a second run skips everything", async () => {
    const db = new FakeDb();
    await runMigrations(db, source(FILES));

    const second = await runMigrations(db, source(FILES));

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(FILES);
    expect(db.executed).toHaveLength(2);
  });

  it("rolls back and does not record a failed migration", async () => {
    const db = new FakeDb();
    db.failedFile = "002_problems.sql";

    await expect(runMigrations(db, source(FILES))).rejects.toThrowError(
      /migration 002_problems\.sql failed/,
    );
    expect(db.applied).toEqual(new Set(["001_init.sql"]));
  });

  it("explains how to baseline a database that predates tracking", async () => {
    const db = new FakeDb();
    db.failedFile = "001_init.sql";

    await expect(runMigrations(db, source(FILES))).rejects.toThrowError(
      /--baseline/,
    );
  });

  it("baselines an untracked database without executing anything", async () => {
    const db = new FakeDb();
    const report = await runMigrations(db, source(FILES), { baseline: true });

    expect(report.baselined).toEqual(FILES);
    expect(db.executed).toEqual([]);
    expect([...db.applied]).toEqual(FILES);
  });

  it("refuses to baseline a database that already has tracking rows", async () => {
    const db = new FakeDb();
    db.applied.add("001_init.sql");

    await expect(runMigrations(db, source(FILES), { baseline: true })).rejects.toThrowError(
      /baseline is only for an untracked database/,
    );
  });
});
