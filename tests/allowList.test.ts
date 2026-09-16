import { describe, expect, it } from "vitest";
import { isHostAllowed, parseAllowList } from "../src/execution/allowList.js";

describe("allow-list matching (TASK-905)", () => {
  it("parses, lowercases and dedupes entries", () => {
    expect(parseAllowList(" GitHub.com , registry.npmjs.org ,github.com,  ")).toEqual([
      "github.com",
      "registry.npmjs.org",
    ]);
    expect(parseAllowList(["api.github.com"])).toEqual(["api.github.com"]);
    expect(parseAllowList(undefined)).toEqual([]);
  });

  it("matches exact hosts and subdomains, never lookalikes", () => {
    const allow = parseAllowList("github.com,registry.npmjs.org");
    expect(isHostAllowed("github.com", allow)).toBe(true);
    expect(isHostAllowed("api.github.com", allow)).toBe(true);
    expect(isHostAllowed("GitHub.com.", allow)).toBe(true);
    expect(isHostAllowed("evilgithub.com", allow)).toBe(false);
    expect(isHostAllowed("github.com.evil.example", allow)).toBe(false);
    expect(isHostAllowed("1.1.1.1", allow)).toBe(false);
    expect(isHostAllowed("", allow)).toBe(false);
  });
});
