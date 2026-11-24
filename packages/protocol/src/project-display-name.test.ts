import { describe, expect, it } from "vitest";

import { ClassBootstrapResponseSchema } from "./bootstrap.js";
import { ClassSessionItemSchema } from "./class-history.js";
import { ActiveRunDashboardResponseSchema } from "./dashboard.js";
import { SessionHistoryItemSchema } from "./history.js";
import { OpenRunRequestSchema } from "./runs.js";
import { ProjectDisplayNameSchema, SafeDisplayNameSchema } from "./technical.js";

const at = "2026-11-23T08:44:29.861Z";
const listed = (projectDisplayName: string) => ({
  runId: "run:project-name",
  studentDisplayName: "Daniel",
  classDisplayName: "DWEC",
  projectDisplayName,
  state: "active",
  openedAt: at,
  closedAt: null,
});

/** Every protocol message that carries a project name, by direction. */
const carriers = {
  "open request": (name: string) =>
    OpenRunRequestSchema.safeParse({
      clientSessionId: "client:project-name",
      clientVersion: "0.1.0-preview.42",
      idempotencyKey: "open:project-name",
      intent: { kind: "new" },
      project: { displayName: name },
      protocolVersion: "0.1",
      requestId: "request:project-name",
    }).success,
  "student history": (name: string) => SessionHistoryItemSchema.safeParse(listed(name)).success,
  "class history": (name: string) =>
    ClassSessionItemSchema.safeParse({ ...listed(name), classId: "class:main" }).success,
  "active runs": (name: string) =>
    ActiveRunDashboardResponseSchema.safeParse({
      kind: "active-runs-response",
      protocolVersion: "0.1",
      requestId: "request:active",
      generatedAt: at,
      viewer: { role: "teacher", displayName: "Profe" },
      runs: [
        {
          runId: "run:project-name",
          studentDisplayName: "Daniel",
          classId: "class:dwec",
          classDisplayName: "DWEC",
          projectDisplayName: name,
          state: "active",
          startedAt: at,
          lastActivityAt: at,
          highestDurableSequence: 1,
          pendingApproval: false,
        },
      ],
      nextCursor: null,
    }).success,
  "student bootstrap": (name: string) =>
    ClassBootstrapResponseSchema.safeParse({
      kind: "class-bootstrapped",
      protocolVersion: "0.1",
      requestId: "request:bootstrap",
      principal: { role: "student", displayName: "Daniel" },
      classroom: { displayName: "DWEC" },
      modelAlias: "marea",
      activeRun: { runId: "run:project-name", projectDisplayName: name, state: "active" },
    }).success,
};

const OPENABLE = [
  "Fooddie-Aplicacion_de_eleccion_de_platos",
  "Proyecto (copia)",
  "mi_proyecto",
  "Diseño de Interfaces Web",
  "2ºDAW",
  "o'brien.v2",
  "p".repeat(120),
];
const REFUSED = ["", "C++", "tarea#2", ".oculto", "a/b", "../private", "a\nb", "‮secret"];

describe("project display names", () => {
  it.each(Object.keys(carriers))("lets %s carry every name that can open a run", (carrier) => {
    const accepts = carriers[carrier as keyof typeof carriers];
    for (const name of OPENABLE) expect(accepts(name), name).toBe(true);
    for (const name of [...REFUSED, "p".repeat(121)]) expect(accepts(name), name).toBe(false);
  });

  it("keeps person and class names on the stricter display name rule", () => {
    expect(ProjectDisplayNameSchema.parse("  mi_proyecto (2)  ")).toBe("mi_proyecto (2)");
    expect(SafeDisplayNameSchema.safeParse("mi_proyecto").success).toBe(false);
    expect(SafeDisplayNameSchema.safeParse("Proyecto (copia)").success).toBe(false);
  });
});
