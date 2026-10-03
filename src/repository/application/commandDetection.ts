import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionCommands } from "../../domain/executionProfile.js";

export interface DetectedCommands extends ExecutionCommands {
  /** Command worth using as the verification gate (nothing else to run). */
  verify?: string;
  /** Human-readable explanation, present when nothing could be detected. */
  note?: string;
}

export interface DetectionInput {
  /** Parsed package.json, when the checkout has one. */
  packageJson?: unknown;
  /** Entry names in the checkout root (used to pick the package manager). */
  files: string[];
}

/**
 * A repository that declares no execution commands is not "broken" — it just
 * has not been configured. The harness must not fail (or skip work) because of
 * that, so it derives the obvious commands from what the checkout actually is:
 * lockfile → package manager → install / build / test.
 */
export function detectCommands(input: DetectionInput): DetectedCommands {
  const scripts = readScripts(input.packageJson);
  if (!input.packageJson && !input.files.includes("package.json")) {
    return { note: "未识别到 Node 工程（没有 package.json），需要人工配置命令" };
  }
  const manager = pickPackageManager(input.files);
  const commands: DetectedCommands = { install: installCommand(manager) };
  if (scripts.build) {
    commands.build = `${manager} run build`;
  }
  if (scripts.test) {
    commands.test = `${manager} test`;
    commands.verify = `${manager} test`;
  }
  if (!scripts.build && !scripts.test) {
    commands.note = "package.json 里没有 build/test 脚本，只推导出安装命令";
  }
  return commands;
}

/** Reads the checkout and detects; never throws — detection is best-effort. */
export async function detectCommandsFromDirectory(
  directory: string,
  options: { readFile?: (path: string) => Promise<string> } = {},
): Promise<DetectedCommands> {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  try {
    const raw = await read(join(directory, "package.json"));
    const files = await listRoot(directory);
    return detectCommands({ packageJson: JSON.parse(raw), files });
  } catch {
    return { note: `无法从 ${directory} 识别命令（读取 package.json 失败）` };
  }
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function pickPackageManager(files: string[]): PackageManager {
  if (files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (files.includes("yarn.lock")) {
    return "yarn";
  }
  if (files.includes("bun.lockb")) {
    return "bun";
  }
  return "npm";
}

function installCommand(manager: PackageManager): string {
  switch (manager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    default:
      return "npm ci";
  }
}

function readScripts(packageJson: unknown): { build?: string; test?: string } {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return {};
  }
  const scripts = (packageJson as Record<string, unknown>).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  const entries = scripts as Record<string, unknown>;
  return {
    ...(typeof entries.build === "string" && entries.build.trim() ? { build: entries.build } : {}),
    ...(typeof entries.test === "string" && entries.test.trim() ? { test: entries.test } : {}),
  };
}

async function listRoot(directory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(directory);
  } catch {
    return [];
  }
}

/**
 * Fills only what is missing: an explicit configuration always wins, and a
 * repository whose commands were set by hand is never overwritten.
 */
export function mergeDetectedCommands(
  configured: ExecutionCommands,
  detected: DetectedCommands,
): ExecutionCommands {
  return {
    install: configured.install ?? detected.install,
    test: configured.test ?? detected.test,
    build: configured.build ?? detected.build,
    screenshot: configured.screenshot,
  };
}
