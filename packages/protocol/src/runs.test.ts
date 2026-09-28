import { describe, expect, it } from "vitest";

import {
  AgentModeSchema,
  CloseRunReasonSchema,
  CloseRunRequestSchema,
  CloseRunResponseSchema,
  OpenRunRequestSchema,
  OpenRunResponseSchema,
  RenewRunLeaseRequestSchema,
  RenewRunLeaseResponseSchema,
  Sha256DigestSchema,
  textDigestBytes,
  UtcTimestampSchema,
} from "./runs.js";

const digest = `sha256:${"a".repeat(64)}`;

const validOpenRequest = {
  protocolVersion: "0.1",
  clientVersion: "0.1.0",
  requestId: "request-1",
  idempotencyKey: "open-attempt-1",
  clientSessionId: "local-session-1",
  project: { displayName: "Aplicación del tiempo" },
  intent: { kind: "new" },
} as const;

const validOpenResponse = {
  protocolVersion: "0.1",
  requestId: "request-1",
  highestDurableSequence: 1,
  lease: {
    runId: "run-1",
    token: "base64url_token_value_with_safe_length_1234",
    issuedAt: "2026-09-03T10:00:00.000Z",
    expiresAt: "2026-09-03T10:10:00.000Z",
  },
  snapshot: {
    id: "snapshot-1",
    agentMode: "tutoring",
    modelAlias: "marea",
    prompt: {
      version: "prompt-1",
      digest,
      content: "Guide the student with questions.",
    },
    didacticSkills: [
      { id: "marea/testing", digest },
      { id: "teacher/t-1/api-testing", digest },
      { id: "center/center-1/refactoring", digest },
    ],
    teacherToolPolicy: {
      version: "policy-1",
      restrictions: [
        { tool: "write_file", effect: "require-approval" },
        { tool: "execute", effect: "deny" },
      ],
    },
  },
} as const;

const conflictingRestrictionResponse = {
  ...validOpenResponse,
  snapshot: {
    ...validOpenResponse.snapshot,
    teacherToolPolicy: {
      ...validOpenResponse.snapshot.teacherToolPolicy,
      restrictions: [
        { tool: "execute", effect: "deny" },
        { tool: "execute", effect: "require-approval" },
      ],
    },
  },
} as const;

