import process from "node:process";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPty } from "../../test-support/terminal/pty.ts";
import { sha256 } from "./manifest.ts";
import { shellLiteral } from "./preview-launchers.ts";
import { bootstrapScript } from "./preview-publish.ts";

assert.notEqual(process.platform, "win32", "This probe exercises the POSIX bootstrap");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-wizard-")));
const password = "synthetic-wizard-password";
try {
  const entry = join(scratch, "wizard.ts");
  const moduleUrl = resolve("scripts/release/preview-terminal.boundary.ts");
  writeFileSync(
    entry,
    `import {serverQuestions} from ${JSON.stringify(moduleUrl)};
const result = await serverQuestions();
if (result.answers.center !== "Synthetic school" || result.password !== ${JSON.stringify(password)}) throw new Error("Wrong wizard answers");
console.log("WIZARD_COMPLETE");
`,
  );
  const executable = join(scratch, "marea-install");
  execFileSync("bun", ["build", entry, "--compile", "--outfile", executable], { stdio: "pipe" });
  writeFileSync(join(scratch, "cosign"), "signature-tool-fixture\n");
  const files = ["marea-install", "cosign"].map((path) => ({
    path,
    executable: true,
    sha256: sha256(readFileSync(join(scratch, path))),
  }));
  // Replace only network transport; execute the actual generated bootstrap, hashes and compiled questions.
  writeFileSync(
    join(scratch, "curl"),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; destination="$1" ;;
  esac
  shift
done
case "$url" in
${files.map((file) => `  */sha256-${file.sha256}) cp ${shellLiteral(join(scratch, file.path))} "$destination" ;;`).join("\n")}
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  const bootstrap = join(scratch, "install.sh");
  writeFileSync(
    bootstrap,
    bootstrapScript(
      "example/marea",
      "0.1.0-preview.1",
      [
        {
          component: "server",
          target: `${process.platform}-${process.arch}`,
          files,
        },
      ],
      false,
    ),
  );
  const environment = { ...process.env, PATH: `${scratch}:${process.env.PATH}` };
  const answers = [
    ["Nombre del centro", "Synthetic school"],
    ["Primera clase", ""],
    ["Nombre del profesor", "Teacher"],
    ["Usuario del profesor", ""],
    ["Contraseña del profesor: ", password],
    ["Repite la contraseña: ", password],
    ["Puerto local", ""],
    ["Dirección pública del servidor", ""],
    ["¿Configurar Google Workspace?", "n"],
  ];
  for (const scenario of ["pipe", "direct", "cancel-name", "cancel-password"]) {
    const terminal = spawnPty({
      command: "/bin/sh",
      arguments: [
        "-c",
        scenario === "direct"
          ? `sh ${shellLiteral(bootstrap)} server`
          : `cat ${shellLiteral(bootstrap)} | sh -s -- server`,
      ],
      currentDirectory: scratch,
      environment,
    });
    try {
      let cancelled = false;
      for (const [prompt, answer] of answers) {
        await terminal.waitForText(prompt);
        if (
          (scenario === "cancel-name" && prompt === answers[0][0]) ||
          (scenario === "cancel-password" && prompt === answers[4][0])
        ) {
          terminal.write("\u0003");
          cancelled = true;
          break;
        }
        terminal.write(`${answer}\r`);
      }
      const result = await terminal.waitForExit();
      if (cancelled) assert.notEqual(result.exitCode, 0);
      else {
        assert.equal(result.exitCode, 0, terminal.transcript());
        assert.ok(terminal.transcript().includes("WIZARD_COMPLETE"));
      }
      assert.ok(!terminal.transcript().includes(password), "Passwords must never be echoed");
      process.stdout.write(`Wizard ${scenario}: passed.\n`);
    } finally {
      terminal.kill();
    }
  }
  const headless = spawnSync("sh", [bootstrap, "server"], { env: environment, encoding: "utf8" });
  assert.equal(headless.status, 1);
  assert.match(headless.stderr, /Installation needs an interactive terminal/u);
  process.stdout.write("Headless bootstrap fails clearly instead of blocking.\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
