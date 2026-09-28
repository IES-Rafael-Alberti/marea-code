import { createTranslator, type Translator } from "@marea/i18n";
import { expect, it } from "vitest";
import { createParityCopy } from "./parity-copy.js";

function expectedCopy(translator: Translator) {
  const text = (key: Parameters<Translator["t"]>[0]) => translator.t(key);
  return {
    approval: {
      approve: text("student.tui.approval.approve"),
      approved: text("student.tui.approval.approved"),
      cancelled: text("student.tui.approval.cancelled"),
      collapse: text("student.tui.approval.collapse"),
      editAfter: text("student.tui.approval.edit-after"),
      editBefore: text("student.tui.approval.edit-before"),
      editAll: text("student.tui.approval.edit-all"),
      editOne: text("student.tui.approval.edit-one"),
      executeWarning: text("student.tui.approval.execute-warning"),
      expand: text("student.tui.approval.expand"),
      lines: (count: number) => translator.t("student.tui.approval.lines.other", { count }),
      reasonPlaceholder: text("student.tui.approval.reason-placeholder"),
      reject: text("student.tui.approval.reject"),
      rejected: text("student.tui.approval.rejected"),
      rejectedWithReason: text("student.tui.approval.rejected-with-reason"),
      title: text("student.tui.approval.title"),
    },
    banner: {
      branch: text("student.tui.banner.branch"),
      directory: text("student.tui.banner.directory"),
      footer: text("student.tui.banner.footer"),
      model: text("student.tui.banner.model"),
      repository: text("student.tui.banner.repository"),
    },
    commands: {
      details: text("student.tui.command.details-description"),
      exit: text("student.tui.command.exit-description"),
      help: text("student.tui.command.help-description"),
      language: text("student.tui.command.language-description"),
      retry: text("student.tui.command.retry-description"),
    },
    composerPlaceholder: text("student.tui.composer.placeholder"),
    failure: {
      recoveryPending: text("student.tui.failure.recovery-pending"),
      deadlineExceeded: text("student.tui.failure.deadline-exceeded"),
      budgetExhausted: text("student.tui.failure.budget-exhausted"),
      concurrencyLimited: text("student.tui.failure.concurrency-limited"),
      providerInterrupted: text("student.tui.failure.provider-interrupted"),
      requestFailed: text("errors.server.error"),
      resumeDetail: text("student.tui.failure.resume-detail"),
      sessionUnavailable: text("errors.run.unavailable"),
    },
    help: text("student.tui.help"),
    hints: {
      approval: text("student.tui.hint.approval"),
      questions: text("student.tui.hint.questions"),
      ready: text("student.tui.hint.ready"),
      turn: text("student.tui.hint.turn"),
    },
    notices: {
      quitHint: text("student.tui.notice.quit-hint"),
      clipboard: text("student.tui.notice.clipboard"),
      draftKept: text("student.tui.notice.draft-kept"),
      noOutputs: text("student.tui.notice.no-outputs"),
      noRetry: text("student.tui.notice.no-retry"),
      noTurnOutputs: text("student.tui.notice.no-turn-outputs"),
      languageChanged: text("student.tui.notice.language-changed"),
      languageSaveFailed: text("student.tui.notice.language-save-failed"),
      outputsCompact: text("student.tui.notice.outputs-compact"),
      outputsDetailed: text("student.tui.notice.outputs-detailed"),
      retrying: text("student.tui.notice.retrying"),
    },
    preparing: text("student.tui.status.preparing"),
    question: {
      cancelled: text("student.tui.question.cancelled"),
      next: text("student.tui.question.next"),
      placeholder: text("student.tui.question.placeholder"),
      previous: text("student.tui.question.previous"),
      progress: text("student.tui.question.progress"),
      required: text("student.tui.question.required"),
      send: text("student.tui.question.send"),
      sent: text("student.tui.question.sent"),
      title: text("student.tui.question.title"),
    },
    seconds: text("student.tui.status.detail"),
    status: {
      finishing: text("student.tui.status.finishing"),
      ready: text("student.tui.status.ready"),
      responding: text("student.tui.status.responding"),
      retrying: text("student.tui.status.retrying"),
      reviewing: text("student.tui.status.reviewing"),
      starting: text("student.tui.status.starting"),
      thinking: text("student.tui.status.thinking"),
      unrecoverable: text("student.tui.status.unrecoverable"),
      waitingAnswer: text("student.tui.status.waiting-answer"),
      waitingApproval: text("student.tui.status.waiting-approval"),
    },
    title: "Marea Code",
    tool: {
      emptyOutput: text("student.tui.tool.empty-output"),
      linesRead: (count: number) => translator.t("student.tui.tool.lines-read.other", { count }),
      omittedMany: (count: number) =>
        translator.t("student.tui.tool.omitted-many.other", { count }),
      omittedOne: text("student.tui.tool.omitted-one"),
      output: text("student.tui.tool.output"),
      questionLabel: text("student.tui.tool.question"),
      seeContent: text("student.tui.tool.see-content"),
      seeOutput: text("student.tui.tool.see-output"),
      subagentLabel: text("student.tui.tool.subagent"),
    },
    turn: {
      driverFailed: text("student.tui.turn.driver-failed"),
      interrupted: text("student.tui.turn.interrupted"),
      retry: text("student.tui.turn.retry"),
      retryStarted: text("student.tui.turn.retry-started"),
    },
  };
}

it.each(["es", "en", "eu"] as const)("resolves every parity surface in %s", (locale) => {
  const translator = createTranslator(locale);
  const copy = createParityCopy(translator);
  const expected = expectedCopy(translator);
  expect(JSON.parse(JSON.stringify(copy))).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(typeof copy.approval.lines).toBe("function");
  expect(typeof copy.tool.linesRead).toBe("function");
  expect(typeof copy.tool.omittedMany).toBe("function");
  expect(copy.approval.lines(1)).toBe(translator.t("student.tui.approval.lines.one", { count: 1 }));
  expect(copy.approval.lines(2)).toBe(
    translator.t("student.tui.approval.lines.other", { count: 2 }),
  );
  expect(copy.tool.linesRead(1)).toBe(
    translator.t("student.tui.tool.lines-read.one", { count: 1 }),
  );
  expect(copy.tool.linesRead(2)).toBe(
    translator.t("student.tui.tool.lines-read.other", { count: 2 }),
  );
  expect(copy.tool.omittedMany(1)).toBe(
    translator.t("student.tui.tool.omitted-many.one", { count: 1 }),
  );
  expect(copy.tool.omittedMany(2)).toBe(
    translator.t("student.tui.tool.omitted-many.other", { count: 2 }),
  );
  expect(copy.question.progress).toContain("{{index}}");
  expect(copy.question.progress).toContain("{{total}}");
  expect(JSON.stringify(copy)).not.toContain("student.tui.");
});
