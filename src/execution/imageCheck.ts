import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ImageCheckResult {
  ok: boolean;
  /** Actionable explanation; used verbatim when a registration is refused. */
  message: string;
}

/** Throws when the image is not present locally. Injectable for tests. */
export type DockerInspectRunner = (image: string) => Promise<void>;

/**
 * TASK-1217: every Run starts one container from the repository's execution
 * image, but nothing proved that image existed. In production a repository
 * registered without `--exec-image` fell back to `harness/execution:base`,
 * which had never been built, so every attempt failed at container start and
 * the task burned all retries. Check the image while a human is still in the
 * loop — at registration and at service start — instead of mid-Run.
 */
export async function inspectExecutionImage(
  image: string,
  run: DockerInspectRunner,
): Promise<ImageCheckResult> {
  const target = image.trim();
  if (!target) {
    return { ok: false, message: "execution profile has no image" };
  }
  try {
    await run(target);
    return { ok: true, message: `${target} is available locally` };
  } catch (error) {
    return { ok: false, message: missingImageMessage(target, error) };
  }
}

/** Real check: `docker image inspect` against the local daemon. */
export async function checkLocalExecutionImage(
  image: string,
  options: { dockerBinary?: string } = {},
): Promise<ImageCheckResult> {
  const dockerBinary = options.dockerBinary ?? process.env.AI_DOCKER_BIN ?? "docker";
  return inspectExecutionImage(image, async (target) => {
    await execFileAsync(dockerBinary, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      target,
    ]);
  });
}

export type ImageChecker = (image: string) => Promise<ImageCheckResult>;

export function missingImageMessage(image: string, error?: unknown): string {
  const detail =
    error instanceof Error && error.message
      ? `（docker: ${error.message.split(/\r?\n/)[0]}）`
      : "";
  return [
    `执行镜像 ${image} 在本机不存在，Run 会在启动容器时直接失败。`,
    "处理方式：",
    "  1) 构建它（deploy/install.sh 会做）：",
    "     docker build -f docker/execution/Dockerfile \\",
    "       --build-arg BASE_IMAGE=node:22-bookworm-slim --build-arg RUNTIME=node22 \\",
    `       -t ${image} .`,
    "  2) 或注册时改用本机已有的镜像：--exec-image harness/execution:node22",
    "查看本机已有镜像：docker images | grep harness/execution",
    detail,
  ]
    .filter(Boolean)
    .join("\n");
}
