// Dependency-free "lint" check for the generic fixture.
//
// It intentionally implements a handful of structural rules with Node built-ins
// only: the fixture must stay offline and installable with zero packages, while
// still giving Phase 12 a real first verification check to aggregate.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const problems = [];

for (const file of collectJavaScriptFiles(path.join(root, "src"))) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  if (!source.endsWith("\n")) {
    problems.push(`${relative}: file must end with a newline`);
  }
  source.split("\n").forEach((line, index) => {
    if (/\s+$/.test(line)) {
      problems.push(`${relative}:${index + 1}: trailing whitespace`);
    }
    if (/^\s*var\s/.test(line)) {
      problems.push(`${relative}:${index + 1}: use let/const instead of var`);
    }
  });
}

if (problems.length > 0) {
  console.error(`lint failed: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log("lint ok");

function collectJavaScriptFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectJavaScriptFiles(full));
    } else if (entry.name.endsWith(".js")) {
      result.push(full);
    }
  }
  return result.sort();
}
