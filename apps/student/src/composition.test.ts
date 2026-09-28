import { ModelStreamError } from "@marea/deepagents-adapter";
/* eslint-disable @typescript-eslint/require-await */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ApprovalIdSchema } from "@marea/protocol";

import {
  createProductionStudentApplication,
  createStudentApplication,
  StudentRunTokenBinding,
} from "./composition.js";
import { TurnAttemptFailed } from "./contracts.js";
import { runInteractiveMarea, runMarea } from "./main.js";
import { createSystemClock, createSystemIdSource } from "./platform.boundary.js";
import { captureRejection } from "./session-test.boundary.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import {
  FixtureAgent,
  FixtureInterface,
  FixtureServer,
  FixtureWorkspace,
  RUN_TOKEN,
  createFixtureController,
} from "./student.fixture.js";

interface FixtureApplication {
  readonly controller: Awaited<ReturnType<typeof createStudentApplication>>;
  readonly projectRoot: string;
  readonly root: string;
  readonly server: FixtureServer;
}

async function withFixtureApplication(
  prefix: string,
  run: (fixture: FixtureApplication) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const server = new FixtureServer();
  try {
    const controller = await createStudentApplication({
      agent: new FixtureAgent(),
      clientVersion: "1.0.0",
      projectRoot,
      server,
      stateDirectory: join(root, "state"),
      studentInterface: new FixtureInterface(),
      workspace: new FixtureWorkspace(),
    });
    await run({ controller, projectRoot, root, server });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("student composition", () => {
  it("builds a file-backed application without inventing unavailable adapters", async () => {
    await withFixtureApplication("marea-composition-", async ({ controller, server }) => {
      await runMarea({ controller, projectDisplayName: "Project One" });

      expect(controller).toBeDefined();
      expect(server.openRequests).toHaveLength(1);
    });
  });

  it("loads an unfinished logical turn from a fresh file-backed controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-pending-turn-"));
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const server = new FixtureServer();
    const interrupted = new FixtureAgent();
    interrupted.streamMessage = async function* (turn) {
      this.messageTurns.push(turn);
      this.messages += 1;
      yield { type: "assistant-text-delta", text: "Saved prefix" };
      throw new ModelStreamError({
        code: "unavailable",
        message: "process interrupted",
        retryable: true,
      });
    };
    try {
      const first = await createStudentApplication({
        agent: interrupted,
        clientVersion: "1.0.0",
        projectRoot,
        server,
        stateDirectory,
        studentInterface: new FixtureInterface(),
        workspace: new FixtureWorkspace(),
      });
      await first.start("Project One");
      const rejection = await captureRejection(
        first.sendMessage("message:persisted", "Original input", new AbortController().signal),
      );
      expect(rejection).toBeInstanceOf(TurnAttemptFailed);
      if (rejection instanceof TurnAttemptFailed) {
        expect(rejection.prefix).toBe("Saved prefix");
        expect(rejection.cause.message).toBe("The Marea model gateway reported a failed stream.");
      }

      const restarted = await createStudentApplication({
        agent: new FixtureAgent(),
        clientVersion: "1.0.0",
        projectRoot,
        server,
        stateDirectory,
        studentInterface: new FixtureInterface(),
        workspace: new FixtureWorkspace(),
      });
      await restarted.start("Project One");

      await expect(restarted.pendingTurn()).resolves.toEqual({
        assistantText: "Saved prefix",
        failure: {
          code: "unavailable",
          detail: "process interrupted",
          hasPrefix: true,
          kind: "provider-interrupted",
          recoverable: true,
          retryable: true,
        },
        messageId: "message:persisted",
        text: "Original input",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("provides valid, distinct system identifiers and an ISO clock", () => {
    const ids = createSystemIdSource();

    expect(ids.clientSession()).not.toBe(ids.clientSession());
    expect(ids.event()).not.toBe(ids.event());
    expect(ids.idempotency()).not.toBe(ids.idempotency());
    expect(ids.request()).not.toBe(ids.request());
    expect(ids.attempt()).not.toBe(ids.attempt());
    expect(ids.approvalEffect(ApprovalIdSchema.parse("approval:1"))).toBe("workspace:approval:1");
    expect(createSystemClock().now()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an invalid client version before building the application", async () => {
    await expect(
      createStudentApplication({
        agent: new FixtureAgent(),
        clientVersion: "latest",
        projectRoot: "/unused",
        server: new FixtureServer(),
        stateDirectory: "/also-unused",
        studentInterface: new FixtureInterface(),
        workspace: new FixtureWorkspace(),
      }),
    ).rejects.toThrow();
  });

  it("builds and disposes the concrete production integration without project-local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-production-"));
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    try {
      const application = await createProductionStudentApplication({
        clientVersion: "1.0.0",
        projectRoot,
        serverUrl: "https://teacher.example",
        stateDirectory,
        studentInterface: new FixtureInterface(),
      });

      expect(application.controller).toBeDefined();
      const closures: string[] = [];
      const observed = await createProductionStudentApplication(
        {
          clientVersion: "1.0.0",
          projectRoot,
          serverUrl: "https://teacher.example",
          stateDirectory: join(root, "observed-state"),
          studentInterface: new FixtureInterface(),
        },
        (checkpoint) => {
          closures.push(checkpoint.kind);
        },
      );
      observed.dispose();
      observed.dispose();
      expect(closures).toEqual(["marea-agent-checkpoint"]);
      application.dispose();
      await expect(
        import("node:fs/promises").then(({ lstat }) =>
          lstat(join(stateDirectory, "agent", "checkpoints.bin")),
        ),
      ).resolves.toBeDefined();
      await expect(
        import("node:fs/promises").then(({ lstat }) => lstat(join(projectRoot, ".marea"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("delegates model authorization through the controller's renewable lease", async () => {
    const binding = new StudentRunTokenBinding();
    expect(() => binding.read()).toThrow("controller is not ready");
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    setFixtureLeaseExpiry(fixture.state);
    binding.bind(fixture.controller);

    await expect(binding.read()).resolves.toBe(RUN_TOKEN);

    expect(fixture.server.renewCalls).toBe(1);
    expect(fixture.state.state.run?.leaseExpiresAt).toBe("2026-09-03T10:10:00.000Z");
  });

  it("runs the interactive lifecycle through exit and disposes resources", async () => {
    await withFixtureApplication("marea-main-", async ({ controller, server }) => {
      let disposed = 0;
      const started: object[] = [];
      await runInteractiveMarea({
        controller,
        dispose: () => {
          disposed += 1;
        },
        onStarted: (session) => {
          started.push(session);
        },
        projectDisplayName: "Project One",
        waitForExit: async () => undefined,
      });
      expect(server.closeCalls).toBe(1);
      expect(disposed).toBe(1);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ projectDisplayName: "Project One" });
    });
  });

  it("closes fatally when the interactive host fails and always disposes", async () => {
    await withFixtureApplication("marea-main-failure-", async ({ controller, server }) => {
      let disposed = false;
      await expect(
        runInteractiveMarea({
          controller,
          dispose: () => {
            disposed = true;
          },
          projectDisplayName: "Project One",
          waitForExit: async () => {
            throw new Error("host failed");
          },
        }),
      ).rejects.toThrow("host failed");
      expect(server.closeCalls).toBe(1);
      expect(disposed).toBe(true);
    });
  });
});
