import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PreviewDeployRequest {
  /** Delivery id — also the container name suffix on the host. */
  id: string;
  /**
   * What the host runs. `bundle` is a tarball of the worktree shipped to the
   * host (no Dockerfile needed); `image` is a reference it can pull or already
   * has. Producing images is a later step of TASK-1228.
   */
  artifact: { kind: "bundle" | "image"; value: string };
  /** Command that installs, builds and serves inside the container. */
  start: string;
  port: number;
  token: string;
  ttlMinutes: number;
  env?: Record<string, string>;
}

export interface PreviewDeployment {
  id: string;
  url: string;
  port: number;
  expiresAt: string;
}

/**
 * TASK-1228: everything the harness needs from a preview host, behind one port.
 * The default implementation talks to a remote machine over ssh; tests inject a
 * fake, so the orchestration is verifiable without a host (option 3 of the
 * design: harness side first, machine decision later).
 */
export interface PreviewHostClient {
  deploy(request: PreviewDeployRequest): Promise<PreviewDeployment>;
  stop(id: string): Promise<void>;
  list(): Promise<{ id: string; port: number }[]>;
}

export interface SshPreviewHostClientOptions {
  host: string;
  sshKey?: string;
  /** Base image the preview container starts from. */
  baseImage?: string;
  /** Where bundles land on the host. */
  bundleDir?: string;
  /** Seconds a deploy may take before it is considered failed. */
  timeoutSeconds?: number;
}

export class SshPreviewHostClient implements PreviewHostClient {
  private readonly host: string;
  private readonly sshKey: string | undefined;
  private readonly baseImage: string;
  private readonly bundleDir: string;
  private readonly timeoutSeconds: number;

  constructor(options: SshPreviewHostClientOptions) {
    this.host = options.host;
    this.sshKey = options.sshKey;
    this.baseImage = options.baseImage ?? "harness/execution:node22";
    this.bundleDir = options.bundleDir ?? "/srv/previews";
    this.timeoutSeconds = options.timeoutSeconds ?? 900;
  }

  async deploy(request: PreviewDeployRequest): Promise<PreviewDeployment> {
    const name = containerName(request.id);
    const bundle = `${this.bundleDir}/${request.id}.tar`;
    await this.run([
      `mkdir -p ${quote(this.bundleDir)} ${quote(`${this.bundleDir}/${request.id}`)}`,
      `tar -xf ${quote(bundle)} -C ${quote(`${this.bundleDir}/${request.id}`)}`,
      `docker rm -f ${quote(name)} >/dev/null 2>&1 || true`,
      [
        "docker run -d",
        `--name ${quote(name)}`,
        `-p ${request.port}:3000`,
        "--memory 512m --cpus 0.5",
        `--env PREVIEW_TOKEN=${quote(request.token)}`,
        ...Object.entries(request.env ?? {}).map(
          ([key, value]) => `--env ${quote(`${key}=${value}`)}`,
        ),
        "--workdir /app",
        `-v ${quote(`${this.bundleDir}/${request.id}`)}:/app`,
        quote(this.baseImage),
        `sh -lc ${quote(request.start)}`,
      ].join(" "),
    ]);
    return {
      id: request.id,
      port: request.port,
      url: `http://${this.host}:${request.port}/${request.token}/`,
      expiresAt: new Date(Date.now() + request.ttlMinutes * 60_000).toISOString(),
    };
  }

  async stop(id: string): Promise<void> {
    await this.run([
      `docker rm -f ${quote(containerName(id))} >/dev/null 2>&1 || true`,
      `rm -rf ${quote(`${this.bundleDir}/${id}`)} ${quote(`${this.bundleDir}/${id}.tar`)}`,
    ]);
  }

  async list(): Promise<{ id: string; port: number }[]> {
    const { stdout } = await this.run([
      "docker ps --filter label=ai-preview=1 --format '{{.Names}} {{.Ports}}'",
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, ports] = line.split(/\s+/);
        const port = Number((ports ?? "").split(":")[1]?.split("-")[0]);
        return { id: (name ?? "").replace(/^ai-preview-/, ""), port };
      })
      .filter((entry) => entry.id.length > 0);
  }

  private async run(commands: string[]): Promise<{ stdout: string }> {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${this.timeoutSeconds}`,
      ...(this.sshKey ? ["-i", this.sshKey] : []),
      this.host,
      commands.join(" && "),
    ];
    const { stdout } = await execFileAsync("ssh", args, {
      timeout: this.timeoutSeconds * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout };
  }
}

export function containerName(id: string): string {
  return `ai-preview-${id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
