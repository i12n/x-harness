/** Hostname allow-list matching shared by the proxy spec and unit tests. */

export function parseAllowList(value: string | string[] | undefined): string[] {
  const entries = Array.isArray(value) ? value : (value ?? "").split(",");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const host = entry.trim().toLowerCase().replace(/\.$/, "");
    if (host && !seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  }
  return result;
}

/** `github.com` matches github.com and *.github.com, but not evilgithub.com. */
export function isHostAllowed(host: string, allowList: string[]): boolean {
  const candidate = host.trim().toLowerCase().replace(/\.$/, "");
  if (!candidate) {
    return false;
  }
  return allowList.some(
    (entry) => candidate === entry || candidate.endsWith(`.${entry}`),
  );
}
