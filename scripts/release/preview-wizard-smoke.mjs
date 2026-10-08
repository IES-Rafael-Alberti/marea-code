import assert from "node:assert/strict";
import { URL, URLSearchParams } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { securePrivatePath } from "@marea/private-filesystem";
import { existingOnboarding } from "./onboarding-state.boundary.ts";
import { setupInput } from "./onboarding.fixture.ts";
import { finishSetupInBrowser } from "./onboarding-browser-smoke.mjs";

const scratch = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "marea-browser-setup-")));
const suffix = process.platform === "win32" ? ".exe" : "";
const build = (entry, output) =>
  execFileSync("bun", ["build", entry, "--compile", "--outfile", output], { stdio: "pipe" });
function makePrivate(path) {
  securePrivatePath(path, 0o700);
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) makePrivate(next);
    else securePrivatePath(next, 0o600);
  }
}
async function waitFor(predicate) {
  for (let n = 0; n < 240; n++) {
    const result = await predicate();
    if (result) return result;
    await delay(250);
  }
  throw new Error("Native setup probe timed out");
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    // This pipe-based fixture has no Windows console; ConPTY tests cover interactive Ctrl+C.
    const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "pipe",
    });
    assert.equal(killed.status, 0);
  } else child.kill("SIGINT");
  await Promise.race([
    stopped,
    delay(20000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        throw new Error("Setup did not stop");
      }
    }),
  ]);
}
let child;
try {
  const release = join(scratch, "release");
  fs.mkdirSync(release, { mode: 0o700 });
  if (process.argv[2])
    fs.cpSync(fs.realpathSync(resolve(process.argv[2])), release, { recursive: true });
  else {
    for (const [entry, name] of [
      ["teacher-host-entry.ts", "marea-teacher"],
      ["cli-entry.ts", "marea-admin"],
      ["operations-entry.ts", "marea-operations"],
    ])
      build(`apps/teacher-server/${entry}`, join(release, name + suffix));
    execFileSync("bun", ["run", "--cwd", "apps/dashboard", "build"], {
      stdio: "pipe",
      env: {
        ...process.env,
        VITE_MAREA_PREVIEW_REPOSITORY: "example/marea",
        VITE_MAREA_PREVIEW_VERSION: "0.1.0-preview.1",
      },
    });
    fs.cpSync("apps/dashboard/dist", join(release, "dashboard"), { recursive: true });
    fs.cpSync("content/skills", join(release, "skills"), { recursive: true });
  }
  makePrivate(join(release, "dashboard"));
  const executable = join(scratch, "marea-setup" + suffix);
  build("scripts/release/onboarding-smoke-entry.fixture.ts", executable);
  const root = join(scratch, "managed");
  fs.mkdirSync(root, { mode: 0o700 });
  securePrivatePath(root, 0o700);
  const settings = {
    format: 1,
    repository: "example/marea",
    component: "server",
    channel: "preview",
    installation: join(root, "installation"),
  };
  fs.writeFileSync(join(root, "preview.json"), JSON.stringify(settings), { mode: 0o600 });
  fs.writeFileSync(join(root, "onboarding-pending.json"), '{"format":1}', { mode: 0o600 });
  const launch = () => {
    let transcript = "";
    const current = spawn(executable, [root, release], { stdio: ["ignore", "pipe", "pipe"] });
    current.stdout.on("data", (b) => (transcript += b));
    current.stderr.on("data", (b) => (transcript += b));
    current.transcript = () => transcript;
    return current;
  };
  child = launch();
  await waitFor(() => fs.existsSync(join(root, "setup-url.txt")));
  await stop(child);
  assert.equal(fs.existsSync(settings.installation), false);
  assert.equal(fs.existsSync(join(root, "onboarding-pending.json")), true);
  assert.equal(existingOnboarding(root), null);
  assert.equal(fs.existsSync(join(root, "onboarding-owner.json")), false);
  fs.rmSync(join(root, "setup-url.txt"));
  process.stdout.write("Cancelled first run leaves no active school and can be reopened.\n");
  child = launch();
  const url = await waitFor(
    () =>
      fs.existsSync(join(root, "setup-url.txt")) &&
      fs.readFileSync(join(root, "setup-url.txt"), "utf8"),
  );
  const address = new URL(url);
  const token = new URLSearchParams(address.hash.slice(1)).get("token");
  const headers = {
    "content-type": "application/json",
    origin: address.origin,
    authorization: `Bearer ${token}`,
  };
  const api = (body) =>
    globalThis.fetch(`${address.origin}/setup/api`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const page = await globalThis.fetch(url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("setup-entry") === false);
  assert.equal(
    (await globalThis.fetch(`${address.origin}/setup/api`, { method: "POST", body: "{}" })).status,
    403,
  );
  assert.equal((await (await api({ operation: "read" })).json()).settings.administrator, true);
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const input = setupInput({
    port,
    testingSkill: true,
    features: { map: true, reports: true, automaticEvaluation: true },
  });
  const models = await api({
    operation: "models",
    providerId: input.route.providerId,
    values: input.connections[input.route.providerId],
  });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).models[0].id, "synthetic/classroom");
  assert.equal(
    (await api({ operation: "finish", setup: { ...input, password: "tiny" } })).status,
    400,
  );
  assert.equal(fs.existsSync(settings.installation), false);
  let completed, cookie;
  if (process.env.PLAYWRIGHT_PACKAGE) {
    ({ completed, cookie } = await finishSetupInBrowser(url, input));
    process.stdout.write(
      "Browser onboarding, automatic dashboard sign-in and reload passed without URL.parse.\n",
    );
  } else {
    const done = await api({ operation: "finish", setup: input });
    assert.equal(done.status, 200, child.transcript());
    completed = await done.json();
    cookie = done.headers.get("set-cookie");
  }
  assert.equal(
    completed.dashboardUrl,
    `http://127.0.0.1:${port}/dashboard/?class=class%3Amain&welcome=1`,
  );
  assert.ok(cookie?.includes("HttpOnly"));
  assert.ok(!cookie.includes("Secure"));
  assert.equal((await globalThis.fetch(completed.dashboardUrl)).status, 200);
  const schoolOrigin = `http://127.0.0.1:${port}`;
  const authenticated = (body) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: schoolOrigin,
      cookie: cookie.split(";")[0],
    },
    body: JSON.stringify({
      protocolVersion: "0.1",
      requestId: "request:native-onboarding",
      ...body,
    }),
  });
  const session = await globalThis.fetch(
    `${schoolOrigin}/api/v1/dashboard/session`,
    authenticated({ kind: "dashboard-session-query" }),
  );
  assert.equal(session.status, 200);
  assert.equal(fs.existsSync(join(root, "onboarding-pending.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(join(root, "preview.json"), "utf8")).allowHttp, true);
  assert.ok(!child.transcript().includes(input.password));
  assert.ok(!child.transcript().includes("synthetic-api-key"));
  const configuration = await globalThis.fetch(
    `${schoolOrigin}/api/v1/dashboard/teaching/read`,
    authenticated({ kind: "teaching-configuration-query", classId: "class:main" }),
  );
  assert.equal(configuration.status, 200);
  const teaching = await configuration.json();
  assert.equal(teaching.operatorReady, true);
  assert.equal(teaching.configuration.settings.agentMode, "tutoring");
  assert.equal(teaching.configuration.settings.automaticEvaluation, true);
  assert.equal(teaching.configuration.settings.selection.didactic[0].id, "marea/testing");
  const insights = await globalThis.fetch(
    `${schoolOrigin}/api/v1/dashboard/educational-insights`,
    authenticated({ kind: "settings", classId: "class:main" }),
  );
  assert.equal(insights.status, 200);
  const features = (await insights.json()).data;
  assert.equal(features.settings.map, true);
  assert.equal(features.mapConfigured, true);
  assert.equal(features.reportsConfigured, true);
  assert.equal(teaching.configuration.settings.selection.evaluation[0].id, "marea/evaluate");
  await stop(child);
  assert.equal(existingOnboarding(root), null);
  assert.equal(fs.existsSync(join(root, "onboarding-owner.json")), false);
  process.stdout.write(
    "Native web setup passed: private local API, credential checks, retry, complete class, example skill, real host readiness, automatic dashboard sign-in and clean shutdown.\n",
  );
} finally {
  if (child?.exitCode === null) await stop(child);
  fs.rmSync(scratch, { recursive: true, force: true });
}
