import { afterEach, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

const composed = vi.hoisted(() => ({ dependencies: [] as unknown[] }));
vi.mock("./teacher-services.js", async (original) => {
  const real = await original<typeof import("./teacher-services.js")>();
  return {
    ...real,
    composeTeacherServices: (dependencies: Parameters<typeof real.composeTeacherServices>[0]) => {
      composed.dependencies.push(dependencies);
      return real.composeTeacherServices(dependencies);
    },
  };
});

import { startTeacherHost } from "./teacher-host.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "./teacher-host.fixture.js";

afterEach(cleanupTeacherHostInstallations);

it("hands the operator's evaluation diagnostic sink to the composed services", async () => {
  const f = teacherHostInstallation();
  const onEvaluationDiagnostic = vi.fn();
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords: {
      hash: (secret: string) => Promise.resolve(`hash:${secret}`),
      verify: (secret: string, hash: string) => Promise.resolve(hash === `hash:${secret}`),
    },
    onEvaluationError: () => undefined,
    onEvaluationDiagnostic,
  });
  if (host.state !== "ready") throw new Error(`host failed: ${host.reason}`);
  try {
    expect(composed.dependencies.at(-1)).toMatchObject({ onEvaluationDiagnostic });
  } finally {
    await host.stop();
  }
});
