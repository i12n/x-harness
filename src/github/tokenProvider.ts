import { createSign } from "node:crypto";

/**
 * TASK-1230: how the harness authenticates to GitHub.
 *
 * The client only ever asks for a token, so the choice between a GitHub App
 * (recommended) and a fine-grained PAT is configuration, not code.
 */
export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

/** A fine-grained PAT (or any pre-issued token). Simple, but it expires. */
export class StaticTokenProvider implements GitHubTokenProvider {
  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }
}

export interface AppTokenProviderOptions {
  appId: string;
  /** The App's private key, PEM. Never logged, never sent anywhere. */
  privateKeyPem: string;
  /**
   * The installation to use. Optional: when absent it is discovered from the
   * App's installations (matched by `installationAccount` if given).
   */
  installationId?: string;
  /** Owner login to pick among several installations, e.g. `i12n`. */
  installationAccount?: string;
  /** Override for GitHub Enterprise; defaults to api.github.com. */
  apiBase?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Refresh this many seconds before the token actually expires. */
  refreshSkewSeconds?: number;
  now?: () => Date;
}

/**
 * GitHub App authentication: sign a short-lived JWT with the App key, exchange
 * it for an installation token, and reuse that token until it is near expiry.
 *
 * Why an App over a PAT: the token is issued for ~1 hour and renewed
 * automatically, so an unattended service never dies at a PAT's expiry; the
 * install can be limited to selected repositories; and it can be revoked
 * instantly without touching a person's account.
 */
export class AppTokenProvider implements GitHubTokenProvider {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private installationId: string | undefined;
  private readonly installationAccount: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly skewMs: number;
  private readonly now: () => Date;
  private cached?: { token: string; expiresAtMs: number };
  private inFlight?: Promise<string>;

  constructor(options: AppTokenProviderOptions) {
    this.appId = options.appId;
    this.privateKeyPem = options.privateKeyPem;
    this.installationId = options.installationId;
    this.installationAccount = options.installationAccount;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.skewMs = (options.refreshSkewSeconds ?? 60) * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async getToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.expiresAtMs - this.skewMs > nowMs) {
      return this.cached.token;
    }
    // Concurrent callers share one exchange instead of racing for a new token.
    this.inFlight ??= this.exchange(nowMs).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Exposed for tests: the JWT that authenticates the exchange. */
  signAppJwt(nowMs: number = this.now().getTime()): string {
    const iat = Math.floor(nowMs / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat, exp: iat + 600, iss: this.appId }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(this.privateKeyPem).toString("base64url")}`;
  }

  private async exchange(nowMs: number): Promise<string> {
    const installationId = await this.resolveInstallationId();
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.signAppJwt(nowMs)}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const text = await response.text();
    if (!response.ok) {
      // Prefer GitHub's own message over the raw JSON envelope.
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") {
          detail = parsed.message;
        }
      } catch {
        // keep the raw text
      }
      throw new Error(
        `GitHub App token exchange → ${response.status} ${detail}`.trim(),
      );
    }
    const body = JSON.parse(text) as { token?: unknown; expires_at?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    const expiresAtMs = Date.parse(String(body.expires_at ?? ""));
    if (!token || !Number.isFinite(expiresAtMs)) {
      throw new Error("GitHub App token exchange returned no usable token");
    }
    this.cached = { token, expiresAtMs };
    return token;
  }

  /**
   * Installation ids are not visible in the App settings and are easy to
   * mis-copy; when the caller did not pin one, ask the API. Cached after the
   * first lookup — an installation cannot move between accounts.
   */
  private async resolveInstallationId(): Promise<string> {
    if (this.installationId) {
      return this.installationId;
    }
    const response = await this.fetchImpl(`${this.apiBase}/app/installations`, {
      headers: {
        Authorization: `Bearer ${this.signAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub App installations → ${response.status} ${text.slice(0, 200)}`.trim());
    }
    const all = JSON.parse(text) as unknown;
    const rows = Array.isArray(all) ? all : [];
    const accounts = rows
      .map((row) => (row as { account?: { login?: unknown } }).account?.login)
      .filter((login): login is string => typeof login === "string");
    if (rows.length === 0) {
      throw new Error(
        "GitHub App 还没有安装到任何账号 —— 请在 GitHub 上安装它，或提供 AI_GITHUB_APP_INSTALLATION_ID",
      );
    }
    const wanted = this.installationAccount?.toLowerCase();
    const chosen = wanted
      ? rows.find(
          (row) =>
            String((row as { account?: { login?: unknown } }).account?.login ?? "").toLowerCase() ===
            wanted,
        )
      : rows.length === 1
        ? rows[0]
        : undefined;
    if (!chosen) {
      throw new Error(
        `App 装在多个账号（${accounts.join(", ")}）—— 请指定 AI_GITHUB_APP_ACCOUNT 或 AI_GITHUB_APP_INSTALLATION_ID`,
      );
    }
    this.installationId = String((chosen as { id?: unknown }).id ?? "");
    if (!this.installationId) {
      throw new Error("GitHub App installation 缺少 id");
    }
    return this.installationId;
  }
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
