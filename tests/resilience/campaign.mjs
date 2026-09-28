/* global Bun, fetch, AbortSignal, TextDecoder, performance, console, process, URL */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { cpus, totalmem, tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  compileInstallationExecutables,
  freeLoopbackPort,
  pilotInstallation,
  startPilotHost,
  syntheticCertificateAuthority,
} from "../../test-support/platform/installation.ts";
import { simulator } from "./simulator.mjs";
import { captureSource } from "./evidence.mjs";

const expectedBun = JSON.parse(readFileSync("package.json", "utf8")).engines.bun;
assert.equal(Bun.version, expectedBun, "Run campaign using the centrally pinned Bun version");
assert.equal(
  spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim(),
  expectedBun,
  "Compiler on PATH must use the central runtime pin",
);
let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopRequested = true;
  });
const seconds = Number(process.env.RESILIENCE_SECONDS ?? 30);
const sessionRenewalSeconds = Number(process.env.RESILIENCE_SESSION_RENEW_SECONDS ?? 600);
assert.ok(
  Number.isFinite(sessionRenewalSeconds) &&
    sessionRenewalSeconds > 0 &&
    sessionRenewalSeconds < 1800,
);
assert.ok(Number.isFinite(seconds) && seconds >= 1);
const report = resolve(process.env.RESILIENCE_REPORT ?? "reports/resilience/smoke.json");
mkdirSync(join(report, ".."), { recursive: true });
const build = realpathSync(mkdtempSync(join(tmpdir(), "marea-resilience-build-")));
const startedAt = new Date().toISOString();
const harnessSha256 = Object.fromEntries(
  ["campaign.mjs", "simulator.mjs", "evidence.mjs"].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest("hex"),
  ]),
);
const samples = {};
const resourceSamples = [];
let authAdmissionRejections = 0;
const admissionByMetric = {};
const sessionRenewals = [];
const faults = [];
let host, provider, f;
let cycles = 0;
let campaignStart;
let phase = "setup";
let lastResponseAt;
let streamFailure;
let failed = false;
const evidence = {};
const measure = async (name, action) => {
  const start = performance.now();
  const value = await action();
  (samples[name] ??= []).push(performance.now() - start);
  return value;
};
const command = (binary, args, payload) => {
  const input = payload === undefined ? [] : ["--input", f.work("input.json")];
  if (payload !== undefined) writeFileSync(input[1], JSON.stringify(payload), { mode: 0o600 });
  const result = spawnSync(binary, ["--installation", f.root, ...args.split(" "), ...input], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, `${args}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
let request = 0;
const post = async (path, body, token, metric) =>
  measure(metric.startsWith("auth") ? `${metric}-total` : metric, async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const attemptStarted = performance.now();
      const response = await fetch(`${f.origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: f.origin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: `resilience:${++request}`,
          ...body,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (response.status === 503 && metric.startsWith("auth") && data.error?.retryable) {
        authAdmissionRejections++;
        admissionByMetric[metric] = (admissionByMetric[metric] ?? 0) + 1;
        await Bun.sleep(100 + (attempt % 7) * 17);
        continue;
      }
      assert.ok(response.status === 200 || response.status === 201, JSON.stringify(data));
      if (metric.startsWith("auth"))
        (samples[metric] ??= []).push(performance.now() - attemptStarted);
      return data;
    }
    throw new Error("Authentication admission retry budget exhausted");
  });
