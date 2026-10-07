import { expect, it, vi } from "vitest";
import {
  CredentialLoginResponseSchema,
  OpenRunResponseSchema,
  OpenRunRequestSchema,
} from "@marea/protocol";
vi.mock("bun:sqlite", () => import("../operations/retention/retention-bun-sqlite.fixture.js"));
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { request, openRequest } from "../../product-http/product-http.fixture.js";
import { composedHost, login, seededDatabase } from "./teacher-services.fixture.js";
import { syntheticOperatorPolicy } from "../../teaching/configuration/dashboard-module.fixture.js";

async function hostWith(mode: "off" | "normal" | "strict" | undefined, free = false) {
  const base = teachingConfiguration(free ? "free" : "tutoring");
  const host = await composedHost(
    seededDatabase({
      ...base,
      publicTemplate: {
        ...base.publicTemplate,
        ...(mode === undefined ? {} : { socraticMode: mode }),
      },
      providerRoute: syntheticOperatorPolicy.route.providerRoute,
    }),
  );
  const logged = await host.call("/v1/auth/login", login("student", "student-password"));
  const token = CredentialLoginResponseSchema.parse(logged.body).session.token;
  const open = (body: object = openRequest, supported?: string) =>
    host.app.fetch(
      request(
        "/v1/runs/open",
        body,
        token,
        supported === undefined ? {} : { "x-marea-socratic-gate": supported },
      ),
    );
  return { ...host, open };
}
it.each(["normal", "strict"] as const)(
  "requires explicit client support for %s without creating a run or revoking a lease",
  async (mode) => {
    const h = await hostWith(mode);
    for (const header of [undefined, "0", "true"]) {
      const denied = await h.open(openRequest, header);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        error: { code: "protocol.incompatible", retryable: false },
      });
      expect(h.database.readOne("SELECT COUNT(*) AS count FROM marea_runs")).toEqual({ count: 0n });
    }
    expect(() =>
      h.composed.services.runs.open(
        { role: "student", userId: "s1", classId: "class:one", displayName: "Student" },
        OpenRunRequestSchema.parse(openRequest),
      ),
    ).toThrow("protocol.incompatible");
    expect(h.database.readOne("SELECT COUNT(*) AS count FROM marea_runs")).toEqual({ count: 0n });
    const created = await h.open(openRequest, "1");
    expect(created.status).toBe(201);
    const opened = OpenRunResponseSchema.parse(await created.json());
    expect(opened.snapshot.socraticMode).toBe(mode);
    const leases = h.database.readAll("SELECT * FROM marea_run_leases");
    const resume = {
      ...openRequest,
      intent: { kind: "resume" },
      runId: opened.lease.runId,
      idempotencyKey: "resume:socratic",
    };
    expect((await h.open(resume)).status).toBe(409);
    expect(h.database.readAll("SELECT * FROM marea_run_leases")).toEqual(leases);
    expect(h.composed.services.runs.authorizeLease(opened.lease.token).runId).toBe(
      opened.lease.runId,
    );
    const recovered = OpenRunResponseSchema.parse(await (await h.open(resume, "1")).json());
    expect(recovered.snapshot).toEqual(opened.snapshot);
  },
);
it.each([
  [undefined, false],
  ["off", false],
  ["strict", true],
] as const)(
  "keeps baseline 0.1 JSON for legacy, disabled and free-mode runs: %s %s",
  async (mode, free) => {
    const h = await hostWith(mode, free);
    const response = await h.open();
    expect(response.status).toBe(201);
    const old = OpenRunResponseSchema.parse(await response.json());
    expect(old.snapshot).not.toHaveProperty("socraticMode");
    const newer = OpenRunResponseSchema.parse(await (await h.open(openRequest, "1")).json());
    expect(newer.snapshot.socraticMode).toBe(mode);
  },
);
