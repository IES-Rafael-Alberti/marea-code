import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import type { PtyProcess } from "../terminal/pty.js";

/** Synthetic evaluation draft the pilot provider returns for tool-less evaluation requests. */
export const PILOT_EVALUATION = {
  studentFeedback: "You tested the boundary. Add an empty-input example next.",
  teacherNote: "Private pilot observation — never for the student.",
  difficulties: ["Private pilot difficulty."],
  criteria: [],
};
export const PILOT_API_KEY = "synthetic-pilot-openrouter-key";
// Single words: the terminal renders words at separate cursor positions.
export const PILOT_STARTUP_TEXT = "PilotStartupReady";
export const PILOT_REPLY_TEXT = "PilotReplyReady";

const RequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.string().nullable() }).loose()),
    tools: z
      .array(z.object({ function: z.object({ name: z.string() }).loose() }).loose())
      .optional(),
  })
  .loose();
export type PilotProviderRequest = z.infer<typeof RequestSchema> & {
  readonly authorization: string | undefined;
};

function run(command: string, args: readonly string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
}

/** A private certificate authority and a 127.0.0.1 server certificate for one rehearsal. */
export function syntheticCertificateAuthority(root: string) {
  const path = (name: string) => join(root, name);
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Marea Pilot Synthetic CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("server.key"),
    "-out",
    path("server.csr"),
    "-subj",
    "/CN=127.0.0.1",
  ]);
  writeFileSync(
    path("server.ext"),
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  run("openssl", [
    "x509",
    "-req",
    "-in",
    path("server.csr"),
    "-CA",
    path("ca.pem"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-out",
    path("server.pem"),
    "-days",
    "1",
    "-extfile",
    path("server.ext"),
  ]);
  return { ca: path("ca.pem"), cert: path("server.pem"), key: path("server.key") };
}

function sse(values: readonly object[]): string {
  return `${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * An OpenRouter-compatible HTTPS endpoint scripted by request shape: evaluation requests carry no
 * tools, student turns end with a user message and everything else is the internal startup turn.
 */
export class PilotProvider {
  readonly requests: PilotProviderRequest[] = [];
  /** The next student turn containing this marker streams a prefix and loses its connection. */
  partialMarker: string | undefined;
  #server: Server | undefined;

  async start(tls: { readonly cert: string; readonly key: string }): Promise<string> {
    const server = createServer(
      { cert: readFileSync(tls.cert), key: readFileSync(tls.key) },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          this.requests.push({ ...body, authorization: request.headers.authorization });
          const last = body.messages.at(-1);
          if (this.partialMarker !== undefined && last?.content?.includes(this.partialMarker)) {
            this.partialMarker = undefined;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              sse([{ choices: [{ index: 0, delta: { content: "PilotPartialPrefix " } }] }]).replace(
                "data: [DONE]\n\n",
                "",
              ),
            );
            setTimeout(() => response.destroy(), 200);
            return;
          }
          const text =
            (body.tools ?? []).length === 0
              ? JSON.stringify(PILOT_EVALUATION)
              : last?.role === "user"
                ? PILOT_REPLY_TEXT
                : PILOT_STARTUP_TEXT;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            sse([
              { choices: [{ index: 0, delta: { content: text } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } },
            ]),
          );
        });
      },
    );
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    this.#server = server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no provider port");
    return `https://127.0.0.1:${String(address.port)}/api/v1/chat/completions`;
  }

  close(): Promise<void> {
    return new Promise((done) => {
      if (this.#server === undefined) done();
      else
        this.#server.close(() => {
          done();
        });
    });
  }
}

export interface PilotExecutables {
  readonly admin: string;
  readonly host: string;
  readonly operations: string;
}

/** Compiles the three private server executables with Bun. */
export function compileInstallationExecutables(directory: string): PilotExecutables {
  const server = resolve(process.cwd(), "apps/teacher-server");
  const binaries = {
    admin: join(directory, "marea-admin"),
    host: join(directory, "marea-teacher"),
    operations: join(directory, "marea-operations"),
  };
  for (const [entry, outfile] of [
    ["cli-entry.ts", binaries.admin],
    ["teacher-host-entry.ts", binaries.host],
    ["operations-entry.ts", binaries.operations],
  ] as const)
    run("bun", ["build", entry, "--compile", "--outfile", outfile], server);
  return binaries;
}

