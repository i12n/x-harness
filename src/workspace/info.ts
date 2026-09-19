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

export interface WorkspaceEvidence {
  targetId?: string;
  path: string;
  branch: string;
}

/**
 * TASK-1009: a Run may own several workspaces (one per target). Falls back to
 * the legacy single-workspace evidence when the run predates Phase 10.
 */
export function extractWorkspacesInfo(
  run: Pick<Run, "result" | "error">,
): WorkspaceEvidence[] {
  const raw = [run.result, run.error].find(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
  );
  const list = raw?.workspaces;
  if (Array.isArray(list)) {
    const workspaces: WorkspaceEvidence[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const workspace = entry as Record<string, unknown>;
      if (typeof workspace.path !== "string" || !workspace.path) {
        continue;
      }
      workspaces.push({
        targetId:
          typeof workspace.targetId === "string" ? workspace.targetId : undefined,
        path: workspace.path,
        branch: typeof workspace.branch === "string" ? workspace.branch : "",
      });
    }
    if (workspaces.length > 0) {
      return workspaces;
    }
  }
  const single = extractWorkspaceInfo(run);
  return single ? [{ path: single.path, branch: single.branch }] : [];
}
