import { parseServerArguments } from "./server-arguments.js";
import { FAILURE_LOG_FILE } from "./failure-log.boundary.js";
import { startupFailure } from "./startup-failure.boundary.js";
import { ensureGitWorkspace } from "./git-workspace.boundary.js";
import { openInputHistory, type PersistentInputHistory } from "./input-history.boundary.js";
import { randomUUID } from "node:crypto";
import {
  canonicalStateDirectory,
  locateStateDirectory,
} from "./student-state-directory.boundary.js";
import { basename, join, resolve } from "node:path";
import { projectDisplayNameFromFolder } from "./project-name.js";

import {
  createTranslator,
  LOCALE_NAMES,
  type Locale,
  type LocalePreference,
  type Translator,
} from "@marea/i18n";
import { EventIdSchema } from "@marea/protocol";
import {
  startConversationTui,
  TurnFailureSignal,
  type ConversationAttemptId,
  type ConversationCopy,
  type ConversationMessageId,
  type ConversationTuiOptions,
  type ConversationTuiSession,
} from "@marea/student-tui";

import { createLoopbackAuthorization } from "./external-authorization.boundary.js";
import {
  createAuthenticationPrompt,
  createInquirerAuthenticationQuestions,
} from "./authentication-prompt.boundary.js";
import {
  createProductionStudentApplication,
  type ProductionStudentCompositionOptions,
} from "./composition.js";
import {
  adaptConversationTuiSession,
  createConversationStudentInterface,
  type StudentConversationPort,
} from "./conversation-interface.js";
import type { PendingStudentTurn } from "./contracts.js";
import { createVersionGate } from "./version-gate.boundary.js";
import type { StudentVersionAcceptanceStore } from "./version-acceptance.boundary.js";
import { createParityCopy } from "./parity-copy.js";
import { readProjectGitContext, type ProjectGitContext } from "./project-git.boundary.js";
import { runInteractiveMarea, type MareaSessionLifecycle } from "./main.js";
import { createSessionContext, sessionModelAlias } from "./session-context.js";
import { classifyTurnFailure } from "./turn-failure.boundary.js";
import { runFeedbackCommand, type FeedbackCommandOptions } from "./feedback-command.boundary.js";
import { runLogoutCommand, type LogoutCommandOptions } from "./logout-command.boundary.js";
import type { SavedServerStore } from "./saved-server.boundary.js";
import type {
  StudentLanguagePreferenceStore,
  StudentUsagePreferenceStore,
} from "./interface-locale.boundary.js";

export const MAREA_CLIENT_VERSION = "0.2.0";

export interface MareaCommandOutput {
  readonly error: (text: string) => void;
  readonly write: (text: string) => void;
}

export interface MareaCommandOptions {
  readonly arguments: readonly string[];
  readonly currentDirectory: string;
  readonly homeDirectory: string;
  readonly output: MareaCommandOutput;
  readonly serverUrl: string | undefined;
  readonly stateRoot: string | undefined;
  readonly translator: Translator;
  readonly languagePreference?: LocalePreference;
  readonly automaticLocale?: Locale;
  readonly languagePreferenceStore?: StudentLanguagePreferenceStore;
  readonly usagePreferenceStore?: StudentUsagePreferenceStore;
  readonly savedServerStore?: SavedServerStore;
  readonly versionAcceptanceStore?: StudentVersionAcceptanceStore;
}

export interface MareaCommandRuntime {
  readonly ensureWorkspace?: (root: string, translator?: Translator) => Promise<void>;
  readonly openHistory?: (directory: string) => Promise<PersistentInputHistory>;
  readonly createApplication: (
    options: ProductionStudentCompositionOptions,
  ) => Promise<MareaCommandApplication>;
  readonly nextAttemptId: () => string;
  readonly nextMessageId: () => string;
  readonly readGitContext: (projectRoot: string) => ProjectGitContext;
  readonly startConversation: (options: ConversationTuiOptions) => Promise<ConversationTuiSession>;
}

export interface MareaCommandController extends MareaSessionLifecycle {
  sendStartup?(signal: AbortSignal, attemptId?: ConversationAttemptId): Promise<void>;
  sendMessage(
    messageId: string,
    text: string,
    signal: AbortSignal,
    attemptId?: ConversationAttemptId,
  ): Promise<void>;
  pendingTurn(): Promise<PendingStudentTurn | null>;
}

