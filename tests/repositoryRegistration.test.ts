import { describe, expect, it } from "vitest";
import { buildRepository } from "../src/domain/repository.js";
import {
  assertAllowedRepositoryUrl,
  deriveRepositoryName,
  inferReposDir,
  RepositoryRegistrationError,
} from "../src/repository/application/register.js";

describe("deriveRepositoryName", () => {
  it("reads the name off any clone url shape", () => {
    expect(deriveRepositoryName("git@github.com:i12n/x-music.git")).toBe("x-music");
    expect(deriveRepositoryName("https://github.com/i12n/x-login.git")).toBe("x-login");
    expect(deriveRepositoryName("file:///srv/repos/demo-origin.git")).toBe("demo-origin");
    expect(deriveRepositoryName("https://github.com/i12n/x-abc")).toBe("x-abc");
  });
});

describe("assertAllowedRepositoryUrl", () => {
  it("accepts the transports the deploy doc uses", () => {
    for (const url of [
      "git@github.com:i12n/x-music.git",
      "https://github.com/i12n/x-music.git",
      "ssh://git@github.com/i12n/x-music.git",
      "file:///srv/repos/demo-origin.git",
    ]) {
      expect(assertAllowedRepositoryUrl(url)).toBe(url);
    }
  });

  it("refuses anything git would read as a different transport", () => {
    for (const url of ["ftp://example.com/x.git", "ext::sh -c 'touch /tmp/pwn'", "not a url"]) {
      expect(() => assertAllowedRepositoryUrl(url)).toThrow();
    }
    expect(() => assertAllowedRepositoryUrl("ftp://example.com/x.git")).toThrow(
      RepositoryRegistrationError,
    );
  });
});

describe("inferReposDir", () => {
  const repository = (id: string, localPath: string) =>
    buildRepository({ id, name: id, url: "git@github.com:i12n/x.git", localPath });

  it("picks the parent the registered checkouts share", () => {
    expect(
      inferReposDir([repository("repo-a", "/srv/repos/a"), repository("repo-b", "/srv/repos/b")]),
    ).toBe("/srv/repos");
  });

  it("returns undefined when nothing is registered", () => {
    expect(inferReposDir([])).toBeUndefined();
  });
});
