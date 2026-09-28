import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { TelemetryPreviewResponseSchema } from "@marea/protocol";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "../teacher-host/teacher-host.fixture.js";
import { startTeacherHost } from "../teacher-host/teacher-host.js";
import { previewHttpRequest, previewRequest } from "../../telemetry/preview.fixture.js";
import { request } from "../../product-http/product-http.fixture.js";

afterEach(cleanupTeacherHostInstallations);

it("mounts authenticated disabled preview on the production host's drained product dispatcher", async () => {
  const f = teacherHostInstallation();
  const database = openSqliteDatabaseFile({ databasePath: f.databasePath });
  database.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'one', 'Synthetic telemetry class')",
  );
  database.database.execute(
    "INSERT INTO marea_teacher_classes VALUES ('user:teacher', 'class:one')",
  );
  database.close();
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords: {
      hash: (value) => Promise.resolve(`hash:${value}`),
      verify: (value, digest) => Promise.resolve(digest === `hash:${value}`),
    },
    onEvaluationError: () => undefined,
  });
  if (host.state !== "ready") throw new Error(host.reason);
  try {
    const fetch = f.served.fetch as (input: Request) => Promise<Response>;
    const login = await fetch(
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:telemetry-login",
      }),
    );
    expect(login.status).toBe(200);
    const cookie = String(login.headers.get("set-cookie")).split(";")[0] ?? "";
    const response = await fetch(previewHttpRequest(cookie));
    expect(response.status).toBe(200);
    expect(TelemetryPreviewResponseSchema.parse(await response.json())).toMatchObject({
      enabled: false,
      destinationCount: 0,
      synthetic: true,
    });
    expect(
      (await fetch(previewHttpRequest(cookie, previewRequest, { origin: "https://foreign.test" })))
        .status,
    ).toBe(403);
    expect(
      (await fetch(previewHttpRequest(cookie, previewRequest, { host: "foreign.test" }))).status,
    ).toBe(403);
  } finally {
    await host.stop();
  }
});