try {
  const tls = syntheticCertificateAuthority(build);
  provider = await simulator(tls);
  f = pilotInstallation({
    providerEndpoint: `${provider.endpoint}/model`,
    port: await freeLoopbackPort(),
  });
  f.writePolicy(100000);
  const operationsPath = join(f.root, "config/operations.json");
  const operations = JSON.parse(readFileSync(operationsPath, "utf8"));
  operations.limits = { fileCount: 8, fileBytes: 268435456, totalBytes: 536870912 };
  writeFileSync(operationsPath, JSON.stringify(operations));
  const policyPath = join(f.root, "policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const budget = policy.classes[0].policy.route.providerRoute.budget;
  budget.tutoring.maxRequestDurationMs = 5000;
  budget.tutoring.maxTokens = 100000000;
  budget.tutoring.maxCostUnits = 100000000;
  writeFileSync(policyPath, JSON.stringify(policy));
  const configPath = join(f.root, "config/teacher-host.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.telemetry = {
    enabled: true,
    startupTimeoutMs: 1000,
    maxInFlight: 2,
    exporters: [
      {
        destination: "otlp",
        schemaVersion: "1.0",
        operationTimeoutMs: 100,
        maxRequestBytes: 262144,
        maxResponseBytes: 65536,
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(
    join(f.root, "config/telemetry-otlp.json"),
    JSON.stringify({ endpoint: provider.endpoint, headers: {} }),
    { mode: 0o600 },
  );
  const source = captureSource(report);
  evidence.sourceManifestSha256 = source.sha256;
  const binaries = compileInstallationExecutables(build);
  source.assertUnchanged();
  const sourceDiff = spawnSync(
    "git",
    ["diff", "HEAD", "--", "apps", "packages", "plugins", "test-support"],
    { encoding: "utf8", maxBuffer: 16000000 },
  ).stdout;
  writeFileSync(`${report}.source.diff`, sourceDiff);
  const sourceDiffSha256 = createHash("sha256").update(sourceDiff).digest("hex");
  const binarySha256 = createHash("sha256").update(readFileSync(binaries.host)).digest("hex");
  Object.assign(evidence, { binarySha256, sourceDiffSha256 });
  command(binaries.operations, "installation initialize");
  command(binaries.admin, "center create", {
    centerId: "center:a",
    displayName: "P5",
    expectedVersion: null,
  });
  command(binaries.admin, "class create", {
    centerId: "center:a",
    classId: "class:a",
    displayName: "P5",
    expectedVersion: null,
  });
  for (let i = 0; i <= 30; i++)
    command(binaries.admin, "account create", {
      centerId: "center:a",
      userId: i === 30 ? "user:teacher" : `user:${i}`,
      displayName: `Synthetic ${i}`,
      login: `pupil${i}`,
      role: i === 30 ? "teacher" : "student",
      classId: "class:a",
      expectedVersion: null,
    });
  const db = new Database(f.databasePath);
  db.run("UPDATE marea_users SET password_hash = ?", [
    await Bun.password.hash("synthetic-resilience-password", { algorithm: "argon2id" }),
  ]);
  db.run("UPDATE marea_governance_accounts SET state = 'active'");
  db.close();
  command(binaries.operations, "backup create", { name: "before-class" });
  host = await startPilotHost(binaries.host, f.root, tls.ca);
  const login = (i, metric = "auth") =>
    post(
      "/v1/auth/login",
      {
        kind: "credential-login",
        credentials: { login: `pupil${i}`, password: "synthetic-resilience-password" },
      },
      null,
      metric,
    );
  const teacher = await login(30);
  let cookie = `marea_teacher_session=${teacher.session.token}`;
  const dashboard = async (path, body) =>
    measure("dashboard", async () => {
      const response = await fetch(`${f.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.origin, cookie },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: `resilience:${++request}`,
          ...body,
        }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    });
  await dashboard("/api/v1/dashboard/teaching/save", {
    kind: "teaching-configuration-save",
    classId: "class:a",
    expectedVersion: null,
    settings: {
      agentMode: "free",
      classInstructions: { tutoring: "Synthetic", free: "Synthetic" },
      selection: { didactic: [], evaluation: [] },
      automaticEvaluation: false,
    },
  });
  const pupils = await Promise.all(
    Array.from({ length: 30 }, async (_, i) => {
      const auth = await login(i, "auth-burst");
      const body = {
        clientVersion: "0.2.0",
        idempotencyKey: `open:${i}`,
        clientSessionId: `client:${i}`,
        project: { displayName: "Synthetic project" },
        intent: { kind: "new" },
      };
      const opened = await post("/v1/runs/open", body, auth.session.token, "open");
      return {
        i,
        auth: auth.session.token,
        lease: opened.lease,
        sequence: opened.highestDurableSequence,
      };
    }),
  );
  const stream = async (pupil, expected = "completed", slow = false) => {
    const streamStartedAt = Date.now();
    const streamRequestId = `resilience:${++request}`;
    let response;
    try {
      response = await fetch(`${f.origin}/v1/model/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${pupil.lease.token}`,
        },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: streamRequestId,
          kind: "model-gateway-request",
          modelAlias: "marea",
          messages: [{ role: "student", content: "Synthetic" }],
          tools: [],
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      streamFailure = {
        phase,
        cycle: cycles,
        pupil: pupil.i,
        requestId: streamRequestId,
        startedAt: streamStartedAt,
        failedAt: Date.now(),
        elapsedMs: Date.now() - streamStartedAt,
        sinceLastResponseMs: lastResponseAt === undefined ? null : Date.now() - lastResponseAt,
      };
      throw error;
    }
    lastResponseAt = Date.now();
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    if (slow) {
      await Bun.sleep(300);
      await reader.cancel();
      return;
    }
    let text = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = new TextDecoder().decode(item.value);
      text += chunk;
      for (const match of chunk.matchAll(/P5:(\d+);/g))
        (samples.streaming ??= []).push(Date.now() - Number(match[1]));
    }
    const chunks = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(chunks.at(-1).event, expected, text);
  };
  const ack = async (pupil) => {
    const events = [
      {
        eventId: `event:${pupil.i}:${++pupil.sequence}`,
        sequence: pupil.sequence,
        occurredAt: new Date().toISOString(),
        eventType: "student-message",
        content: "Synthetic evidence",
      },
    ];
    const body = { kind: "run-events-append", events };
    if (pupil.i === 0 && (cycles === 0 || (cycles + 1) % 12 === 0)) {
      const lost = await fetch(`${f.origin}/v1/runs/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${pupil.lease.token}`,
        },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: `resilience:${++request}`,
          ...body,
        }),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(lost.status, 200);
      await lost.body.cancel(); // Deliberately lose the durable acknowledgement before decoding it.
    }
    const first = await post("/v1/runs/events", body, pupil.lease.token, "ack");
    const duplicate = await post("/v1/runs/events", body, pupil.lease.token, "ack-replay");
    assert.equal(first.highestDurableSequence, duplicate.highestDurableSequence);
  };
  const resume = async (pupil, metric) => {
    const resumed = await post(
      "/v1/runs/open",
      {
        clientVersion: "0.2.0",
        idempotencyKey: `resume:${++request}:${pupil.i}`,
        clientSessionId: `client:${pupil.i}`,
        project: { displayName: "Synthetic project" },
        intent: { kind: "resume" },
        runId: pupil.lease.runId,
      },
      pupil.auth,
      metric,
    );
    assert.equal(resumed.lease.runId, pupil.lease.runId);
    assert.equal(resumed.highestDurableSequence, pupil.sequence);
    pupil.lease = resumed.lease;
  };
  const collectorFault = async (mode, counter, pupil) => {
    const before = provider.state[counter] ?? 0;
    provider.state.mode = mode;
    await resume(pupil, "telemetry-fault-resume");
    assert.ok(provider.state[counter] > before, "Collector fault must actually be received");
  };
  campaignStart = Date.now();
  let renewedAt = campaignStart;
  do {
    if (Date.now() - renewedAt >= sessionRenewalSeconds * 1000) {
      for (const pupil of pupils) {
        const renewed = await login(pupil.i, "auth-renew");
        assert.notEqual(renewed.session.token, pupil.auth);
        pupil.auth = renewed.session.token;
      }
      const renewedTeacher = await login(30, "auth-renew");
      const renewedCookie = `marea_teacher_session=${renewedTeacher.session.token}`;
      assert.notEqual(renewedCookie, cookie);
      cookie = renewedCookie;
      renewedAt = Date.now();
      sessionRenewals.push({
        elapsedSeconds: (renewedAt - campaignStart) / 1000,
        pupils: 30,
        teacher: true,
      });
    }
    phase = "normal-burst";
    provider.burst(30);
    await Promise.all(pupils.map((pupil) => stream(pupil)));
    provider.burst(0);
    phase = "acknowledgements";
    await Promise.all(pupils.map(ack));
    await dashboard("/api/v1/dashboard/history/sessions", {
      kind: "session-history-query",
      limit: 32,
    });
    cycles++;
    const processList =
      spawnSync("ps", ["-axo", "rss=,pcpu=,command="], {
        encoding: "utf8",
      }).stdout ?? "";
    const hostLine = processList
      .split("\n")
      .find((line) => line.includes(`${binaries.host} --installation`));
    if (hostLine) {
      const [rssKiB, cpuPercent] = hostLine.trim().split(/\s+/).map(Number);
      resourceSamples.push({ rssKiB, cpuPercent });
    }
    if (cycles % 30 === 0)
      await Promise.all(
        pupils.map(async (pupil) => {
          const renewed = await post(
            "/v1/runs/lease-renew",
            { kind: "run-lease-renewal", runId: pupil.lease.runId },
            pupil.auth,
            "lease-renew",
          );
          pupil.lease = renewed.lease;
        }),
      );
    if (cycles % 12 === 0 || cycles === 1) {
      await measure("auth-steady", () => login(30));
      phase = "provider-failure";
      provider.state.mode = "failure";
      await stream(pupils[0], "failed");
      phase = "provider-timeout";
      provider.state.mode = "timeout";
      await stream(pupils[1], "failed");
      phase = "slow-read-cancellation";
      provider.state.mode = "slow";
      await Promise.all(pupils.slice(0, 3).map((pupil) => stream(pupil, "completed", true)));
      phase = "collector-failure";
      await collectorFault("telemetry-failure", "collectorFailures", pupils[3]);
      provider.state.mode = "normal";
      await Bun.sleep(1100);
      phase = "provider-recovery";
      await stream(pupils[0]);
      faults.push({
        cycle: cycles,
        providerFailure: true,
        lostAcknowledgementReplay: true,
        timeout: true,
        slowReadCancellation: true,
        telemetryFailure: true,
        recovery: true,
      });
    }
    writeFileSync(
      `${report}.progress`,
      JSON.stringify({
        startedAt,
        elapsedSeconds: (Date.now() - campaignStart) / 1000,
        cycles,
        faults: faults.length,
      }),
    );
    await Bun.sleep(1000);
  } while (Date.now() - campaignStart < seconds * 1000 && !stopRequested);
  const campaignSeconds = (Date.now() - campaignStart) / 1000;
  await collectorFault("telemetry-timeout", "collectorTimeouts", pupils[4]);
  provider.state.mode = "normal";
  const beforeRestartTelemetry = provider.state.telemetry;
  await resume(pupils[4], "telemetry-fail-closed");
  assert.equal(
    provider.state.telemetry,
    beforeRestartTelemetry,
    "Timeout disables optional telemetry until host restart",
  );
  await host.stop();
  host = undefined;
  host = await startPilotHost(binaries.host, f.root, tls.ca);
  const reconnectStarted = performance.now();
  await Promise.all(pupils.map((pupil) => resume(pupil, "reconnect")));
  assert.ok(
    provider.state.telemetry > beforeRestartTelemetry,
    "Restart must recover telemetry delivery",
  );
  const reconnectAllMs = performance.now() - reconnectStarted;
  await host.stop();
  host = undefined;
  command(binaries.operations, "backup create", { name: "after-class" });
  const verify = new Database(f.databasePath, { readonly: true });
  assert.equal(verify.query("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(verify.query("SELECT count(*) AS n FROM marea_runs").get().n, 30);
  verify.close();
  const restores = [];
  for (const name of ["before-class", "after-class"]) {
    const restoreStarted = performance.now();
    const destinationRoot = join(build, `restored-${name}`);
    const restored = command(binaries.operations, "backup restore", {
      bundlePath: join(f.root, "backups", name),
      destinationRoot,
    });
    assert.equal(restored.state, "restored");
    const installation = join(build, `installation-${name}`);
    cpSync(f.root, installation, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(join(installation, `marea.sqlite${suffix}`), { force: true });
    cpSync(join(destinationRoot, "database.sqlite"), join(installation, "marea.sqlite"));
    for (const configName of ["operator-cli", "operations", "teacher-host"]) {
      const path = join(installation, "config", `${configName}.json`);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.root, installation));
    }
    const restoredDb = new Database(join(installation, "marea.sqlite"));
    assert.equal(restoredDb.query("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(
      restoredDb.query("SELECT count(*) AS n FROM marea_runs").get().n,
      name === "before-class" ? 0 : 30,
    );
    restoredDb.close();
    host = await startPilotHost(binaries.host, installation, tls.ca);
    await login(30);
    await host.stop();
    host = undefined;
    restores.push({
      name,
      durationMs: performance.now() - restoreStarted,
      integrity: "ok",
      authenticatedRestoredHost: true,
    });
  }
  const summary = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [
        key,
        {
          count: values.length,
          p95Ms: values[Math.ceil(values.length * 0.95) - 1],
          maxMs: values.at(-1),
        },
      ];
    }),
  );
  const result = {
    startedAt,
    harnessSha256,
    finishedAt: new Date().toISOString(),
    durationSeconds: (Date.now() - campaignStart) / 1000,
    requestedSeconds: seconds,
    campaignSeconds,
    completedRequestedDuration: campaignSeconds >= seconds,
    runtime: Bun.version,
    sourceManifestSha256: source.sha256,
    sourceFiles: source.files,
    databaseBytes: statSync(f.databasePath).size,
    backupLimits: operations.limits,
    cycles,
    pupils: 30,
    authAdmissionRejections,
    admissionByMetric,
    sessionRenewalSeconds,
    sessionRenewals,
    binarySha256,
    sourceDiffSha256,
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    platform: platform(),
    arch: arch(),
    logicalCPUs: cpus().length,
    memoryBytes: totalmem(),
    constrained4CPU8GB: false,
    network: "loopback; LAN/VPN latency not emulated",
    summary,
    reconnectAllMs,
    telemetryTimeout: { observed: true, failClosedUntilRestart: true, recoveredAfterRestart: true },
    restores,
    resourcePeak: {
      rssKiB: resourceSamples.length
        ? Math.max(...resourceSamples.map((sample) => sample.rssKiB))
        : null,
      cpuPercent: resourceSamples.length
        ? Math.max(...resourceSamples.map((sample) => sample.cpuPercent))
        : null,
    },
    faults,
    simulator: provider.state,
    integrity: "ok",
    thresholdsPassed:
      campaignSeconds >= seconds &&
      Object.entries(summary)
        .filter(([key]) =>
          [
            "auth-steady",
            "auth-renew-total",
            "open",
            "reconnect",
            "ack",
            "dashboard",
            "streaming",
          ].includes(key),
        )
        .every(([key, value]) => value.p95Ms <= (key === "streaming" ? 250 : 500)) &&
      reconnectAllMs <= 30000 &&
      restores.every((restore) => restore.durationMs <= 3600000),
    limitations: [
      "30 protocol HTTP clients, not 30 compiled TUI processes",
      "No external platform or resource-constrained acceptance",
      "Slow-read cancellation exercises transport; queue bound not instrumented",
      "Graceful restart only; abrupt/deletion recovery covered by separate compiled receipts",
    ],
  };
  writeFileSync(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(provider.state.confirmedBursts, cycles);
  if (campaignSeconds > sessionRenewalSeconds + 10)
    assert.ok(
      sessionRenewals.length > 0,
      "Long campaigns must refresh real sessions before expiry",
    );
  assert.ok(
    result.thresholdsPassed,
    "Resilience thresholds or requested duration failed; see durable report",
  );
} catch (error) {
  failed = true;
  writeFileSync(
    `${report}.failure.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        requestedSeconds: seconds,
        campaignSeconds: campaignStart ? (Date.now() - campaignStart) / 1000 : 0,
        completedRequestedDuration: false,
        thresholdsPassed: false,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
          path: error.path,
        },
        hostOutput: host?.output,
        phase,
        streamFailure,
        runtime: Bun.version,
        harnessSha256,
        ...evidence,
        cycles,
        samples,
        resourceSamples,
        authAdmissionRejections,
        admissionByMetric,
        sessionRenewals,
        faults,
        simulator: provider?.state,
      },
      null,
      2,
    ),
  );
  console.error(error);
  throw error;
} finally {
  if (host) {
    const hostStopExitStatus = await host.stop();
    if (failed) {
      const failurePath = `${report}.failure.json`;
      const failureReceipt = JSON.parse(readFileSync(failurePath, "utf8"));
      failureReceipt.hostOutput = host.output;
      failureReceipt.hostStopExitStatus = hostStopExitStatus;
      writeFileSync(failurePath, JSON.stringify(failureReceipt, null, 2));
    }
  }
  if (provider) await provider.close();
  if (f) rmSync(f.root, { recursive: true, force: true });
  rmSync(build, { recursive: true, force: true });
}
