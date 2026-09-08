import { spawn } from "node:child_process";

export interface VerificationCheck {
  name: string;
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationSeconds: number;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
}

export interface RunVerificationParams {
  workspacePath: string;
  commands: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface VerifierOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Verification runner (plan section 十八): executes every configured command
 * inside the run workspace. A run only succeeds when all checks pass.
 */
export class Verifier {
  private readonly defaultTimeoutMs: number;
  private readonly env: Record<string, string>;

  constructor(options: VerifierOptions = {}) {
    this.defaultTimeoutMs =
      options.timeoutMs ?? Number(process.env.AI_VERIFY_TIMEOUT_MS ?? 10 * 60 * 1000);
    this.env = options.env ?? {};
  }

  async run(params: RunVerificationParams): Promise<VerificationResult> {
    const startedAt = new Date().toISOString();
    const commands = params.commands;
    const checks: VerificationCheck[] = [];

    if (commands.length === 0) {
      checks.push({
        name: "verification",
        command: "",
        status: "failed",
        exitCode: null,
        output: "no verification commands configured for this repository",
        durationSeconds: 0,
      });
    } else {
      for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index] ?? "";
        checks.push(
          await this.runCheck(command, index + 1, params),
        );
      }
    }

    const finishedAt = new Date().toISOString();
    const durationSeconds = elapsedSeconds(startedAt, finishedAt);
    return {
      passed: checks.every((check) => check.status === "passed"),
      checks,
      startedAt,
      finishedAt,
      durationSeconds,
    };
  }

  private runCheck(
    command: string,
    index: number,
    params: RunVerificationParams,
  ): Promise<VerificationCheck> {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = new Date().toISOString();
    return new Promise<VerificationCheck>((resolve) => {
      const child = spawn(command, {
        cwd: params.workspacePath,
        env: { ...process.env, ...this.env },
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
      });

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("close", (exitCode: number | null) => {
        clearTimeout(timeout);
        const finishedAt = new Date().toISOString();
        const trimmed = output.trim();
        resolve({
          name: `check-${index}`,
          command,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
          output: trimmed,
          durationSeconds: elapsedSeconds(startedAt, finishedAt),
        });
      });
    });
  }
}

function elapsedSeconds(startedAt: string, finishedAt: string): number {
  return Math.max(
    0,
    (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );
}
