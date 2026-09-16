# Allow-list forward proxy used for `network.mode=restricted` (TASK-905).
#
#   docker build -f docker/proxy/Dockerfile -t harness/execution-proxy:latest .

FROM node:22-bookworm-slim

COPY server.mjs /server.mjs

USER node
EXPOSE 3128

ENTRYPOINT ["node", "/server.mjs"]
