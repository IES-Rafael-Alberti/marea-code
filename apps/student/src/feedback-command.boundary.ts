import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import type { Translator } from "@marea/i18n";
import { AcknowledgeNoticeRequestSchema, PendingNoticesRequestSchema } from "@marea/protocol";

import type { CredentialStore } from "./contracts.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { createHttpStudentHistory, type StudentHistoryServer } from "./http-history.boundary.js";

export interface FeedbackCommandOptions {
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly serverUrl: string;
  readonly noticeId: string | null;
  readonly translator: Translator;
  readonly output: { write(text: string): void; error(text: string): void };
}

export interface FeedbackCommandRuntime {
  readonly stores: (options: {
    readonly projectRoot: string;
    readonly stateDirectory: string;
  }) => Promise<{ readonly credentials: CredentialStore }>;
  readonly server: (
    serverUrl: string,
  ) => Pick<StudentHistoryServer, "pendingNotices" | "acknowledgeNotice">;
  readonly requestId: () => string;
}

const production: FeedbackCommandRuntime = {
  stores: createFileStudentStores,
  server: (baseUrl) => createHttpStudentHistory({ baseUrl }),
  requestId: () => `request:${randomUUID()}`,
};

/** Feedback retrieval never opens a run, starts an agent, or implicitly consumes a notice. */
export async function runFeedbackCommand(
  options: FeedbackCommandOptions,
  runtime: FeedbackCommandRuntime = production,
): Promise<number> {
  const { output, translator } = options;
  try {
    const stores = await runtime.stores({
      projectRoot: options.projectRoot,
      stateDirectory: options.stateDirectory,
    });
    const token = await stores.credentials.load();
    if (token === null) {
      output.error(`${translator.t("student.feedback.login-required")}\n`);
      return 1;
    }
    const server = runtime.server(options.serverUrl);
    const envelope = { protocolVersion: "0.1", requestId: runtime.requestId() };
    if (options.noticeId !== null) {
      await server.acknowledgeNotice(
        token,
        AcknowledgeNoticeRequestSchema.parse({
          ...envelope,
          kind: "teacher-notice-acknowledge",
          noticeId: options.noticeId,
        }),
      );
      output.write(`${translator.t("student.feedback.acknowledged")}\n`);
      return 0;
    }
    const page = await server.pendingNotices(
      token,
      PendingNoticesRequestSchema.parse({ ...envelope, kind: "pending-notices-query", limit: 32 }),
    );
    output.write(`${translator.t("student.feedback.heading")}\n`);
    if (page.notices.length === 0) output.write(`${translator.t("student.feedback.empty")}\n`);
    for (const notice of page.notices) {
      output.write(
        `\n${notice.noticeId} · ${notice.runId} · ${terminalText(notice.teacherDisplayName)}\n${terminalText(notice.text)}\n`,
      );
      output.write(
        `${translator.t("student.feedback.ack-hint", { command: `marea feedback --ack ${notice.noticeId}` })}\n`,
      );
    }
    return 0;
  } catch {
    output.error(`${translator.t("student.feedback.failed")}\n`);
    return 1;
  }
}

function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(
    // eslint-disable-next-line no-control-regex -- Strip literal terminal controls from untrusted feedback.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    "",
  );
}
