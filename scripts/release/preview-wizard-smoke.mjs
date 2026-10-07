import process from "node:process";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const cliUrl = resolve("scripts/release/installer-cli.boundary.ts");
  const existingUrl = resolve("scripts/release/preview-existing.boundary.ts");
  writeFileSync(
    entry,
    `import {serverQuestions} from ${JSON.stringify(moduleUrl)};
import {installerExitCode} from ${JSON.stringify(cliUrl)};
import {preparePreviewRoot} from ${JSON.stringify(existingUrl)};
process.exitCode = await installerExitCode(async () => {
if (!(await preparePreviewRoot(process.argv.at(-1), "server"))) return;
const result = await serverQuestions();
if (result.answers.center !== "Synthetic school" || result.password !== ${JSON.stringify(password)}) throw new Error("Wrong wizard answers");
console.log("WIZARD_COMPLETE");
});
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
  const environment = { ...process.env, HOME: scratch, PATH: `${scratch}:${process.env.PATH}` };
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
  for (const scenario of [
    "pipe",
    "direct",
    "retry",
    "cancel-name",
    "cancel-password",
    "cancel-retry",
    "retained-cancel",
    "retained-reset",
  ]) {
    const root = join(scratch, `managed-${scenario}`);
    const retainedData = join(root, "installation", "data");
    if (scenario.startsWith("retained-")) {
      for (const path of [root, join(root, "installation"), join(root, "installation", "locks")])
        mkdirSync(path, { mode: 0o700 });
      writeFileSync(retainedData, "retained school data", { mode: 0o600 });
    }
    const terminal = spawnPty({
      command: "/bin/sh",
      arguments: [
        "-c",
        scenario === "direct"
          ? `sh ${shellLiteral(bootstrap)} server --root ${shellLiteral(root)}`
          : `cat ${shellLiteral(bootstrap)} | sh -s -- server --root ${shellLiteral(root)}`,
      ],
      currentDirectory: scratch,
      environment,
    });
    try {
      if (scenario.startsWith("retained-")) {
        await terminal.waitForText("¿Empezar de cero? Escribe BORRAR");
        assert.ok(terminal.transcript().includes("Esta acción es irreversible."));
        terminal.write(scenario === "retained-cancel" ? "\r" : "BORRAR\r");
        if (scenario === "retained-cancel") {
          assert.equal((await terminal.waitForExit()).exitCode, 0);
          assert.equal(readFileSync(retainedData, "utf8"), "retained school data");
          assert.ok(terminal.transcript().includes("Instalación cancelada."));
          assert.ok(!terminal.transcript().includes("Nombre del centro"));
          process.stdout.write("Wizard retained-cancel: passed.\n");
          continue;
        }
      }
      let cancelled = false;
      for (const [prompt, answer] of answers) {
        await terminal.waitForText(prompt);
        if ((scenario === "retry" || scenario === "cancel-retry") && prompt === answers[4][0]) {
          // Wait for each fresh prompt, not an earlier occurrence in the transcript.
          const retry = async (value) => {
            const before = terminal.transcript();
            terminal.write(`${value}\r`);
            await terminal.waitForQuiet();
            assert.ok(terminal.transcript().slice(before.length).includes("Contraseña no válida:"));
            assert.ok(terminal.transcript().slice(before.length).includes(prompt));
          };
          await retry("tiny");
          if (scenario === "cancel-retry") {
            terminal.write("\u0003");
            cancelled = true;
            break;
          }
          await retry("");
          await retry("x".repeat(257));
          terminal.write(`${password}\r`);
          await terminal.waitForText("Repite la contraseña: ");
          terminal.write("different-valid-password\r");
          await terminal.waitForText("Las contraseñas no coinciden.");
          await terminal.waitForQuiet();
        }
        if (
          (scenario === "cancel-name" && prompt === answers[0][0]) ||
          (scenario === "cancel-password" && prompt === answers[4][0])
        ) {
          terminal.write("\u0003");
          cancelled = true;
          break;
        }
        terminal.write(`${answer}\r`);
        await terminal.waitForQuiet();
      }
      const result = await terminal.waitForExit();
      if (cancelled) {
        assert.notEqual(result.exitCode, 0);
        if (scenario !== "cancel-name") {
          assert.equal(result.exitCode, 130);
          assert.ok(terminal.transcript().includes("Operación cancelada."));
        }
      } else {
        assert.equal(result.exitCode, 0, terminal.transcript());
        assert.ok(terminal.transcript().includes("WIZARD_COMPLETE"));
        assert.equal(existsSync(retainedData), false);
      }
      assert.ok(!terminal.transcript().includes(password), "Passwords must never be echoed");
      assert.ok(!terminal.transcript().includes("different-valid-password"));
      assert.ok(!terminal.transcript().includes("tiny"));
      assert.ok(!terminal.transcript().includes("x".repeat(257)));
      assert.ok(!terminal.transcript().includes("OperatorCliError"));
      assert.ok(!terminal.transcript().includes("/$bunfs/"));
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