const policy = {
  version: "usage:pilot",
  costUnit: "pilot-credit",
  inputCostUnitsPerToken: 1,
  outputCostUnitsPerToken: 2,
  maxRequests: 50,
  maxTokens: 1_000_000,
  maxCostUnits: 1_000_000,
  maxConcurrentRequests: 2,
  maxRequestDurationMs: 30_000,
  maxInputTokens: 65_536,
  maxOutputTokens: 4_096,
  maxToolCalls: 50,
};

/**
 * A private installation laid out as the operator guide describes, with explicit synthetic
 * policy, route, budgets and prices and no database yet.
 */
export function pilotInstallation(options: {
  readonly providerEndpoint: string;
  readonly port: number;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-pilot-")));
  chmodSync(root, 0o700);
  const at = (...parts: string[]) => join(root, ...parts);
  for (const directory of [
    "locks",
    "config",
    "state",
    "backups",
    "dashboard",
    "dashboard/assets",
    "core",
    "core/didactic",
    "core/evaluation",
    "core/evaluation/evaluate",
    "centers",
    "centers/center-a",
    "centers/center-a/didactic",
    "centers/center-a/evaluation",
    "teachers",
    "teachers/teacher-a",
    "teachers/teacher-a/didactic",
    "teachers/teacher-a/evaluation",
    "work",
  ])
    mkdirSync(at(directory), { mode: 0o700 });
  const file = (path: string, content: string | Uint8Array) => {
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  file(
    at("core/evaluation/evaluate/SKILL.md"),
    "---\nname: evaluate\ndescription: Pilot evaluation method\n---\n\nEvaluate the closed session.\n",
  );
  file(at("dashboard/index.html"), "<!doctype html><title>Marea</title>");
  const databasePath = at("marea.sqlite");
  const classPolicy = {
    route: {
      version: "route:pilot",
      modelAlias: "marea",
      providerRoute: {
        providerId: "org.marea.openrouter",
        model: "synthetic/pilot-model",
        budget: { inputTokenCeiling: 65_536, tutoring: policy, evaluation: policy },
      },
    },
    teacherToolPolicy: {
      version: "policy:pilot",
      restrictions: [{ tool: "workspace.write", effect: "require-approval" }],
    },
  };
  const operatorPolicyPath = at("policy.json");
  /** Operator-declared tutoring request cap; the host reads the policy when it starts. */
  const writePolicy = (tutoringMaxRequests: number) =>
    file(
      operatorPolicyPath,
      JSON.stringify({
        version: 1,
        classes: [
          {
            classId: "class:a",
            policy: {
              ...classPolicy,
              route: {
                ...classPolicy.route,
                providerRoute: {
                  ...classPolicy.route.providerRoute,
                  budget: {
                    ...classPolicy.route.providerRoute.budget,
                    tutoring: { ...policy, maxRequests: tutoringMaxRequests },
                  },
                },
              },
            },
          },
        ],
      }),
    );
  writePolicy(policy.maxRequests);
  file(
    at("config/operator-cli.json"),
    JSON.stringify({
      version: 1,
      databasePath,
      operatorPolicyPath,
      coreSourcePath: at("core"),
      centers: [{ id: "center:a", root: at("centers/center-a") }],
      teachers: [{ id: "user:teacher", root: at("teachers/teacher-a") }],
      personalOwners: [{ classId: "class:a", teacherId: "user:teacher" }],
    }),
  );
  file(
    at("config/operations.json"),
    JSON.stringify({
      version: 1,
      databasePath,
      indexPath: at("state/deletion-index.sqlite"),
      backupRoot: at("backups"),
      authorityLineage: "lineage:pilot",
      rootId: "root:pilot",
      databaseLineage: `sha256:${"e".repeat(64)}`,
      releaseId: "release:pilot",
      limits: { fileCount: 8, fileBytes: 64_000_000, totalBytes: 128_000_000 },
      stateFiles: [],
    }),
  );
  const credentialPath = file(at("state/openrouter.key"), `${PILOT_API_KEY}\n`);
  file(at("state/digest.key"), randomBytes(32));
  const origin = `http://127.0.0.1:${String(options.port)}`;
  file(
    at("config/teacher-host.json"),
    JSON.stringify({
      version: 1,
      releaseId: "release:pilot",
      listen: { hostname: "127.0.0.1", port: options.port },
      allowedHosts: [`127.0.0.1:${String(options.port)}`],
      allowedOrigins: [origin],
      secureDashboardCookie: false,
      serverVersion: "0.2.0",
      statusPath: at("state/host-status.json"),
      digestKeyPath: at("state/digest.key"),
      dashboardDistPath: at("dashboard"),
      providers: [
        {
          pluginId: "org.marea.openrouter",
          credentialPath,
          endpoint: options.providerEndpoint,
        },
      ],
      retry: { delayMs: 10, maxDelayMs: 100 },
      evaluationIntervalMs: 50,
      shutdownDrainMs: 2_000,
    }),
  );
  return { root, databasePath, origin, writePolicy, work: (name: string) => at("work", name) };
}

/** A free loopback port for the host listener. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolvePort(address.port);
      });
    });
  });
}

/** Starts the compiled host trusting only the rehearsal certificate authority. */
export async function startPilotHost(host: string, root: string, ca: string) {
  const child = spawn(host, ["--installation", root, "--release", "release:pilot"], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: ca },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  const deadline = Date.now() + 30_000;
  while (!output.stdout.includes("Teacher host ready at ") && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited: ${output.stderr}`);
    await new Promise((wait) => setTimeout(wait, 50));
  }
  if (!output.stdout.includes("Teacher host ready at "))
    throw new Error(`host did not start: ${output.stderr}`);
  return {
    output,
    async stop(): Promise<number | null> {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

/** Durable student state and robust terminal submission for compiled PTY journeys. */
export function pilotStudentDriver(stateRoot: string) {
  const studentState = async () => {
    const directory = join(stateRoot, "student");
    const [entry] = await readdir(directory).catch(() => []);
    return entry === undefined
      ? undefined
      : parseStudentState(
          JSON.parse(await readFile(join(directory, entry, "session.json"), "utf8")),
        );
  };
  const until = async (description: string, condition: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 120_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
      await new Promise((wait) => setTimeout(wait, 100));
    }
  };
  return {
    studentState,
    until,
    turnCount: async () => (await studentState())?.run?.turns.length ?? 0,
    /** Waits for an active run with no turn in progress, as the interface accepts input then. */
    idleRun: (turns: number) =>
      until(`an idle run with ${String(turns)} turns`, async () => {
        const run = (await studentState())?.run;
        return (
          run?.phase === "active" &&
          run.turns.length === turns &&
          run.turns.every((turn) => turn.state !== "started")
        );
      }),
    /**
     * Replace the single-line draft before retrying submission: input entered
     * while a turn settles may be retained rather than discarded.
     */
    submit: async (
      terminal: PtyProcess,
      text: string,
      accepted: () => Promise<boolean> | boolean,
    ) => {
      terminal.write(`\u0005\u0015${text}\r`);
      const deadline = Date.now() + 120_000;
      let pressed = Date.now();
      while (!(await accepted())) {
        if (Date.now() > deadline) throw new Error(`The interface never accepted ${text}.`);
        if (Date.now() - pressed > 3_000) {
          terminal.write(`\u0005\u0015${text}\r`);
          pressed = Date.now();
        }
        await new Promise((wait) => setTimeout(wait, 100));
      }
    },
    /** Types `/exit` again until the process ends, for the same reason as `submit`. */
    exit: async (terminal: PtyProcess) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        terminal.write("/exit\r");
        try {
          return await terminal.waitForExit(3_000);
        } catch (error) {
          if (Date.now() > deadline) throw error;
        }
      }
    },
  };
}