export interface MareaCommandApplication {
  readonly controller: MareaCommandController;
  dispose(): void;
}

export interface BindableConversationPort extends StudentConversationPort {
  bind(port: StudentConversationPort): void;
}

// Stryker disable next-line ObjectLiteral: deleting required runtime fields is a type error.
const PRODUCTION_RUNTIME: MareaCommandRuntime = Object.freeze({
  createApplication: createProductionStudentApplication,
  ensureWorkspace: ensureGitWorkspace,
  openHistory: openInputHistory,
  nextAttemptId: randomUUID,
  nextMessageId: randomUUID,
  readGitContext: readProjectGitContext,
  startConversation: startConversationTui,
});

const NEXT_LANGUAGE_PREFERENCE: Readonly<Record<LocalePreference, LocalePreference>> =
  Object.freeze({
    automatic: "es",
    es: "en",
    en: "eu",
    eu: "automatic",
  });

function nextLanguagePreference(current: LocalePreference): LocalePreference {
  return NEXT_LANGUAGE_PREFERENCE[current];
}

function commandKind(
  arguments_: readonly string[],
): "help" | "invalid" | "version" | "feedback" | "logout" | null {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--no-mouse"))
    return null;
  if (
    arguments_[0] === "feedback" &&
    (arguments_.length === 1 ||
      (arguments_.length === 3 &&
        arguments_[1] === "--ack" &&
        EventIdSchema.safeParse(arguments_[2]).success))
  )
    return "feedback";
  if (arguments_.length === 1 && arguments_[0] === "logout") return "logout";
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return "help";
  }
  if (arguments_.length === 1 && (arguments_[0] === "--version" || arguments_[0] === "-v")) {
    return "version";
  }
  return "invalid";
}

export function createBindableConversationPort(): BindableConversationPort {
  let target: StudentConversationPort | null = null;
  // A resumed session reports its usage while starting, before the conversation exists.
  let startupUsage: Parameters<StudentConversationPort["reportUsage"]>[0] | null = null;
  const requireTarget = (): StudentConversationPort => {
    if (target === null) throw new Error("The conversation interface is not ready.");
    return target;
  };
  return Object.freeze({
    appendAssistantText: (
      text: string,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) => requireTarget().appendAssistantText(text, messageId, attemptId),
    restartAssistantText: (
      discardedLength: number,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) => requireTarget().restartAssistantText(discardedLength, messageId, attemptId),
    bind(port: StudentConversationPort): void {
      target = port;
      if (startupUsage !== null) port.reportUsage(startupUsage);
    },
    reportUsage: (usage: Parameters<StudentConversationPort["reportUsage"]>[0]) => {
      if (target === null) {
        startupUsage = usage;
        return false;
      }
      return target.reportUsage(usage);
    },
    cancel: (messageId?: ConversationMessageId, attemptId?: ConversationAttemptId) =>
      requireTarget().cancel(messageId, attemptId),
    complete: (messageId?: ConversationMessageId, attemptId?: ConversationAttemptId) =>
      requireTarget().complete(messageId, attemptId),
    requestQuestions: (
      request: Parameters<NonNullable<StudentConversationPort["requestQuestions"]>>[0],
      messageId?: string,
      attemptId?: string,
    ) => {
      const port = requireTarget();
      if (port.requestQuestions === undefined)
        throw new Error("The conversation does not support questions.");
      return port.requestQuestions(request, messageId, attemptId);
    },
    requestApproval: (
      approval: Parameters<StudentConversationPort["requestApproval"]>[0],
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) => requireTarget().requestApproval(approval, messageId, attemptId),
    thinking: (messageId?: ConversationMessageId, attemptId?: ConversationAttemptId) =>
      requireTarget().thinking(messageId, attemptId),
    toolFinished: (
      finish: Parameters<StudentConversationPort["toolFinished"]>[0],
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) => requireTarget().toolFinished(finish, messageId, attemptId),
    toolStarted: (
      call: Parameters<StudentConversationPort["toolStarted"]>[0],
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) => requireTarget().toolStarted(call, messageId, attemptId),
  });
}

