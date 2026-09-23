// Dependency-free "build" check for the generic fixture.
//
// It loads the entry module, asserts the expected public API and writes a small
// artifact under dist/. Node built-ins only — no bundler, no packages.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "src", "index.js");

let loaded;
try {
  loaded = require(entry);
} catch (error) {
  fail(`cannot load src/index.js: ${error.message}`);
}

const exported = Object.keys(loaded ?? {}).sort();
if (!exported.includes("greet")) {
  fail(`expected export 'greet', found [${exported.join(", ") || "(none)"}]`);
}

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "index.json"),
  `${JSON.stringify({ entry: "src/index.js", exports: exported }, null, 2)}\n`,
);

console.log(`build ok (exports: ${exported.join(", ")})`);

function fail(message) {
  console.error(`build failed: ${message}`);
  process.exit(1);
}
