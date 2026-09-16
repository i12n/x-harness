import type { ExecutionProfile } from "../domain/executionProfile.js";
import { ValidationError } from "../errors.js";

/**
 * Execution container contract (TASK-911).
 *
 *   image:     harness/execution:<runtime>   (recommended naming)
 *   workspace: /workspace                    (only mount point, read/write)
 *   home:      /home/agent                   (tmpfs, writable caches)
 *   tmp:       /tmp                          (tmpfs)
 *   user:      1000:1000                     (non-root)
 *   rootfs:    read-only
 */
export const EXECUTION_IMAGE_PREFIX = "harness/execution:";
export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_HOME = "/home/agent";
export const CONTAINER_TMP = "/tmp";
export const CONTAINER_USER = "1000:1000";

export interface ExecutionContractCheck {
  ok: boolean;
  issues: string[];
  advisories: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function checkExecutionProfileContract(
  profile: ExecutionProfile,
): ExecutionContractCheck {
  const issues: string[] = [];
  const advisories: string[] = [];

  const workspace = profile.workspace;
  if (!workspace.startsWith("/")) {
    issues.push(`workspace must be absolute: ${workspace}`);
  } else if (
    workspace === "/" ||
    !(workspace === CONTAINER_WORKSPACE || workspace.startsWith(`${CONTAINER_WORKSPACE}/`))
  ) {
    issues.push(`workspace must live under ${CONTAINER_WORKSPACE}: ${workspace}`);
  }

  for (const secret of profile.secrets) {
    if (!ENV_NAME.test(secret)) {
      issues.push(`secret name is not a valid environment variable: ${secret}`);
    }
  }

  if (!profile.image.startsWith(EXECUTION_IMAGE_PREFIX)) {
    advisories.push(
      `image should follow ${EXECUTION_IMAGE_PREFIX}<runtime> (got ${profile.image})`,
    );
  }

  return { ok: issues.length === 0, issues, advisories };
}

/** Hard contract violations abort container start; advisories are informational. */
export function validateExecutionProfileContract(profile: ExecutionProfile): void {
  const { issues } = checkExecutionProfileContract(profile);
  if (issues.length > 0) {
    throw new ValidationError(
      `execution profile violates the container contract: ${issues.join("; ")}`,
    );
  }
}