describe("run protocol", () => {
  it("parses new and authenticated-session resume requests", () => {
    expect(OpenRunRequestSchema.parse(validOpenRequest).intent.kind).toBe("new");
    expect(
      OpenRunRequestSchema.parse({
        ...validOpenRequest,
        intent: { kind: "resume" },
        runId: "run-1",
      }).runId,
    ).toBe("run-1");
    expect(
      OpenRunRequestSchema.parse({ ...validOpenRequest, intent: { kind: "resume" } }).intent.kind,
    ).toBe("resume");
    expect(() => OpenRunRequestSchema.parse({ ...validOpenRequest, runId: "run-1" })).toThrow(
      "A run identity may only accompany a resume intent.",
    );
  });

  it("normalizes surrounding project-name whitespace", () => {
    const request = OpenRunRequestSchema.parse({
      ...validOpenRequest,
      project: { displayName: "  Weather lab  " },
    });

    expect(request.project.displayName).toBe("Weather lab");
  });

  it.each(["studentId", "classId", "previousRunId", "absoluteWorkingDirectory"])(
    "rejects client-supplied authority field %s",
    (field) => {
      expect(() =>
        OpenRunRequestSchema.parse({ ...validOpenRequest, [field]: "private" }),
      ).toThrow();
    },
  );

  it.each([
    "/Users/Ana/private",
    "C:\\Users\\Ana\\private",
    "\\\\server\\share",
    "../private",
    "project\nforged-log",
    "\u202esecret",
    ".",
    "..",
  ])("rejects project path or control value %s", (displayName) => {
    expect(() =>
      OpenRunRequestSchema.parse({
        ...validOpenRequest,
        project: { displayName },
      }),
    ).toThrow();
  });

  it("parses a deeply readonly student-safe snapshot", () => {
    const response = OpenRunResponseSchema.parse(validOpenResponse);

    expect(response.highestDurableSequence).toBe(1);
    expect(response.snapshot.modelAlias).toBe("marea");
    expect(response.snapshot.didacticSkills).toHaveLength(3);
    expect(response.snapshot.teacherToolPolicy.restrictions).toEqual([
      { tool: "write_file", effect: "require-approval" },
      { tool: "execute", effect: "deny" },
    ]);
    expect(Object.isFrozen(response.snapshot)).toBe(true);
    expect(Object.isFrozen(response.snapshot.didacticSkills)).toBe(true);
  });

  it.each([-1, 1.5])("rejects invalid durable sequence %s", (highestDurableSequence) => {
    expect(() =>
      OpenRunResponseSchema.parse({ ...validOpenResponse, highestDurableSequence }),
    ).toThrow();
  });

  it("accepts each public agent mode", () => {
    expect(AgentModeSchema.parse("tutoring")).toBe("tutoring");
    expect(AgentModeSchema.parse("free")).toBe("free");
  });

  it("requires an exact lowercase SHA-256 digest", () => {
    expect(Sha256DigestSchema.parse(digest)).toBe(digest);
    expect(() => Sha256DigestSchema.parse(`prefix-${digest}`)).toThrow();
    expect(() => Sha256DigestSchema.parse(`${digest}-suffix`)).toThrow();
  });

  it("accepts UTC timestamps and rejects offset timestamps", () => {
    expect(UtcTimestampSchema.parse("2026-09-03T10:00:00Z")).toBe("2026-09-03T10:00:00Z");
    expect(() => UtcTimestampSchema.parse("2026-09-03T11:00:00+01:00")).toThrow();
  });

  it.each(["provider", "upstreamModel", "apiKey", "telemetrySecret"])(
    "rejects private response field %s",
    (field) => {
      expect(() =>
        OpenRunResponseSchema.parse({
          ...validOpenResponse,
          snapshot: { ...validOpenResponse.snapshot, [field]: "private" },
        }),
      ).toThrow();
    },
  );

  it("rejects policy relaxation, duplicate entries, and an expired lease", () => {
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        snapshot: {
          ...validOpenResponse.snapshot,
          teacherToolPolicy: {
            ...validOpenResponse.snapshot.teacherToolPolicy,
            restrictions: [{ tool: "execute", effect: "allow" }],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        snapshot: {
          ...validOpenResponse.snapshot,
          didacticSkills: [
            validOpenResponse.snapshot.didacticSkills[0],
            validOpenResponse.snapshot.didacticSkills[0],
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        lease: {
          ...validOpenResponse.lease,
          expiresAt: validOpenResponse.lease.issuedAt,
        },
      }),
    ).toThrow();
  });

  it("compares lease instants rather than timestamp text", () => {
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        lease: {
          ...validOpenResponse.lease,
          issuedAt: "2026-09-03T10:00:00Z",
          expiresAt: "2026-09-03T10:00:00.001Z",
        },
      }),
    ).not.toThrow();
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        lease: {
          ...validOpenResponse.lease,
          issuedAt: "2026-09-04T00:00:00Z",
          expiresAt: "2026-09-03T23:59:59.999Z",
        },
      }),
    ).toThrow();
  });

  it("rejects conflicting teacher restrictions and oversized prompt content", () => {
    expect(() => OpenRunResponseSchema.parse(conflictingRestrictionResponse)).toThrow();
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        snapshot: {
          ...validOpenResponse.snapshot,
          prompt: {
            ...validOpenResponse.snapshot.prompt,
            content: "á".repeat(131_073),
          },
        },
      }),
    ).toThrow();
  });

  it("accepts prompt content at the exact UTF-8 byte limit", () => {
    const response = OpenRunResponseSchema.parse({
      ...validOpenResponse,
      snapshot: {
        ...validOpenResponse.snapshot,
        prompt: {
          ...validOpenResponse.snapshot.prompt,
          content: "a".repeat(256 * 1_024),
        },
      },
    });

    expect(response.snapshot.prompt.content).toHaveLength(256 * 1_024);
  });

  it("returns stable diagnostics for snapshot invariants", () => {
    const duplicateSkills = OpenRunResponseSchema.safeParse({
      ...validOpenResponse,
      snapshot: {
        ...validOpenResponse.snapshot,
        didacticSkills: [
          validOpenResponse.snapshot.didacticSkills[0],
          validOpenResponse.snapshot.didacticSkills[0],
        ],
      },
    });
    const duplicateRestrictions = OpenRunResponseSchema.safeParse(conflictingRestrictionResponse);
    const expiredLease = OpenRunResponseSchema.safeParse({
      ...validOpenResponse,
      lease: {
        ...validOpenResponse.lease,
        expiresAt: validOpenResponse.lease.issuedAt,
      },
    });
    const oversizedPrompt = OpenRunResponseSchema.safeParse({
      ...validOpenResponse,
      snapshot: {
        ...validOpenResponse.snapshot,
        prompt: {
          ...validOpenResponse.snapshot.prompt,
          content: "a".repeat(256 * 1_024 + 1),
        },
      },
    });

    expect(duplicateSkills).toMatchObject({
      success: false,
      error: { issues: [{ message: "Didactic skill identifiers must be unique." }] },
    });
    expect(duplicateRestrictions).toMatchObject({
      success: false,
      error: { issues: [{ message: "Each tool may have at most one teacher restriction." }] },
    });
    expect(expiredLease).toMatchObject({
      success: false,
      error: { issues: [{ message: "Run lease must expire after issue." }] },
    });
    expect(oversizedPrompt).toMatchObject({
      success: false,
      error: {
        issues: [{ message: "Prompt content must be at most 262144 UTF-8 bytes." }],
      },
    });
  });

  it("rejects a real model name in place of the public alias", () => {
    expect(() =>
      OpenRunResponseSchema.parse({
        ...validOpenResponse,
        snapshot: {
          ...validOpenResponse.snapshot,
          modelAlias: "provider/model-real",
        },
      }),
    ).toThrow();
  });

  it.each([
    { clientVersion: "0.1.0\nforged" },
    { promptVersion: "prompt\nforged" },
    { policyVersion: "policy\u202eforged" },
    { tool: "execute\nforged" },
  ])("rejects injected technical identifiers", (injection) => {
    const request = {
      ...validOpenRequest,
      clientVersion: injection.clientVersion ?? validOpenRequest.clientVersion,
    };
    const response = {
      ...validOpenResponse,
      snapshot: {
        ...validOpenResponse.snapshot,
        prompt: {
          ...validOpenResponse.snapshot.prompt,
          version: injection.promptVersion ?? validOpenResponse.snapshot.prompt.version,
        },
        teacherToolPolicy: {
          ...validOpenResponse.snapshot.teacherToolPolicy,
          version: injection.policyVersion ?? validOpenResponse.snapshot.teacherToolPolicy.version,
          restrictions: [
            {
              tool:
                injection.tool ?? validOpenResponse.snapshot.teacherToolPolicy.restrictions[0].tool,
              effect: "deny" as const,
            },
          ],
        },
      },
    };

    expect(
      OpenRunRequestSchema.safeParse(request).success &&
        OpenRunResponseSchema.safeParse(response).success,
    ).toBe(false);
  });

  it("defines prompt digests over exact UTF-8 content bytes", async () => {
    const bytes = textDigestBytes("línea\n");
    const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
    const hexadecimal = [...hashed].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    expect([...bytes]).toEqual([0x6c, 0xc3, 0xad, 0x6e, 0x65, 0x61, 0x0a]);
    expect(hexadecimal).toBe("f1352bbdc3de160a816774a9b2820f1ebe6ad26f7f6d954f46bc25eb4fc69de8");
  });

  it("parses correlated idempotent close messages", () => {
    expect(
      CloseRunRequestSchema.parse({
        protocolVersion: "0.1",
        requestId: "request-close-1",
        reason: "student-exit",
      }).reason,
    ).toBe("student-exit");
    expect(
      CloseRunResponseSchema.parse({
        protocolVersion: "0.1",
        requestId: "request-close-1",
        runId: "run-1",
        state: "closed",
        alreadyClosed: true,
      }).alreadyClosed,
    ).toBe(true);
  });

  it("parses strict correlated lease renewal messages", () => {
    const request = RenewRunLeaseRequestSchema.parse({
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request-renew-1",
      runId: "run-1",
    });
    const response = RenewRunLeaseResponseSchema.parse({
      kind: "run-lease-renewed",
      protocolVersion: "0.1",
      requestId: request.requestId,
      lease: validOpenResponse.lease,
    });

    expect(response.requestId).toBe(request.requestId);
    expect(() =>
      RenewRunLeaseRequestSchema.parse({ ...request, studentId: "user-forged" }),
    ).toThrow();
    expect(() => RenewRunLeaseResponseSchema.parse({ ...response, provider: "private" })).toThrow();
  });

  it.each(["student-exit", "cancelled", "composition-failed", "fatal-error"])(
    "accepts close reason %s",
    (reason) => {
      expect(CloseRunReasonSchema.parse(reason)).toBe(reason);
    },
  );

  it("rejects an empty close reason", () => {
    expect(() => CloseRunReasonSchema.parse("")).toThrow();
  });
});
