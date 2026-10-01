import { Pool } from "pg";
import { applyRepositoryUpdate, buildRepository } from "../domain/repository.js";
import type {
  CreateRepositoryInput,
  Repository,
  UpdateRepositoryInput,
} from "../domain/repository.js";
import {
  buildExecutionProfile,
  defaultExecutionProfile,
} from "../domain/executionProfile.js";
import type {
  CreateExecutionProfileInput,
  ExecutionProfile,
} from "../domain/executionProfile.js";
import { RepositoryNotFoundError } from "../errors.js";
import type { RepositoryStore } from "./repositoryStore.js";

interface RepositoryRow {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  local_path: string;
  config: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StoredConfig {
  verification?: { commands?: unknown };
  executionProfile?: unknown;
}

/** PostgreSQL-backed repository store (see migrations/001_init.sql). */
export class PostgresRepositoryStore implements RepositoryStore {
  constructor(private readonly pool: Pool) {}

  async createRepository(input: CreateRepositoryInput): Promise<Repository> {
    const repository = buildRepository(input);
    const config = JSON.stringify({
      verification: { commands: repository.verificationCommands },
      executionProfile: repository.executionProfile,
    });
    const { rows } = await this.pool.query<RepositoryRow>(
      `INSERT INTO repositories
         (id, name, url, default_branch, local_path, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [
        repository.id,
        repository.name,
        repository.url,
        repository.defaultBranch,
        repository.localPath,
        config,
        repository.createdAt,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("createRepository: insert returned no row");
    }
    return rowToRepository(row);
  }

  async listRepositories(): Promise<Repository[]> {
    const { rows } = await this.pool.query<RepositoryRow>(
      "SELECT * FROM repositories ORDER BY created_at ASC, id ASC",
    );
    return rows.map(rowToRepository);
  }

  async findRepository(id: string): Promise<Repository> {
    const { rows } = await this.pool.query<RepositoryRow>(
      "SELECT * FROM repositories WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryNotFoundError(id);
    }
    return rowToRepository(row);
  }

  async updateRepository(id: string, patch: UpdateRepositoryInput): Promise<Repository> {
    const current = await this.findRepository(id);
    const updated = applyRepositoryUpdate(current, patch);
    const config = JSON.stringify({
      verification: { commands: updated.verificationCommands },
      executionProfile: updated.executionProfile,
    });
    const { rows } = await this.pool.query<RepositoryRow>(
      `UPDATE repositories
          SET name = $2, url = $3, default_branch = $4, local_path = $5,
              config = $6, updated_at = $7
        WHERE id = $1
      RETURNING *`,
      [
        id,
        updated.name,
        updated.url,
        updated.defaultBranch,
        updated.localPath,
        config,
        updated.updatedAt,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryNotFoundError(id);
    }
    return rowToRepository(row);
  }
}

function rowToRepository(row: RepositoryRow): Repository {
  const stored = parseStoredConfig(row.config);
  const commands = stored.verification?.commands;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    defaultBranch: row.default_branch,
    localPath: row.local_path,
    verificationCommands: Array.isArray(commands)
      ? commands.filter((command): command is string => typeof command === "string")
      : [],
    executionProfile: parseExecutionProfile(stored.executionProfile),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseExecutionProfile(raw: unknown): ExecutionProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultExecutionProfile();
  }
  try {
    return buildExecutionProfile(raw as CreateExecutionProfileInput);
  } catch {
    return defaultExecutionProfile();
  }
}

function parseStoredConfig(raw: unknown): StoredConfig {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as StoredConfig;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") {
    return raw as StoredConfig;
  }
  return {};
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
