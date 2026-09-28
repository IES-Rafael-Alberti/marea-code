/* global process, console */
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] ?? "/tmp/marea-release-acceptance");
mkdirSync(output, { recursive: true });
if (!process.env.PLAYWRIGHT_PACKAGE || !process.env.CHROMIUM_EXECUTABLE)
  throw new Error("Set PLAYWRIGHT_PACKAGE and CHROMIUM_EXECUTABLE to installed local tools");
const results = [];
function run(name, command, cwd = repository, env = process.env) {
  const log = join(output, `${name}.log`);
  const fd = openSync(log, "w");
  const started = Date.now();
  console.log(`START ${name}`);
  const result = spawnSync(command[0], command.slice(1), { cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  results.push({
    name,
    command,
    cwd,
    seconds: (Date.now() - started) / 1000,
    status: result.status,
    signal: result.signal,
    log,
  });
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`END ${name}: ${result.status}`);
  return result.status === 0;
}
if (!run("build", ["bun", "run", "--cwd", "apps/dashboard", "build"]))
  throw new Error("Dashboard build failed");
for (const [name, entry] of [
  ["host", "dashboard-host.ts"],
  ["plugins", "release-plugins.fixture.ts"],
  ["profile-http", "profile-host.ts"],
]) {
  if (
    !run(`compile-${name}`, [
      "bun",
      "build",
      `apps/teacher-server/smoke/${entry}`,
      "--compile",
      "--outfile",
      join(output, name),
    ])
  )
    throw new Error(`${name} build failed`);
}
run("plugins", [join(output, "plugins")]);
run("profile-http", [join(output, "profile-http")]);
const browserEnv = { ...process.env, MAREA_PROFILE_HOST: join(output, "host") };
for (const journey of [
  "integrated-profiles",
  "release-recovery",
  "telemetry-preview",
  "usage-health",
  "reviewed-evidence",
])
  run(journey, ["node", `apps/dashboard/browser/${journey}.mjs`], repository, browserEnv);
run(
  "upgrade-restore-rollback",
  ["bun", "run", "smoke/compiled-profile-upgrade.ts"],
  join(repository, "apps/teacher-server"),
);
run(
  "telemetry",
  ["bun", "run", "smoke/compiled-telemetry.ts"],
  join(repository, "apps/teacher-server"),
);
// Complementary controller fault injection against real built assets, with synthetic API replies.
if (run("controller-catalog", ["bun", "run", "apps/dashboard/browser/profiles-fixture.mjs"])) {
  const server = spawn(
    "bun",
    ["x", "vite", "preview", "--host", "127.0.0.1", "--port", "5194", "--strictPort"],
    { cwd: join(repository, "apps/dashboard"), stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await Promise.race([
      once(server.stdout, "data"),
      once(server, "exit").then(() => {
        throw new Error("Static fixture server failed");
      }),
    ]);
    run("controller-intercepted", ["node", "apps/dashboard/browser/profiles-acceptance.mjs"]);
  } finally {
    if (server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped;
    }
  }
}
process.exitCode = results.every((result) => result.status === 0) ? 0 : 1;
