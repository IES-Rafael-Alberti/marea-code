import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnPty } from "../../test-support/terminal/pty.ts";
import { previewVersion, repositoryName } from "./preview-channel.ts";
import { shellLiteral } from "./preview-launchers.ts";

// Public transport, signed downloads and real executables; all state is disposable.
const version = previewVersion.parse(process.argv[2]);
const repository = repositoryName.parse(process.argv[3]);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-published-reinstall-")));
const home = join(scratch, "home");
mkdirSync(home, { mode: 0o700 });
const root = join(home, ".marea-preview", "server");
const launcher = join(root, "bin", "marea-teacher");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  SHELL: "/bin/sh",
  MAREA_SERVER_URL: "",
  MAREA_STATE_HOME: "",
};
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const origin = `http://127.0.0.1:${port}`;
const url = `https://github.com/${repository}/releases/download/v${version}/install.sh`;
const project = join(home, "project.txt");
writeFileSync(project, "keep student work");

function terminal(command, args) {
  return spawnPty({ command, arguments: args, currentDirectory: scratch, environment });
}

async function install(login, retained) {
  const pty = terminal("/bin/sh", [
    "-c",
    `curl -fsSL ${shellLiteral(url)} | sh -s -- server --version ${shellLiteral(version)}`,
  ]);
  const password = `synthetic-${login}-password`;
  try {
    if (retained !== undefined) {
      await pty.waitForText("¿Empezar de cero? Escribe BORRAR", 120000);
      assert.ok(pty.transcript().includes("Esta acción es irreversible."));
      pty.write(`${retained}\r`);
      if (retained !== "BORRAR") {
        assert.equal((await pty.waitForExit()).exitCode, 0);
        assert.ok(pty.transcript().includes("Instalación cancelada."));
        assert.ok(!pty.transcript().includes("Nombre del centro"));
        return;
      }
    }
    for (const [prompt, answer] of [
      ["Nombre del centro", `Synthetic school ${login}`],
      ["Primera clase", ""],
      ["Nombre del profesor", "Synthetic teacher"],
      ["Usuario del profesor", login],
      ["Contraseña del profesor: ", password],
      ["Repite la contraseña: ", password],
      ["Puerto local", String(port)],
      ["Dirección pública del servidor", ""],
      ["¿Configurar Google Workspace?", "n"],
    ]) {
      await pty.waitForText(prompt, 120000);
      pty.write(`${answer}\r`);
      await pty.waitForQuiet();
    }
    await pty.waitForText("Instalado:", 600000);
    assert.equal((await pty.waitForExit()).exitCode, 0, pty.transcript().slice(-2000));
    for (const stage of ["Verificando la firma", "MiB recibidos en total", "Creando el centro"])
      assert.ok(pty.transcript().includes(stage));
    assert.ok(!pty.transcript().includes(password));
    assert.ok(!pty.transcript().includes("/$bunfs/"));
  } finally {
    pty.kill();
  }
}

async function loginToServer(login, obsoleteLogin) {
  const host = terminal(launcher, ["--allow-http"]);
  try {
    await host.waitForText(`Teacher host ready at http://0.0.0.0:${port}`, 120000);
    for (const user of [login, obsoleteLogin].filter(Boolean)) {
      const response = await globalThis.fetch(`${origin}/api/v1/dashboard/session/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:reinstall-login",
          credentials: { login: user, password: `synthetic-${user}-password` },
        }),
      });
      assert.equal(response.status, user === login ? 200 : 401);
      await response.arrayBuffer();
    }
    host.write("\u0003");
    assert.equal((await host.waitForExit(30000)).exitCode, 0, host.transcript().slice(-2000));
  } finally {
    host.kill();
  }
}

async function installStudent() {
  const pty = terminal("/bin/sh", [
    "-c",
    `curl -fsSL ${shellLiteral(url)} | sh -s -- student --version ${shellLiteral(version)} --server ${shellLiteral(origin)}`,
  ]);
  const studentRoot = join(home, ".marea-preview", "student");
  const student = join(studentRoot, "bin", "marea");
  try {
    await pty.waitForText("Instalado:", 600000);
    assert.equal((await pty.waitForExit()).exitCode, 0, pty.transcript().slice(-2000));
    const installed = spawnSync(student, ["--version"], {
      env: environment,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim(), version);
    const removed = spawnSync(student, ["uninstall", "--yes"], {
      env: environment,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(studentRoot), false);
    assert.equal(readFileSync(project, "utf8"), "keep student work");
    process.stdout.write(
      "Public student HTTP installation, native executable and clean uninstall passed.\n",
    );
  } finally {
    pty.kill();
  }
}

try {
  await install("firstteacher");
  const installed = spawnSync(launcher, ["--version"], { env: environment, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout.trim(), version);
  await loginToServer("firstteacher");
  await installStudent();
  process.stdout.write("Public fresh install and teacher login passed.\n");
  const removed = spawnSync(launcher, ["uninstall", "--yes"], {
    env: environment,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(readdirSync(root), ["installation"]);
  process.stdout.write("Default uninstall retained only center data.\n");
  const database = join(root, "installation", "marea.sqlite");
  const before = readFileSync(database);
  await install("unused", "");
  assert.deepEqual(
    readFileSync(database),
    before,
    "Cancelling reinstall must preserve the database",
  );
  process.stdout.write("Cancelled reinstall preserved the database.\n");
  await install("secondteacher", "BORRAR");
  await loginToServer("secondteacher", "firstteacher");
  process.stdout.write("Explicit fresh reinstall accepts only the new teacher credentials.\n");
  const uninstall = terminal(launcher, ["uninstall"]);
  try {
    await uninstall.waitForText("¿Borrar también los datos, credenciales y copias del centro?");
    uninstall.write("s\r");
    await uninstall.waitForText("¿Desinstalar Marea? Escribe DESINSTALAR");
    uninstall.write("DESINSTALAR\r");
    assert.equal((await uninstall.waitForExit(120000)).exitCode, 0, uninstall.transcript());
  } finally {
    uninstall.kill();
  }
  assert.equal(existsSync(root), false, "Complete uninstall must leave no managed data");
  assert.equal(readFileSync(project, "utf8"), "keep student work");
  process.stdout.write(
    `Published ${version}: fresh install, preserved uninstall, cancelled reinstall, explicit fresh reinstall, new credentials and complete interactive uninstall passed.\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
