/**
 * Preview *build* settings (TASK-1226).
 *
 * Deployment is owned by GitHub Actions (see
 * docs/test-environment-deployment-plan.md), so the harness no longer holds a
 * preview host, ports or a TTL. What stays here are the knobs for the one thing
 * the harness still does: build the change and collect evidence. One set for
 * every repository — there are no per-repository preview fields.
 */

export interface PreviewSettings {
  /** Package hosts the preview build container may reach. */
  allowedHosts: string[];
  memoryMb: number;
  cpus: number;
}

export const DEFAULT_PREVIEW_MEMORY_MB = 768;
export const DEFAULT_PREVIEW_CPUS = 1;
export const DEFAULT_PREVIEW_ALLOW = ["registry.npmjs.org"];

export type EnvLike = Record<string, string | undefined>;

/** Reads and validates the single preview configuration. */
export function previewSettingsFromEnv(env: EnvLike = process.env): PreviewSettings {
  return {
    memoryMb: positiveInt(env.AI_PREVIEW_MEMORY_MB, DEFAULT_PREVIEW_MEMORY_MB, "AI_PREVIEW_MEMORY_MB"),
    cpus: positiveInt(env.AI_PREVIEW_CPUS, DEFAULT_PREVIEW_CPUS, "AI_PREVIEW_CPUS"),
    allowedHosts: csv(env.AI_PREVIEW_ALLOW, DEFAULT_PREVIEW_ALLOW),
  };
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const raw = (value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name} '${value}' (expect a positive integer)`);
  }
  return parsed;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...fallback];
}
