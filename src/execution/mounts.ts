import { isAbsolute, relative, resolve, sep } from "node:path";
import { ValidationError } from "../errors.js";

export const CONTAINER_PRIMARY_WORKSPACE = "/workspace";
export const CONTAINER_TARGETS_ROOT = "/workspaces";

/** One workspace mounted into the Run's execution environment. */
export interface ExecutionMount {
  targetId: string;
  /** Host path (a Harness-created workspace). */
  source: string;
  /** Container path: /workspace (primary) or /workspaces/<targetId>. */
  target: string;
  readOnly?: boolean;
  /** Exactly one mount is the primary (mapped to /workspace). */
  primary?: boolean;
}

export interface MountValidationOptions {
  /** Only sources inside these roots are allowed (Harness workspaces). */
  allowedSourceRoots?: string[];
  /** When set, must equal the targetId of the primary mount. */
  primaryTargetId?: string;
}

/** Accepts both the Phase 9 single-workspace shape and the multi-mount shape. */
export function normalizeExecutionMounts(request: {
  mounts?: ExecutionMount[];
  workspacePath?: string;
  primaryTarget?: string;
}): ExecutionMount[] {
  if (request.mounts && request.mounts.length > 0) {
    return request.mounts.map((mount) => ({ ...mount }));
  }
  if (!request.workspacePath) {
    throw new ValidationError("execution request requires mounts or workspacePath");
  }
  return [
    {
      targetId: "primary",
      source: resolve(request.workspacePath),
      target: request.primaryTarget ?? CONTAINER_PRIMARY_WORKSPACE,
      primary: true,
    },
  ];
}

export function validateExecutionMounts(
  mounts: ExecutionMount[],
  options: MountValidationOptions = {},
): void {
  const issues: string[] = [];
  const targetIds = new Set<string>();
  const containerTargets = new Set<string>();
  let primaries = 0;

  for (const mount of mounts) {
    const targetId = mount.targetId?.trim();
    if (!targetId) {
      issues.push("mount targetId is required");
    } else if (targetIds.has(targetId)) {
      issues.push(`duplicate mount targetId: ${targetId}`);
    } else {
      targetIds.add(targetId);
    }

    if (!mount.source || !isAbsolute(mount.source)) {
      issues.push(`mount source must be an absolute path: ${mount.source}`);
    } else if (
      options.allowedSourceRoots &&
      options.allowedSourceRoots.length > 0 &&
      !options.allowedSourceRoots.some((root) =>
        isInside(mount.source, resolve(root)),
      )
    ) {
      issues.push(`mount source is outside the allowed workspace roots: ${mount.source}`);
    }

    const isPrimaryTarget = mount.target === CONTAINER_PRIMARY_WORKSPACE;
    const isSupportingTarget =
      mount.target.startsWith(`${CONTAINER_TARGETS_ROOT}/`) &&
      mount.target.length > CONTAINER_TARGETS_ROOT.length + 1;
    if (!isPrimaryTarget && !isSupportingTarget) {
      issues.push(
        `mount target must be ${CONTAINER_PRIMARY_WORKSPACE} or under ${CONTAINER_TARGETS_ROOT}/: ${mount.target}`,
      );
    }
    if (containerTargets.has(mount.target)) {
      issues.push(`duplicate container target: ${mount.target}`);
    } else {
      containerTargets.add(mount.target);
    }

    if (mount.primary) {
      primaries += 1;
    }
  }

  if (mounts.length === 0) {
    issues.push("at least one mount is required");
  }
  if (primaries !== 1) {
    issues.push(`exactly one primary mount is required (found ${primaries})`);
  }
  const primary = mounts.find((mount) => mount.primary);
  if (primary && primary.target !== CONTAINER_PRIMARY_WORKSPACE) {
    issues.push(
      `primary mount must map to ${CONTAINER_PRIMARY_WORKSPACE} (got ${primary.target})`,
    );
  }
  if (options.primaryTargetId) {
    if (!targetIds.has(options.primaryTargetId)) {
      issues.push(
        `primaryTargetId ${options.primaryTargetId} does not match any mount`,
      );
    } else if (primary && primary.targetId !== options.primaryTargetId) {
      issues.push(
        `primaryTargetId ${options.primaryTargetId} is not the primary mount`,
      );
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(`invalid execution mounts: ${issues.join("; ")}`);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, resolve(child));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}
