/* eslint-disable @typescript-eslint/require-await */
import {
  IdentityProviderIdSchema,
  type ExternalAuthBeginRequest,
  type ExternalAuthBeginResponse,
  type ExternalAuthCompleteRequest,
  type ExternalAuthCompleteResponse,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ExternalAuthorization, StudentInterface, StudentServer } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import { exchangeExternal } from "./session-sign-in.js";
import { FixtureIds, FixtureServer, SESSION_TOKEN } from "./student.fixture.js";

const PROVIDER_ID = IdentityProviderIdSchema.parse("org.example.idp");

function successfulResponse(request: ExternalAuthCompleteRequest): ExternalAuthCompleteResponse {
  return {
    kind: "external-authenticated",
    protocolVersion: "0.1",
    requestId: request.requestId,
    principal: { role: "student", displayName: "Student One" },
    session: {
      token: SESSION_TOKEN,
      issuedAt: "2026-09-03T10:00:00.000Z",
      expiresAt: "2026-09-03T10:30:00.000Z",
    },
  };
}

class ExternalFixtureServer extends FixtureServer {
  readonly completed: ExternalAuthCompleteRequest[] = [];
  complete: (request: ExternalAuthCompleteRequest) => Promise<ExternalAuthCompleteResponse>;

  constructor(
    complete: (request: ExternalAuthCompleteRequest) => Promise<ExternalAuthCompleteResponse>,
  ) {
    super();
    this.complete = complete;
  }

  async beginExternal(request: ExternalAuthBeginRequest): Promise<ExternalAuthBeginResponse> {
    return {
      kind: "external-auth-started",
      protocolVersion: "0.1",
      requestId: request.requestId,
      flowId: "f".repeat(32),
      authorizationUrl: "https://accounts.example.test/auth",
      expiresAt: "2026-09-03T10:10:00.000Z",
    };
  }

  async completeExternal(
    request: ExternalAuthCompleteRequest,
  ): Promise<ExternalAuthCompleteResponse> {
    this.completed.push(request);
    return this.complete(request);
  }
}

const authorization: ExternalAuthorization = {
  async authorize(start) {
    expect(await start("http://127.0.0.1:4321/callback")).toEqual({
      authorizationUrl: "https://accounts.example.test/auth",
      expiresAt: "2026-09-03T10:10:00.000Z",
    });
    return { code: "4/code", state: "s".repeat(32) };
  },
};

function options(
  server: StudentServer,
  sleep: (milliseconds: number) => Promise<void>,
): Parameters<typeof exchangeExternal>[0] {
  return {
    externalAuthorization: authorization,
    ids: new FixtureIds(),
    retryJitter: () => 0,
    server,
    sleep,
    studentInterface: {} as StudentInterface,
  };
}

describe("external sign-in completion retry", () => {
  it("retries a retryable 503 completion with the same flow and succeeds", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
    let calls = 0;
    const server = new ExternalFixtureServer(async (request) => {
      calls += 1;
      if (calls <= 2) throw new StudentHttpError(503, "server.error", true);
      return successfulResponse(request);
    });

    await expect(exchangeExternal(options(server, sleep), PROVIDER_ID)).resolves.toBe(
      SESSION_TOKEN,
    );
    expect(server.completed).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 2_000]);
    expect(new Set(server.completed.map((request) => request.flowId)).size).toBe(1);
    expect(new Set(server.completed.map((request) => request.state)).size).toBe(1);
    expect(new Set(server.completed.map((request) => request.code)).size).toBe(1);
  });

  it("stops after three attempts when the completion stays busy", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
    const server = new ExternalFixtureServer(async () => {
      throw new StudentHttpError(503, "server.error", true);
    });

    await expect(exchangeExternal(options(server, sleep), PROVIDER_ID)).rejects.toMatchObject({
      status: 503,
    });
    expect(server.completed).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 rejection", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
    const server = new ExternalFixtureServer(async () => {
      throw new StudentHttpError(401, "auth.invalid", false);
    });

    await expect(exchangeExternal(options(server, sleep), PROVIDER_ID)).rejects.toMatchObject({
      status: 401,
    });
    expect(server.completed).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
