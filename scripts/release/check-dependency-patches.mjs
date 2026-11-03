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
assert.equal(require("zod/package.json").version, "4.6.7");
for (const z of [require("zod"), require("zod/v4"), await import("zod"), await import("zod/v4")]) {
  for (const jitless of [false, true]) {
    const text = "😀".repeat(6);
    const schema = z.object({
      minimum: z.string().min(12),
      maximum: z.string().max(12),
      exact: z.string().length(12),
    });
    const valid = { minimum: text, maximum: text, exact: text };
    assert.deepEqual(schema.parse(valid, { jitless }), valid);
    for (const patch of [
      { minimum: "😀".repeat(5) },
      { maximum: "😀".repeat(7) },
      { exact: "😀".repeat(7) },
    ])
      assert.equal(schema.safeParse({ ...valid, ...patch }, { jitless }).success, false);
    let visited = 0;
    const element = z.preprocess((value) => {
      visited++;
      return value;
    }, z.string());
    const collection = z.array(element).max(1);
    assert.equal(collection.safeParse([1, 2], { jitless }).error.issues.length, 1);
    assert.equal(visited, 0);
    assert.deepEqual(collection.parse(["valid"], { jitless }), ["valid"]);
  }
}
process.stdout.write(
  "Verified local mitigation for GHSA-vfj7-8cjw-p6xm (upstream braces 3.0.3 remains advisory-listed). See SECURITY.md.\n",
);
process.stdout.write(
  "Verified Zod collection security bounds and protocol 0.1 UTF-16 compatibility in ESM, CommonJS and both parser modes.\n",
);
