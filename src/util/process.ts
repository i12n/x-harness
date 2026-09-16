import type { ChildProcess } from "node:child_process";

/**
 * With `shell: true` the real work happens in a grandchild; killing only the
 * shell leaves the grandchild holding pipes (observed on Linux). Kill the
 * whole process group instead.
 */
export function killProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the plain kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already gone.
  }
}
