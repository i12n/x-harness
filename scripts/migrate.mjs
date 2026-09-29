#!/usr/bin/env node

// Apply migrations/*.sql in order, exactly once each (tracked in
// schema_migrations). Requires `npm run build` — the logic lives in
// src/db/migrate.ts so it stays unit tested.
//
//   node scripts/migrate.mjs              # apply pending migrations
//   node scripts/migrate.mjs --baseline   # mark a pre-tracking DB as migrated

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../dist/db/migrate.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbUrl =
  process.env.DATABASE_URL ?? "postgres://ai:ai@localhost:5432/ai_harness";
const migrationsDir = path.join(root, "migrations");
const baseline = process.argv.includes("--baseline");
const pool = new pg.Pool({ connectionString: dbUrl });

try {
  const report = await runMigrations(
    { query: (sql, params) => pool.query(sql, params) },
    {
      list: async () =>
        (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort(),
      read: (name) => readFile(path.join(migrationsDir, name), "utf8"),
    },
    { baseline, log: (message) => console.log(message) },
  );
  console.log(
    `${report.applied.length} applied, ${report.skipped.length} already applied` +
      (report.baselined.length > 0 ? `, ${report.baselined.length} baselined` : ""),
  );
} finally {
  await pool.end();
}