export function createConversationCopy(translator: Translator): ConversationCopy {
  return Object.freeze({
    parity: {
      copy: createParityCopy(translator),
      context: { cwd: "", branch: "", model: "", repositoryUrl: "" },
    },
  });
}

export function createStudentStateDirectory(
  root: string,
  serverUrl: string,
  projectRoot: string,
): string {
  return canonicalStateDirectory(root, serverUrl, projectRoot);
}

async function sendTurn(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    throw new TurnFailureSignal(classifyTurnFailure(error));
  }
}

async function runStudent(
  options: MareaCommandOptions,
  runtime: MareaCommandRuntime,
  serverUrl: string,
  stage: (value: string) => void,
  remember: boolean,
): Promise<void> {
  options.output.write(
    `${options.translator.t("student.cli.connecting", { server: serverUrl })}\n`,
  );
  let languagePreference: LocalePreference =
    options.languagePreference ?? options.translator.locale;
  let translator = options.translator;
  const { projectRoot, stateDirectory } = studentLocations(options, serverUrl);
  await runtime.ensureWorkspace?.(projectRoot, translator);
  stage("local-state");
  let session: ConversationTuiSession | null = null;
  const conversation = createBindableConversationPort();
  const authentication = createAuthenticationPrompt(
    createInquirerAuthenticationQuestions(translator),
    translator,
  );
  const application = await runtime.createApplication({
    clientVersion: MAREA_CLIENT_VERSION,
    externalAuthorization: createLoopbackAuthorization({ translator, output: options.output }),
    notice: (text) => {
      options.output.write(text);
    },
    onStartupStage: stage,
    projectRoot,
    serverUrl,
    stateDirectory,
    translator,
    versionGate: createVersionGate({
      serverUrl,
      translator,
      store: options.versionAcceptanceStore,
    }),
    studentInterface: createConversationStudentInterface({
      authentication,
      withAuthentication: (operation) => session?.withTerminalSuspended(operation) ?? operation(),
      conversation,
      getExecuteWarning: () => translator.t("student.tui.approval.execute-warning"),
    }),
  });
  stage("session");
  let startedSession: object | null = null;
  await runInteractiveMarea({
    controller: application.controller,
    dispose(): void {
      session?.close();
      application.dispose();
    },
    onStarted: (started) => {
      startedSession = started;
    },
    projectDisplayName: projectDisplayNameFromFolder(basename(projectRoot)),
    async waitForExit(): Promise<void> {
      stage("interface");
      // Only a connection that signed in and opened its run is worth remembering.
      if (remember) await options.savedServerStore?.save(serverUrl).catch(() => undefined);
      const pendingTurn = await application.controller.pendingTurn();
      const history = await runtime.openHistory?.(stateDirectory);
      session = await runtime.startConversation({
        copy: {
          ...createConversationCopy(translator),
          mouse: !options.arguments.includes("--no-mouse"),
          parity: {
            copy: createParityCopy(translator),
            history,
            usage: {
              visible: (await options.usagePreferenceStore?.load()) ?? false,
              onVisibilityChange: (visible: boolean) => {
                // A preference that cannot be saved still applies to this session.
                void options.usagePreferenceStore?.save(visible).catch(() => undefined);
              },
            },
            context: createSessionContext({
              cwd: projectRoot,
              failureLog: join(stateDirectory, FAILURE_LOG_FILE),
              git: runtime.readGitContext(projectRoot),
              model: sessionModelAlias(startedSession),
            }),
          },
        },
        onLanguageCommand: async (current) => {
          const nextPreference = nextLanguagePreference(languagePreference);
          const nextLocale =
            nextPreference === "automatic"
              ? (options.automaticLocale ?? translator.locale)
              : nextPreference;
          const nextTranslator = createTranslator(nextLocale);
          const nextCopy = {
            ...current,
            parity: { ...current.parity, copy: createParityCopy(nextTranslator) },
          };
          let saveFailed = false;
          if (options.languagePreferenceStore !== undefined) {
            try {
              await options.languagePreferenceStore.save(nextPreference);
            } catch {
              saveFailed = true;
            }
          }
          languagePreference = nextPreference;
          translator = nextTranslator;
          return {
            copy: nextCopy,
            notice: `${nextTranslator.t("student.tui.notice.language-changed", { language: LOCALE_NAMES[nextLocale] })}${saveFailed ? `\n${nextTranslator.t("student.tui.notice.language-save-failed")}` : ""}`,
          };
        },
        ...(pendingTurn === null ? {} : { initialTurn: pendingTurn }),
        nextAttemptId: runtime.nextAttemptId,
        nextMessageId: runtime.nextMessageId,
        onMessage: async (text, signal, messageId, attemptId) => {
          const sendStartup = application.controller.sendStartup?.bind(application.controller);
          if (pendingTurn?.kind === "startup" && messageId === pendingTurn.messageId) {
            if (sendStartup === undefined)
              throw new Error("The controller does not support tutor startup.");
            await sendTurn(() => sendStartup(signal, attemptId));
          } else {
            await sendTurn(() =>
              application.controller.sendMessage(messageId, text, signal, attemptId),
            );
          }
        },
      });
      conversation.bind(adaptConversationTuiSession(session));
      if (pendingTurn !== null && pendingTurn.failure === undefined && !session.resumeTurn()) {
        throw new Error();
      }
      try {
        await session.outcome;
      } finally {
        await history?.flush();
      }
    },
  });
}

