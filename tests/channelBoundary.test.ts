import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function filesUnder(dir: string, extension = ".ts"): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...filesUnder(full, extension));
    } else if (full.endsWith(extension)) {
      result.push(full);
    }
  }
  return result;
}

describe("Channel boundary (TASK-1101)", () => {
  it("channels never import Harness business modules", () => {
    const businessImport = /from\s+"\.\.\/(domain|store|worker|loop|scheduler|verification|execution|workspace|agent|problem|config)\//;
    for (const file of filesUnder(join(SRC, "channel"))) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not import Harness business modules`).not.toMatch(
        businessImport,
      );
    }
  });

  it("the Harness core never imports channels", () => {
    const coreDirs = [
      "domain",
      "store",
      "worker",
      "loop",
      "scheduler",
      "verification",
      "execution",
      "workspace",
      "agent",
      "problem",
      "config",
      "util",
    ];
    for (const dir of coreDirs) {
      const dirPath = join(SRC, dir);
      for (const file of filesUnder(dirPath)) {
        const source = readFileSync(file, "utf8");
        expect(source, `${file} must not import channels`).not.toMatch(
          /from\s+"[^"]*\/channel\//,
        );
      }
    }
  });
});
