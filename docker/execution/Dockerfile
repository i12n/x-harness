# Execution container contract (TASK-911).
#
#   docker build -f docker/execution/Dockerfile \
#     --build-arg BASE_IMAGE=node:22-bookworm-slim \
#     --build-arg RUNTIME=node22 \
#     -t harness/execution:node22 .
#
# Contract the harness relies on:
#   /workspace      only mount point (current Run worktree, rw)
#   /home/agent     writable tmpfs (caches)
#   /tmp            writable tmpfs
#   user            1000:1000 (non-root; rootfs is mounted read-only)
#   entrypoint      long-lived process; the harness drives it via `docker exec`

ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ARG RUNTIME=node22
LABEL org.opencontainers.image.title="harness/execution:${RUNTIME}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex \
    && mkdir -p /workspace /home/agent \
    && (id -u 1000 >/dev/null 2>&1 || useradd --uid 1000 --shell /bin/bash agent) \
    && chown -R 1000:1000 /workspace /home/agent

USER 1000:1000
WORKDIR /workspace

# The container only needs to stay alive; capabilities are dropped and the
# root filesystem is read-only at `docker run` time (see dockerArgs.ts).
ENTRYPOINT ["sleep", "infinity"]
