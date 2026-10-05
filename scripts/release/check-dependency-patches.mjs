import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const braces = require("braces");
assert.equal(require("braces/package.json").version, "3.0.3");
assert.match(
  readFileSync(require.resolve("braces/lib/parse"), "utf8"),
  /if \(stack\.length > 64\)/u,
);
for (const [open, close] of [
  ["{", "}"],
  ["(", ")"],
]) {
  const malicious = open.repeat(4000) + "a,b" + close.repeat(4000);
  for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify])
    assert.throws(() => operation(malicious), {
      name: "SyntaxError",
      message: "Brace pattern nesting exceeds 64 levels",
    });
}
assert.deepEqual(braces.expand("src/{one,two}/*.ts"), ["src/one/*.ts", "src/two/*.ts"]);
process.stdout.write(
  "Verified local mitigation for GHSA-vfj7-8cjw-p6xm (upstream braces 3.0.3 remains advisory-listed). See SECURITY.md.\n",
);
