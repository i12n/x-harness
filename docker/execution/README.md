# Execution images (TASK-911 contract)

The harness never bakes runtime details into the core: a Repository carries an
`executionProfile` (`image`, `workspace`, `commands`, `network`, `resources`,
`policy`, `secrets`) and the Worker mounts only the current Run worktree.

Contract every image must satisfy (enforced by
`src/execution/contract.ts`, hard violations abort container start):

| Concern | Contract |
| --- | --- |
| workspace | `/workspace` (or a subdirectory of it); the only host mount |
| home | `/home/agent`, writable tmpfs |
| tmp | `/tmp`, writable tmpfs |
| user | `1000:1000` (non-root) |
| rootfs | read-only at run time |
| entrypoint | long-lived; driven via `docker exec` |
| image name | recommended `harness/execution:<runtime>` |

Example profiles:

```yaml
name: frontend-node
image: harness/execution:node22
workspace: /workspace
commands: { install: pnpm install, test: pnpm test, build: pnpm build }

name: backend-java
image: harness/execution:java21
workspace: /workspace
commands: { test: ./gradlew test, build: ./gradlew build }
```

Build the template image (requires Docker on the target host):

```bash
docker build -f docker/execution/Dockerfile \
  --build-arg BASE_IMAGE=node:22-bookworm-slim \
  --build-arg RUNTIME=node22 \
  -t harness/execution:node22 .
```
