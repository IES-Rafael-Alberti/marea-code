// Connects the built student of a release to the built server of the same release, and then to
// a server announcing another release. Both must report one version everywhere: --version, -v,
// the capabilities request, the server's answer and the dashboard; only the second may prompt.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { securePrivatePath } from "@marea/private-filesystem";
import { provisionServer, scaffoldServer } from "./preview-setup.boundary.ts";
import {
  startCompiledHost,
  stopCompiledHost,
} from "../../apps/teacher-server/smoke/compiled-host-process.ts";

const [studentArgument, serverArgument] = process.argv.slice(2);
if (!studentArgument || !serverArgument)
  throw new Error(
    "Usage: bun scripts/release/version-rehearsal-smoke.mjs <student-candidate> <server-candidate>",
  );
const studentRelease = realpathSync(resolve(studentArgument));
const serverRelease = realpathSync(resolve(serverArgument));
const manifest = (directory) => JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const version = manifest(studentRelease).version;
assert.equal(manifest(studentRelease).component, "student");
assert.equal(manifest(serverRelease).component, "server");
assert.equal(manifest(serverRelease).version, version, "Both candidates must be one release");
assert.match(version, /^\d+\.\d+\.\d+-preview\.\d+$/u);
const otherVersion = version.replace(/\d+$/u, (number) => String(Number(number) + 1000));
const suffix = process.platform === "win32" ? ".exe" : "";
const student = join(studentRelease, `marea${suffix}`);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-version-rehearsal-")));
securePrivatePath(scratch, 0o700);
const root = join(scratch, "installation");
const project = join(scratch, "project");
const notice = "is not the same as the teacher server version";
const signIn = "How would you like to continue?";

async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

function privateTree(directory) {
  securePrivatePath(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) privateTree(path);
    else securePrivatePath(path, 0o600);
  }
}

const runPrivate = (binary, args, input) => {
  const result = spawnSync(binary, args, { input, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `Synthetic setup failed: ${args.slice(2, 4).join(" ")}`);
  return result.stdout;
};

/** Forwards to the server unchanged and records the clientVersion of each capabilities request. */
async function recordingProxy(target) {
  const announced = [];
  const upstream = new URL(target);
  const proxy = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url === "/v1/capabilities")
        announced.push(JSON.parse(body.toString("utf8")).clientVersion);
      const forwarded = httpRequest(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: upstream.host },
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      forwarded.on("error", () => response.destroy());
      forwarded.end(body);
    });
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  return {
    announced,
    origin: `http://127.0.0.1:${String(proxy.address().port)}`,
    close: () => new Promise((done) => proxy.close(done)),
  };
}

/** Starts the student without a terminal; stops it at the sign-in question or when it exits. */
async function startStudent(server, state) {
  const child = spawn(student, ["--lang", "en", "--server", server], {
    cwd: project,
    env: { ...process.env, LANG: "en-US", MAREA_STATE_HOME: state, MAREA_SERVER_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((done) => child.on("exit", (code) => done(code)));
  const collect = (chunk) => {
    output += chunk.toString("utf8");
    if (output.includes(signIn)) child.kill();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await exited;
  clearTimeout(timer);
  return { code, output };
}

async function withServer(serverVersion, check) {
  const hostConfig = join(root, "config/teacher-host.json");
  const config = JSON.parse(readFileSync(hostConfig, "utf8"));
  writeFileSync(hostConfig, JSON.stringify({ ...config, serverVersion }, null, 2), { mode: 0o600 });
  const host = await startCompiledHost(
    join(serverRelease, `marea-teacher${suffix}`),
    root,
    "release:preview",
  );
  const proxy = await recordingProxy(host.origin);
  try {
    const answer = await globalThis.fetch(`${host.origin}/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request:version-rehearsal",
        clientVersion: version,
        supportedProtocolVersions: ["0.1"],
      }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).serverVersion, serverVersion);
    await check(proxy);
  } finally {
    await proxy.close();
    await stopCompiledHost(host);
  }
}

try {
  for (const flag of ["--version", "-v"]) {
    const reported = spawnSync(student, [flag], { encoding: "utf8", timeout: 30_000 });
    assert.equal(reported.status, 0, reported.stderr);
    assert.equal(reported.stdout.trim(), version, `marea ${flag} must report the release`);
  }
  mkdirSync(project);
  spawnSync("git", ["init", "--quiet"], { cwd: project });
  privateTree(join(serverRelease, "dashboard"));
  const port = await freePort();
  const answers = {
    center: "Rehearsal school",
    classroom: "Rehearsal class",
    teacher: "Rehearsal teacher",
    login: "teacher",
    origin: `http://127.0.0.1:${String(port)}`,
    port,
  };
  scaffoldServer(root, serverRelease, version, answers);
  provisionServer(root, serverRelease, answers, "synthetic-rehearsal-password", runPrivate);
  // The dashboard shows the release it was built for; it must be the same one.
  const assets = join(serverRelease, "dashboard", "assets");
  assert.ok(
    readdirSync(assets).some((name) => readFileSync(join(assets, name), "utf8").includes(version)),
    "The dashboard must embed the release version",
  );
  await withServer(version, async (proxy) => {
    const run = await startStudent(proxy.origin, join(scratch, "same-state"));
    assert.deepEqual(proxy.announced, [version], run.output);
    assert.ok(!run.output.includes(notice), `Same release must not prompt:\n${run.output}`);
    assert.ok(run.output.includes(signIn), `Same release must reach sign-in:\n${run.output}`);
  });
  await withServer(otherVersion, async (proxy) => {
    const run = await startStudent(proxy.origin, join(scratch, "other-state"));
    assert.deepEqual(proxy.announced, [version], run.output);
    assert.ok(run.output.includes(notice), `Another release must prompt:\n${run.output}`);
    assert.ok(run.output.includes(`(${version})`) && run.output.includes(`(${otherVersion})`));
    assert.ok(run.output.includes("open marea directly in an interactive terminal"));
    assert.ok(!run.output.includes(signIn), "Another release must stop before sign-in");
    assert.notEqual(run.code, 0, "Without a terminal the student must refuse");
  });
  console.log(
    `Version rehearsal passed: student and server ${version} agree in --version, -v, capabilities and dashboard; ${otherVersion} is refused without a terminal.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
