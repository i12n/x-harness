// Verification command for the sample task: greet(name) must exist.
const assert = require("node:assert");
const { greet } = require("../src/index.js");

assert.strictEqual(typeof greet, "function", "greet must be a function");
assert.strictEqual(greet("Ada"), "Hello, Ada!");
assert.strictEqual(greet("Harness"), "Hello, Harness!");

console.log("ok");
