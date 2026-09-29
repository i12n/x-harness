/**
 * Migration runner with real applied-state tracking.
 *
 * The previous runner replayed every file on every run (fine for a throwaway
 * development database, fatal for a deployed one). This one records applied
 * file names in `schema_migrations`, wraps each file in a transaction, and
 * refuses to guess when it meets a database that predates tracking — that
 * database has to be baselined explicitly.
 */

export interface MigrationQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface MigrationDb {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
}

export interface MigrationSource {
  /** File names to apply, already sorted. */
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
  /** Only filled by `baseline: true` runs. */
  baselined: string[];
}

export interface RunMigrationsOptions {
  /**
   * Record every discovered migration as applied WITHOUT executing it. Only
   * valid for a database that was migrated before tracking existed.
   */
  baseline?: boolean;
  log?: (message: string) => void;
}

const TRACKING_TABLE = "schema_migrations";

export async function runMigrations(
  db: MigrationDb,
  source: MigrationSource,
  options: RunMigrationsOptions = {},
): Promise<MigrationReport> {
  const log = options.log ?? (() => {});
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = await source.list();
  const applied = await appliedFiles(db);

  if (options.baseline) {
    if (applied.size > 0) {
      throw new Error(
        `${TRACKING_TABLE} already has ${applied.size} row(s); baseline is only for an untracked database`,
      );
    }
    for (const file of files) {
      await record(db, file);
      log(`baselined ${file}`);
    }
    return { applied: [], skipped: [], baselined: files };
  }

  const report: MigrationReport = { applied: [], skipped: [], baselined: [] };
  for (const file of files) {
    if (applied.has(file)) {
      report.skipped.push(file);
      log(`skipped ${file} (already applied)`);
      continue;
    }
    const sql = await source.read(file);
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await record(db, file);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw decorate(error, file);
    }
    report.applied.push(file);
    log(`applied ${file}`);
  }
  return report;
}

async function appliedFiles(db: MigrationDb): Promise<Set<string>> {
  const result = await db.query(`SELECT filename FROM ${TRACKING_TABLE}`);
  const names = new Set<string>();
  for (const row of result.rows) {
    const filename = row.filename;
    if (typeof filename === "string") {
      names.add(filename);
    }
  }
  return names;
}

async function record(db: MigrationDb, filename: string): Promise<void> {
  await db.query(`INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1)`, [filename]);
}

/** Turns "already exists" into an actionable message. */
function decorate(error: unknown, file: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  const hint =
    code === "42P07" || code === "42710" || code === "42P16" || /already exists/.test(message)
      ? "\nhint: this database was migrated before tracking existed — run\n" +
        "      node scripts/migrate.mjs --baseline   (once, then deploy normally)"
      : "";
  return new Error(`migration ${file} failed: ${message}${hint}`);
}
