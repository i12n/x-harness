import { describe, expect, it } from "vitest";
import {
  detectCommands,
  detectCommandsFromDirectory,
  mergeDetectedCommands,
} from "../src/repository/application/commandDetection.js";

const NODE_PACKAGE = { scripts: { build: "next build", test: "vitest run" } };

describe("execution command detection", () => {
  it("derives npm commands from a package.json", () => {
    expect(detectCommands({ packageJson: NODE_PACKAGE, files: ["package.json"] })).toEqual({
      install: "npm ci",
      build: "npm run build",
      test: "npm test",
      verify: "npm test",
    });
  });

  it("picks the package manager from the lockfile", () => {
    expect(
      detectCommands({ packageJson: NODE_PACKAGE, files: ["pnpm-lock.yaml"] }).install,
    ).toBe("pnpm install --frozen-lockfile");
    expect(detectCommands({ packageJson: NODE_PACKAGE, files: ["yarn.lock"] }).install).toBe(
      "yarn install --frozen-lockfile",
    );
    expect(
      detectCommands({ packageJson: NODE_PACKAGE, files: ["package-lock.json"] }).install,
    ).toBe("npm ci");
  });

  it("only proposes what the repository actually has", () => {
    const detected = detectCommands({
      packageJson: { scripts: { start: "next start" } },
      files: ["package.json"],
    });
    expect(detected).toEqual({ install: "npm ci", note: expect.any(String) });
  });

  it("says so when there is nothing to detect", () => {
    const detected = detectCommands({ files: ["README.md"] });
    expect(detected.note).toContain("未识别到 Node 工程");
    expect(detected.install).toBeUndefined();
  });

  it("never overwrites an explicit configuration", () => {
    expect(
      mergeDetectedCommands(
        { install: "pnpm i", build: "make", screenshot: "shot.sh" },
        { install: "npm ci", build: "npm run build", test: "npm test" },
      ),
    ).toEqual({
      install: "pnpm i",
      build: "make",
      test: "npm test",
      screenshot: "shot.sh",
    });
  });

  it("reads a real directory without throwing", async () => {
    const detected = await detectCommandsFromDirectory("/definitely/not/here");
    expect(detected.note).toContain("无法从");
  });
});
