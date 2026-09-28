import {
  CredentialLoginRequestSchema,
  TelemetryPreviewRequestSchema,
  TELEMETRY_PREVIEW_PATH,
} from "@marea/protocol";
import {
  createOperationalTelemetry,
  type OperationalTelemetryRuntime,
} from "@marea/telemetry-pipeline";
import { NodeSqliteTestDatabase } from "../../test-support/node-sqlite-database.boundary.js";
import { seedTeachingDatabase } from "../../test-support/teaching-integration.fixture.js";
import { IdentityService } from "../identity/identity-service.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
} from "../identity/system-security.boundary.js";
import { SqliteIdentityRepository } from "../platform/persistence/sqlite-identity-repository.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";
import { createTelemetryPreviewService } from "./preview-service.js";
import { createTelemetryPreviewHttp } from "./preview-http.boundary.js";

export const previewRequest = TelemetryPreviewRequestSchema.parse({
  protocolVersion: "0.1",
  kind: "telemetry-preview",
  requestId: "request:preview",
  classId: "class:one",
});
export const origin = "https://dashboard.test";
const allowedHosts = ["teacher.test"];

export function previewFixture(
  telemetry: OperationalTelemetryRuntime = createOperationalTelemetry(),
) {
  const database = new NodeSqliteTestDatabase();
  seedTeachingDatabase(database);
  database.execute("UPDATE marea_users SET login = 'user-' || id");
  const identity = new IdentityService({
    repository: new SqliteIdentityRepository(database),
    clock: { now: () => "2026-09-22T10:00:00.000Z" },
    ids: cryptoIdGenerator,
    secrets: cryptoSecretIssuer,
    digest: createHmacSecretDigest(new Uint8Array(32).fill(8)),
    dummyPasswordHash: "synthetic-hash",
    passwords: {
      hash: () => Promise.resolve("synthetic-hash"),
      verify: (password, hash) =>
        Promise.resolve(password === "synthetic-password" && hash === "synthetic-hash"),
    },
  });
  const membership = new SqliteTeachingConfigurationRepository(database);
  const service = createTelemetryPreviewService({ membership, telemetry });
  const app = createTelemetryPreviewHttp({
    allowedHosts,
    allowedOrigins: [origin],
    identity,
    service,
  });
  return {
    database,
    identity,
    service,
    app,
    async cookie(login = "t1") {
      const result = await identity.login(
        CredentialLoginRequestSchema.parse({
          protocolVersion: "0.1",
          kind: "credential-login",
          requestId: "request:login",
          credentials: { login: `user-${login}`, password: "synthetic-password" },
        }),
      );
      return `marea_teacher_session=${result.session.token}`;
    },
  };
}

export function previewHttpRequest(
  cookie: string,
  body: object = previewRequest,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`https://teacher.test${TELEMETRY_PREVIEW_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "teacher.test",
      origin,
      cookie,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
