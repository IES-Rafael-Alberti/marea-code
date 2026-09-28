/**
 * Every string the parity TUI shows, grouped by the surface that owns it.
 *
 * The package stays free of the catalogue: the application resolves the
 * student's locale and hands the record down, exactly as the existing
 * conversation copy already works.
 */

export interface BannerCopy {
  readonly branch: string;
  readonly directory: string;
  readonly footer: string;
  readonly model: string;
  readonly repository: string;
}

/** One line of description per local command; the words are not translated. */
export interface CommandDescriptions {
  readonly details: string;
  readonly exit: string;
  readonly help: string;
  readonly language: string;
  readonly retry: string;
}

export interface StatusCopy {
  readonly finishing: string;
  readonly ready: string;
  readonly responding: string;
  readonly retrying: string;
  readonly reviewing: string;
  readonly starting: string;
  readonly thinking: string;
  readonly unrecoverable: string;
  readonly waitingAnswer: string;
  readonly waitingApproval: string;
}

export interface HintCopy {
  readonly approval: string;
  readonly questions: string;
  readonly ready: string;
  readonly turn: string;
}

type CountMessage = (count: number) => string;

export interface ToolCopy {
  readonly emptyOutput: string;
  readonly linesRead: CountMessage;
  readonly omittedMany: CountMessage;
  readonly omittedOne: string;
  readonly output: string;
  readonly questionLabel?: string | undefined;
  readonly seeContent: string;
  readonly seeOutput: string;
  readonly subagentLabel?: string | undefined;
}

export interface ApprovalCopy {
  readonly approve: string;
  readonly approved: string;
  readonly cancelled: string;
  readonly collapse: string;
  readonly editAfter: string;
  readonly editAll: string;
  readonly editBefore: string;
  readonly editOne: string;
  readonly executeWarning: string;
  readonly expand: string;
  readonly lines: CountMessage;
  readonly reasonPlaceholder: string;
  readonly reject: string;
  readonly rejected: string;
  /** Takes `{{reason}}`. */
  readonly rejectedWithReason: string;
  /** Takes `{{name}}`. */
  readonly title: string;
}

export interface QuestionCopy {
  readonly cancelled: string;
  readonly next: string;
  readonly placeholder: string;
  readonly previous: string;
  /** Takes `{{index}}` and `{{total}}`. */
  readonly progress: string;
  readonly required: string;
  readonly send: string;
  readonly sent: string;
  readonly title: string;
}

interface NoticeCopy {
  readonly quitHint: string;
  readonly clipboard: string;
  readonly draftKept: string;
  readonly noOutputs: string;
  readonly noRetry: string;
  readonly noTurnOutputs: string;
  readonly languageChanged: string;
  readonly languageSaveFailed: string;
  readonly outputsCompact: string;
  readonly outputsDetailed: string;
  readonly retrying: string;
}

interface FailureCopy {
  readonly deadlineExceeded: string;
  readonly budgetExhausted: string;
  readonly concurrencyLimited: string;
  readonly recoveryPending: string;
  readonly providerInterrupted: string;
  readonly requestFailed: string;
  readonly resumeDetail: string;
  readonly sessionUnavailable: string;
}

interface TurnCopy {
  readonly driverFailed: string;
  readonly interrupted: string;
  readonly retry: string;
  readonly retryStarted: string;
}

export interface ParityCopy {
  readonly approval: ApprovalCopy;
  readonly banner: BannerCopy;
  readonly commands: CommandDescriptions;
  readonly composerPlaceholder: string;
  readonly failure: FailureCopy;
  readonly help: string;
  readonly hints: HintCopy;
  readonly notices: NoticeCopy;
  readonly preparing: string;
  readonly question: QuestionCopy;
  /** Takes `{{seconds}}`; appended to a running activity. */
  readonly seconds: string;
  readonly status: StatusCopy;
  readonly title: string;
  readonly tool: ToolCopy;
  readonly turn: TurnCopy;
}

/** Replaces `{{name}}` placeholders, leaving an unknown one untouched. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9._-]*)\}\}/gu, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
