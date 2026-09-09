import type { Run } from "../domain/run.js";

/** Read the workspace evidence recorded on a run's result/error payload. */
export function extractWorkspaceInfo(
  run: Pick<Run, "result" | "error">,
): { path: string; branch: string } | undefined {
  const raw = [run.result, run.error].find(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
  );
  if (!raw) {
    return undefined;
  }
  const workspace = raw.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    return undefined;
  }
  const path = (workspace as { path?: unknown }).path;
  const branch = (workspace as { branch?: unknown }).branch;
  if (typeof path !== "string" || !path) {
    return undefined;
  }
  return { path, branch: typeof branch === "string" ? branch : "" };
}
