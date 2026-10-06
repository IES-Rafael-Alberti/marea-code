import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

// Disposable CI-only instrumentation. The normal compiled journey must already
// have failed; its result remains the publication gate. No diagnostic binary ships.
const source = resolve("apps/student/src/marea-command.boundary.ts");
const original = readFileSync(source, "utf8");
const diagnostic = join(tmpdir(), `marea-synthetic-client-error-${process.pid}.txt`);
const binary = resolve("reports/windows-smoke/marea-diagnostic.exe");
const anchor =
  '  } catch {\n    options.output.error(`${options.translator.t("student.cli.unexpected-error")}\\n`);';
const normalized = original.replace(/\r\n/g, "\n");
if (!normalized.includes(anchor)) throw new Error("Diagnostic anchor changed");
try {
  const instrumented = `import { appendFileSync as diagnosticAppend } from "node:fs";\n${normalized.replace(anchor, `  } catch (error) {\n    diagnosticAppend(${JSON.stringify(diagnostic)}, String(error instanceof Error ? error.stack : "Unknown failure") + "\\n");\n    options.output.error(\`\${options.translator.t("student.cli.unexpected-error")}\\n\`);`)}`;
  writeFileSync(source, instrumented);
  const build = spawnSync(
    process.execPath,
    ["build", "apps/student/src/marea-entry.boundary.ts", "--compile", "--outfile", binary],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (build.status !== 0) throw new Error("Diagnostic compilation failed");
} finally {
  writeFileSync(source, original);
}
try {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/release/installed-client-smoke.mjs",
      binary,
      "reports/windows-smoke/diagnostic-receipt.json",
    ],
    { stdio: "inherit", timeout: 330_000 },
  );
  console.log("Synthetic diagnostic journey exit:", result.status);
  if (existsSync(diagnostic))
    console.log("Synthetic client exception:", readFileSync(diagnostic, "utf8"));
} finally {
  rmSync(diagnostic, { force: true });
  rmSync(binary, { force: true });
}
