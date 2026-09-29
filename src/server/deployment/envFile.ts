import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Reads and rewrites the systemd `EnvironmentFile`.
 *
 * Two readers must agree on the result: systemd (EnvironmentFile=) and bash
 * (`set -a; . deploy/ai-harness.env`). Single-quoted values are literal to
 * both, so anything that is not a bare token gets single quotes — and a value
 * containing a single quote is rejected by the schema validator instead of
 * being written in a form one of the readers would misparse.
 */

const BARE = /^[A-Za-z0-9_.,:/@%+=-]*$/;

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    values[key] = unquote(trimmed.slice(separator + 1).trim());
  }
  return values;
}

export function serializeEnvValue(value: string): string {
  if (value === "") {
    return "";
  }
  if (BARE.test(value) && !value.startsWith("-") && !value.endsWith(" ")) {
    return value;
  }
  return `'${value}'`;
}

export interface EnvFileWriteResult {
  /** Keys whose line changed. */
  changed: string[];
  /** Keys that did not exist in the file before. */
  added: string[];
}

/**
 * Applies `updates` (key → new value; `""` clears) while leaving comments,
 * ordering and every unmanaged key untouched. Atomic: write temp + rename,
 * so a failure can never leave a half-written env file.
 */
export async function writeManagedEnvFile(
  path: string,
  updates: Record<string, string>,
): Promise<EnvFileWriteResult> {
  const existing = await readEnvFileText(path);
  const lines = existing.split(/\r?\n/);
  const changed: string[] = [];
  const added: string[] = [];

  const remaining = new Map(Object.entries(updates));
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[2]!;
    if (seen.has(key) || !remaining.has(key)) {
      continue;
    }
    seen.add(key);
    const value = remaining.get(key)!;
    remaining.delete(key);
    const replacement = `${key}=${serializeEnvValue(value)}`;
    if (line !== replacement) {
      lines[index] = replacement;
      changed.push(key);
    }
  }

  if (remaining.size > 0) {
    lines.push("", "# —— 由配置页写入 ——");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${serializeEnvValue(value)}`);
      added.push(key);
      changed.push(key);
    }
  }

  await writeFileAtomic(path, `${lines.join("\n").replace(/\n*$/, "\n")}`);
  return { changed, added };
}

export async function readManagedEnvFile(
  path: string,
): Promise<Record<string, string>> {
  return parseEnvFile(await readEnvFileText(path));
}

async function readEnvFileText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Date.now()}.env.tmp`);
  // 0600 from the start: the file holds the app secret and model keys.
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
