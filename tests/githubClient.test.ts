import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpGitHubClient } from "../src/github/httpGithubClient.js";
import { AppTokenProvider, StaticTokenProvider } from "../src/github/tokenProvider.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
  };
}

describe("GitHub App tokens (TASK-1230)", () => {
  it("signs an RS256 JWT with the app id as issuer", () => {
    const provider = new AppTokenProvider({
      appId: "12345",
      privateKeyPem: privateKey,
      installationId: "678",
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    const { header, payload } = decodeJwt(provider.signAppJwt(Date.parse("2026-10-08T00:00:00Z")));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(Number(payload.exp)).toBeGreaterThan(Number(payload.iat));
  });

  it("exchanges the JWT once and reuses the installation token", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      calls.push(`auth=${(init?.headers as Record<string, string>).Authorization}`);
      return jsonResponse({
        token: "ghs_installation",
        expires_at: "2026-10-08T01:00:00Z",
      });
    }) as unknown as typeof fetch;
    const provider = new AppTokenProvider({
      appId: "12345",
      privateKeyPem: privateKey,
      installationId: "678",
      fetch: fetchImpl,
      now: () => new Date("2026-10-08T00:00:00Z"),
    });

    expect(await provider.getToken()).toBe("ghs_installation");
    expect(await provider.getToken()).toBe("ghs_installation");
    const exchanges = calls.filter((line) => line.startsWith("POST"));
    expect(exchanges).toEqual([
      "POST https://api.github.com/app/installations/678/access_tokens",
    ]);
    expect(calls.some((line) => line.startsWith("auth=Bearer ey"))).toBe(true);
  });

  it("refreshes before the token expires", async () => {
    let nowMs = Date.parse("2026-10-08T00:00:00Z");
    let exchanges = 0;
    const provider = new AppTokenProvider({
      appId: "1",
      privateKeyPem: privateKey,
      installationId: "2",
      fetch: (async () => {
        exchanges += 1;
        return jsonResponse({
          token: `ghs_${exchanges}`,
          expires_at: new Date(nowMs + 3600_000).toISOString(),
        });
      }) as unknown as typeof fetch,
      now: () => new Date(nowMs),
    });

    expect(await provider.getToken()).toBe("ghs_1");
    nowMs += 3600_000; // an hour later: the cached token is done
    expect(await provider.getToken()).toBe("ghs_2");
    expect(exchanges).toBe(2);
  });

  it("surfaces a failed exchange instead of returning nothing", async () => {
    const provider = new AppTokenProvider({
      appId: "1",
      privateKeyPem: privateKey,
      installationId: "2",
      fetch: (async () => jsonResponse({ message: "Bad credentials" }, 401)) as unknown as typeof fetch,
    });
    await expect(provider.getToken()).rejects.toThrow(/401 Bad credentials/);
  });

  it("keeps a plain token working through the same interface", async () => {
    expect(await new StaticTokenProvider("ghp_x").getToken()).toBe("ghp_x");
  });

  // TASK-1230: the installation id is not visible in App settings, so the
  // provider discovers it instead of making the operator copy a number.
  it("discovers the only installation when none was configured", async () => {
    const calls: string[] = [];
    const provider = new AppTokenProvider({
      appId: "5231259",
      privateKeyPem: privateKey,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/app/installations")) {
          return jsonResponse([{ id: 98765, account: { login: "i12n" } }]);
        }
        return jsonResponse({ token: "ghs_x", expires_at: "2026-10-08T01:00:00Z" });
      }) as unknown as typeof fetch,
    });

    expect(await provider.getToken()).toBe("ghs_x");
    expect(calls).toEqual([
      "GET https://api.github.com/app/installations",
      "POST https://api.github.com/app/installations/98765/access_tokens",
    ]);
  });

  it("picks the right account when the App is installed more than once", async () => {
    let tokenUrl = "";
    const provider = new AppTokenProvider({
      appId: "1",
      privateKeyPem: privateKey,
      installationAccount: "i12n",
      fetch: (async (url: string) => {
        if (url.endsWith("/app/installations")) {
          return jsonResponse([
            { id: 1, account: { login: "someone-else" } },
            { id: 2, account: { login: "i12n" } },
          ]);
        }
        tokenUrl = url;
        return jsonResponse({ token: "ghs_x", expires_at: "2026-10-08T01:00:00Z" });
      }) as unknown as typeof fetch,
    });

    await provider.getToken();
    expect(tokenUrl).toContain("/app/installations/2/access_tokens");
  });

  it("says the App is not installed instead of failing obscurely", async () => {
    const provider = new AppTokenProvider({
      appId: "1",
      privateKeyPem: privateKey,
      fetch: (async () => jsonResponse([])) as unknown as typeof fetch,
    });
    await expect(provider.getToken()).rejects.toThrow(/还没有安装/);
  });

  it("does not look up installations when an id was given", async () => {
    const calls: string[] = [];
    const provider = new AppTokenProvider({
      appId: "1",
      privateKeyPem: privateKey,
      installationId: "42",
      fetch: (async (url: string) => {
        calls.push(url);
        return jsonResponse({ token: "ghs_x", expires_at: "2026-10-08T01:00:00Z" });
      }) as unknown as typeof fetch,
    });
    await provider.getToken();
    expect(calls).toEqual(["https://api.github.com/app/installations/42/access_tokens"]);
  });
});

describe("GitHub REST client (TASK-1230)", () => {
  it("reads runs for the test branch and reports conclusion", async () => {
    const seen: string[] = [];
    const client = HttpGitHubClient.withToken("ghp_x", {
      fetch: (async (url: string) => {
        seen.push(url);
        return jsonResponse({
          workflow_runs: [
            {
              id: 5,
              name: "deploy-test",
              head_branch: "test/dlv-1",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/i12n/x-music/actions/runs/5",
              created_at: "2026-10-08T00:00:00Z",
            },
          ],
        });
      }) as unknown as typeof fetch,
    });

    const runs = await client.listWorkflowRuns({ repo: "i12n/x-music", branch: "test/dlv-1" });
    expect(runs[0]?.conclusion).toBe("success");
    expect(seen[0]).toContain("/repos/i12n/x-music/actions/runs?branch=test%2Fdlv-1");
  });

  it("opens a PR with the head/base it was given", async () => {
    let body: unknown;
    const client = HttpGitHubClient.withToken("ghp_x", {
      fetch: (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          number: 7,
          html_url: "https://github.com/i12n/x-music/pull/7",
          state: "open",
          head: { ref: "test/dlv-1" },
          base: { ref: "main" },
        });
      }) as unknown as typeof fetch,
    });
    const pr = await client.openPullRequest({
      repo: "i12n/x-music",
      head: "test/dlv-1",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(body).toMatchObject({ head: "test/dlv-1", base: "main" });
    expect(pr.number).toBe(7);
    expect(pr.merged).toBe(false);
  });
});