function studentLocations(options: MareaCommandOptions, serverUrl: string) {
  const projectRoot = resolve(options.currentDirectory);
  const configuredStateRoot = options.stateRoot?.trim();
  const stateRoot =
    configuredStateRoot === undefined || configuredStateRoot.length === 0
      ? join(options.homeDirectory, ".marea")
      : configuredStateRoot;
  return {
    projectRoot,
    stateDirectory: locateStateDirectory(stateRoot, serverUrl, projectRoot),
  };
}

async function executeSelectedCommand(
  options: MareaCommandOptions,
  runtime: MareaCommandRuntime,
  feedback: (options: FeedbackCommandOptions) => Promise<number>,
  logout: (options: LogoutCommandOptions) => Promise<number>,
  explicitServer: string | undefined,
): Promise<number> {
  const kind = commandKind(options.arguments);
  if (kind === "help" || kind === "invalid") {
    const help = `${options.translator.t("student.cli.help")}\n`;
    if (kind === "invalid") options.output.error(help);
    else options.output.write(help);
    return kind === "invalid" ? 2 : 0;
  }
  if (kind === "version") {
    options.output.write(`${MAREA_CLIENT_VERSION}\n`);
    return 0;
  }
  // Priority: --server, then the server remembered from a successful sign-in, then the install.
  const serverUrl = (
    explicitServer ??
    (await options.savedServerStore?.load()) ??
    options.serverUrl
  )?.trim();
  if (serverUrl === undefined || serverUrl.length === 0) {
    options.output.error(`${options.translator.t("student.cli.server-url-missing")}\n`);
    return 1;
  }
  let stage = "workspace";
  try {
    if (kind === "feedback")
      return await feedback({
        ...studentLocations(options, serverUrl),
        serverUrl,
        noticeId: options.arguments[2] ?? null,
        translator: options.translator,
        output: options.output,
      });
    if (kind === "logout")
      return await logout({
        ...studentLocations(options, serverUrl),
        translator: options.translator,
        output: options.output,
      });
    await runStudent(
      options,
      runtime,
      serverUrl,
      (value) => {
        stage = value;
      },
      explicitServer !== undefined,
    );
    return 0;
  } catch (error) {
    options.output.error(startupFailure(error, options.translator, stage));
    return 1;
  }
}

/** Resolve the CLI server before creating state or opening any connection. */
export async function executeMareaCommand(
  options: MareaCommandOptions,
  runtime: MareaCommandRuntime = PRODUCTION_RUNTIME,
  feedback: (options: FeedbackCommandOptions) => Promise<number> = runFeedbackCommand,
  logout: (options: LogoutCommandOptions) => Promise<number> = runLogoutCommand,
): Promise<number> {
  const parsed = parseServerArguments(options.arguments);
  if (parsed === undefined) {
    options.output.error(`${options.translator.t("student.cli.help")}\n`);
    return 2;
  }
  return executeSelectedCommand(
    { ...options, arguments: parsed.arguments },
    runtime,
    feedback,
    logout,
    parsed.serverUrl,
  );
}
