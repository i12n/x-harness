#!/usr/bin/env node

// Apply migrations/*.sql in order. Development-grade runner: re-running
// re-applies files (CREATE TABLE statements then fail loudly), which is fine
// for v0.1 local development.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbUrl =
  process.env.DATABASE_URL ?? "postgres://ai:ai@localhost:5432/ai_harness";
const migrationsDir = path.join(root, "migrations");
const pool = new pg.Pool({ connectionString: dbUrl });

try {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log("No migrations found.");
  }
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
    console.log(`applied ${file}`);
  }
} finally {
  await pool.end();
}
