export type StudentTuiStatus = "ready" | "streaming" | "complete" | "cancelled";

export interface StudentTuiSnapshot {
  readonly response: string;
  readonly status: StudentTuiStatus;
}

export type StudentTuiIntent = "cancel" | "interrupt" | "quit";

export type StudentTuiExitReason = "closed" | "quit" | "sigint" | "sigterm";

export interface StudentTuiCopy {
  readonly controls: string;
  readonly emptyResponse: string;
  readonly errors: Readonly<{
    nonInteractive: string;
    rendererFailed: string;
    unexpected: string;
  }>;
  readonly statuses: Readonly<Record<StudentTuiStatus, string>>;
  readonly title: string;
}

export interface StudentTuiOutcome {
  readonly exitCode: number;
  readonly reason: StudentTuiExitReason;
}

export interface StudentTuiSession {
  readonly cancellation: Promise<void>;
  readonly outcome: Promise<StudentTuiOutcome>;
  appendText(chunk: string): boolean;
  close(): boolean;
  complete(): boolean;
  snapshot(): StudentTuiSnapshot;
}

export interface StudentTuiView {
  readonly dispose: () => void;
  readonly render: (snapshot: StudentTuiSnapshot) => void;
}

export type StudentTuiViewFactory = (
  copy: StudentTuiCopy,
  onIntent: (intent: StudentTuiIntent) => void,
) => Promise<StudentTuiView>;

export type SupportedSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  subscribe(signal: SupportedSignal, handler: () => void): () => void;
}

export interface StudentTuiEnvironment {
  readonly interactive: boolean;
  readonly setExitCode: (code: number) => void;
  readonly signals: SignalSource;
}
