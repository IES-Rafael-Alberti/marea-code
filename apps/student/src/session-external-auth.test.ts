/* eslint-disable @typescript-eslint/require-await */
import {
  IdentityProviderIdSchema,
  type ExternalAuthBeginRequest,
  type ExternalAuthBeginResponse,
  type ExternalAuthCompleteRequest,
  type ExternalAuthCompleteResponse,
  type ExternalAuthProvidersRequest,
  type ExternalAuthProvidersResponse,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { ExternalAuthorization } from "./contracts.js";
import { FixtureServer, SESSION_TOKEN, createFixtureController } from "./student.fixture.js";

const PROVIDER = {
  providerId: IdentityProviderIdSchema.parse("org.example.idp"),
  displayName: { es: "Centro", en: "School", eu: "Ikastetxea" },
};
const FLOW = "f".repeat(32);

class ExternalServer extends FixtureServer {
  readonly discovered: ExternalAuthProvidersRequest[] = [];
  readonly begun: ExternalAuthBeginRequest[] = [];
  readonly completed: ExternalAuthCompleteRequest[] = [];
  discovery: "ok" | "fail" | "unrelated" = "ok";

  async externalProviders(
    request: ExternalAuthProvidersRequest,
  ): Promise<ExternalAuthProvidersResponse> {
    this.discovered.push(request);
    if (this.discovery === "fail") throw new Error("offline");
    return {
      kind: "external-auth-providers",
      protocolVersion: "0.1",
      requestId: this.discovery === "ok" ? request.requestId : ("other" as never),
      providers: [PROVIDER],
    };
  }

  async beginExternal(request: ExternalAuthBeginRequest): Promise<ExternalAuthBeginResponse> {
    this.begun.push(request);
    return {
      kind: "external-auth-started",
      protocolVersion: "0.1",
      requestId: request.requestId,
      flowId: FLOW,
      authorizationUrl: "https://accounts.example.test/auth",
      expiresAt: "2026-09-03T10:10:00.000Z",
    };
  }

  async completeExternal(
    request: ExternalAuthCompleteRequest,
  ): Promise<ExternalAuthCompleteResponse> {
    this.completed.push(request);
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
}

class RecordingAuthorization implements ExternalAuthorization {
  readonly opened: string[] = [];
  skipStart = false;

  async authorize(start: (redirectUri: string) => Promise<string>) {
    if (!this.skipStart) this.opened.push(await start("http://127.0.0.1:4321/callback"));
    return { code: "4/code", state: "s".repeat(32) };
  }
}

function fixture(
  options: {
    readonly capability?: boolean;
    readonly server?: FixtureServer;
    readonly authorization?: ExternalAuthorization | null;
  } = {},
) {
  const server = options.server ?? new ExternalServer();
  if (options.capability !== false) server.extraCapabilities = ["marea.auth.external"];
  const authorization =
    options.authorization === undefined ? new RecordingAuthorization() : options.authorization;
  const test = createFixtureController({
    server,
    ...(authorization === null ? {} : { externalAuthorization: authorization }),
  });
  test.studentInterface.authKind = "external";
  return { ...test, authorization };
}

describe("external sign-in from the student client", () => {
  it("offers the announced providers and exchanges the provider answer for a session", async () => {
    const test = fixture();
    const server = test.server as ExternalServer;
    await expect(test.controller.start("Project One")).resolves.toMatchObject({
      classroomDisplayName: "Class One",
    });
    expect(test.studentInterface.authenticationOptions).toEqual([{ providers: [PROVIDER] }]);
    expect(server.discovered).toEqual([
      expect.objectContaining({ kind: "external-auth-providers-query", protocolVersion: "0.1" }),
    ]);
    expect(server.begun).toEqual([
      expect.objectContaining({
        kind: "external-auth-begin",
        protocolVersion: "0.1",
        providerId: "org.example.idp",
        redirectUri: "http://127.0.0.1:4321/callback",
      }),
    ]);
    expect((test.authorization as RecordingAuthorization).opened).toEqual([
      "https://accounts.example.test/auth",
    ]);
    expect(server.completed).toEqual([
      expect.objectContaining({
        kind: "external-auth-complete",
        protocolVersion: "0.1",
        flowId: FLOW,
        state: "s".repeat(32),
        code: "4/code",
      }),
    ]);
    expect(test.credentials.token).toBe(SESSION_TOKEN);
  });

  it.each([
    ["the server does not announce external sign-in", { capability: false }],
    ["the server client cannot discover providers", { server: new FixtureServer() }],
  ] as const)("offers no provider when %s", async (_, options) => {
    const test = fixture({ ...options, authorization: null });
    test.studentInterface.authKind = "login";
    await test.controller.start("Project One");
    expect(test.studentInterface.authenticationOptions).toEqual([{ providers: [] }]);
  });

  it.each(["fail", "unrelated"] as const)(
    "hides providers when discovery is %s",
    async (discovery) => {
      const server = new ExternalServer();
      server.discovery = discovery;
      const test = fixture({ server });
      test.studentInterface.authKind = "login";
      await test.controller.start("Project One");
      expect(test.studentInterface.authenticationOptions).toEqual([{ providers: [] }]);
    },
  );

  it("refuses external sign-in without a loopback receiver or server support", async () => {
    await expect(fixture({ authorization: null }).controller.start("Project One")).rejects.toThrow(
      "External sign-in is unavailable in this Marea client.",
    );
    for (const method of ["beginExternal", "completeExternal"] as const) {
      const server = new ExternalServer();
      Object.defineProperty(server, method, { value: undefined });
      await expect(fixture({ server }).controller.start("Project One")).rejects.toThrow(
        "External sign-in is unavailable in this Marea client.",
      );
    }
  });

  it("rejects a provider answer that no flow requested", async () => {
    const authorization = new RecordingAuthorization();
    authorization.skipStart = true;
    const test = fixture({ authorization });
    await expect(test.controller.start("Project One")).rejects.toThrow(
      "The external sign-in did not start.",
    );
    expect((test.server as ExternalServer).completed).toEqual([]);
  });
});
