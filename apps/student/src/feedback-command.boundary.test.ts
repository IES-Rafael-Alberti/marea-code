import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTranslator } from "@marea/i18n";
import {
  AcknowledgeNoticeResponseSchema,
  PendingNoticesRequestSchema,
  PendingNoticesResponseSchema,
  SessionTokenSchema,
} from "@marea/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runFeedbackCommand,
  type FeedbackCommandOptions,
  type FeedbackCommandRuntime,
} from "./feedback-command.boundary.js";
import { createFileStudentStores } from "./filesystem.boundary.js";

const TOKEN = SessionTokenSchema.parse("s".repeat(32));
const envelope = { protocolVersion: "0.1", requestId: "request:feedback" };
const notice = {
  noticeId: "notice:one",
  runId: "run:one",
  source: "approved-evaluation",
  teacherDisplayName: "Teacher Ada",
  text: "Reviewed feedback.\nTry one more test.",
  createdAt: "2026-09-08T08:00:00.000Z",
};

function setup() {
  const output = { write: vi.fn(), error: vi.fn() };
  const options: FeedbackCommandOptions = {
    projectRoot: "/project",
    stateDirectory: "/state",
    serverUrl: "https://teacher.test",
    noticeId: null,
    translator: createTranslator("en"),
    output,
  };
  const credentials = { load: vi.fn().mockResolvedValue(TOKEN), save: vi.fn(), clear: vi.fn() };
  const server = {
    pendingNotices: vi.fn().mockResolvedValue(
      PendingNoticesResponseSchema.parse({
        ...envelope,
        kind: "pending-notices-response",
        notices: [notice],
      }),
    ),
    acknowledgeNotice: vi.fn().mockResolvedValue(
      AcknowledgeNoticeResponseSchema.parse({
        ...envelope,
        kind: "teacher-notice-acknowledged",
        noticeId: notice.noticeId,
        acknowledgedAt: notice.createdAt,
      }),
    ),
  };
  const runtime: FeedbackCommandRuntime = {
    stores: vi.fn().mockResolvedValue({ credentials }),
    server: vi.fn(() => server),
    requestId: () => envelope.requestId,
  };
  return { options, runtime, credentials, server, output };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("student feedback command", () => {
  it("reads notices without consuming them or starting a run", async () => {
    const { options, runtime, credentials, server, output } = setup();
    for (let read = 0; read < 2; read++) expect(await runFeedbackCommand(options, runtime)).toBe(0);
    expect(runtime.stores).toHaveBeenCalledWith({
      projectRoot: "/project",
      stateDirectory: "/state",
    });
    expect(runtime.server).toHaveBeenCalledWith("https://teacher.test");
    expect(server.pendingNotices).toHaveBeenCalledWith(TOKEN, {
      ...envelope,
      kind: "pending-notices-query",
      limit: 32,
    });
    expect(server.acknowledgeNotice).not.toHaveBeenCalled();
    expect(output.write.mock.calls.slice(0, 3)).toEqual([
      ["Pending teacher feedback (up to 32 notices)\n"],
      [`\nnotice:one · run:one · Teacher Ada\n${notice.text}\n`],
      ["After reading it, mark it as read with: marea feedback --ack notice:one\n"],
    ]);
    expect(output.error).not.toHaveBeenCalled();
    expect(credentials.save).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
  });

  it("only acknowledges the explicitly selected notice and permits safe retries", async () => {
    const { options, runtime, server, output } = setup();
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await runFeedbackCommand({ ...options, noticeId: notice.noticeId }, runtime)).toBe(0);
    expect(server.acknowledgeNotice).toHaveBeenCalledTimes(2);
    expect(server.acknowledgeNotice).toHaveBeenCalledWith(TOKEN, {
      ...envelope,
      kind: "teacher-notice-acknowledge",
      noticeId: notice.noticeId,
    });
    expect(server.pendingNotices).not.toHaveBeenCalled();
    expect(output.write.mock.calls).toEqual([
      ["Feedback marked as read.\n"],
      ["Feedback marked as read.\n"],
    ]);
  });

  it("reports empty feedback and missing saved authentication in the selected language", async () => {
    const { options, runtime, server, credentials, output } = setup();
    server.pendingNotices.mockResolvedValueOnce(
      PendingNoticesResponseSchema.parse({
        ...envelope,
        kind: "pending-notices-response",
        notices: [],
      }),
    );
    expect(
      await runFeedbackCommand({ ...options, translator: createTranslator("es") }, runtime),
    ).toBe(0);
    expect(output.write).toHaveBeenLastCalledWith("No hay feedback docente pendiente.\n");
    credentials.load.mockResolvedValueOnce(null);
    expect(await runFeedbackCommand(options, runtime)).toBe(1);
    expect(output.error).toHaveBeenLastCalledWith(
      "No saved student login for this server and project. Sign in with marea first.\n",
    );
    expect(server.pendingNotices).toHaveBeenCalledOnce();
  });

  it("sanitizes terminal controls while preserving ordinary text, tabs and newlines", async () => {
    const { options, runtime, server, output } = setup();
    server.pendingNotices.mockResolvedValueOnce(
      PendingNoticesResponseSchema.parse({
        ...envelope,
        kind: "pending-notices-response",
        notices: [
          {
            ...notice,
            text: "A\u001b[31mB\u001b[0m\u001b]52;c;clipboard\u0007\u0008\u007f\u0085\u202e\u2066\u2069\nC\tD\rE",
          },
        ],
      }),
    );
    expect(await runFeedbackCommand(options, runtime)).toBe(0);
    expect(output.write.mock.calls[1]).toEqual([
      "\nnotice:one · run:one · Teacher Ada\nAB\nC\tDE\n",
    ]);
  });

  it("keeps transport, credential and acknowledgement failures private", async () => {
    const { options, runtime, credentials, server, output } = setup();
    credentials.load.mockRejectedValueOnce(new Error("private path"));
    expect(await runFeedbackCommand(options, runtime)).toBe(1);
    server.pendingNotices.mockRejectedValueOnce(new Error("private provider data"));
    expect(await runFeedbackCommand(options, runtime)).toBe(1);
    server.acknowledgeNotice.mockRejectedValueOnce(new Error("private key"));
    expect(await runFeedbackCommand({ ...options, noticeId: notice.noticeId }, runtime)).toBe(1);
    expect(await runFeedbackCommand({ ...options, noticeId: "bad/id" }, runtime)).toBe(1);
    expect(output.error.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [
        "Feedback could not be confirmed. Retry the same command; it is safe to repeat.\n",
      ]),
    );
    expect(output.write).not.toHaveBeenCalled();
  });

  it("uses production credential storage and the authenticated HTTP client without constructing an agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-feedback-"));
    try {
      const projectRoot = join(root, "project");
      await mkdir(projectRoot);
      const stateDirectory = join(root, "state");
      const stores = await createFileStudentStores({ projectRoot, stateDirectory });
      await stores.credentials.save(TOKEN);
      const fetch = vi.fn(async (request: Request) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        expect(request.url).toBe("https://teacher.test/v1/notices/pending");
        const query = PendingNoticesRequestSchema.parse(await request.json());
        expect(query.requestId).toMatch(/^request:/u);
        return Promise.resolve(
          Response.json({
            ...envelope,
            requestId: query.requestId,
            kind: "pending-notices-response",
            notices: [notice],
          }),
        );
      });
      vi.stubGlobal("fetch", fetch);
      const { options, output } = setup();
      expect(await runFeedbackCommand({ ...options, projectRoot, stateDirectory })).toBe(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(output.write).toHaveBeenCalledWith(expect.stringContaining(notice.text));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
