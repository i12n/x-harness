// Minimal allow-list forward proxy (HTTP + CONNECT), stdlib only.
//
// A restricted Run container is attached to an --internal network only; this
// proxy is the single egress path and denies every host outside ALLOW_LIST.

import http from "node:http";
import net from "node:net";

const allowList = (process.env.ALLOW_LIST ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
  .filter(Boolean);
const port = Number(process.env.PROXY_PORT ?? 3128);

function isAllowed(host) {
  const candidate = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!candidate) {
    return false;
  }
  return allowList.some(
    (entry) => candidate === entry || candidate.endsWith(`.${entry}`),
  );
}

function deny(response) {
  response.writeHead(403, { "content-type": "text/plain" });
  response.end("blocked by harness allow-list\n");
}

const server = http.createServer((request, response) => {
  let target;
  try {
    target = new URL(request.url);
  } catch {
    response.writeHead(400);
    response.end("bad request\n");
    return;
  }
  if (!isAllowed(target.hostname)) {
    deny(response);
    return;
  }
  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("proxy upstream error\n");
  });
  request.pipe(upstream);
});

server.on("connect", (request, clientSocket, head) => {
  const [host, portText] = request.url.split(":");
  if (!isAllowed(host)) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const upstream = net.connect(Number(portText || 443), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(port, "0.0.0.0", () => {
  console.log(`allow-list proxy listening on ${port} (${allowList.join(",") || "deny all"})`);
});
