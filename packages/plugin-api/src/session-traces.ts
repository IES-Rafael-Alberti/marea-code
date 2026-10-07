import type { ProviderSettingsDescriptor } from "./provider-settings.js";

/** Full-content observations from committed session events. No transport/configuration secrets. */
export interface SessionTraceSpan {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly type: "agent" | "generation" | "tool" | "event" | "span";
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly input: string;
  readonly output: string;
  readonly failed: boolean;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly model?: string;
  readonly usage?: { readonly input: number; readonly output: number };
}
export interface SessionTrace {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly classId: string;
  readonly release: string;
  readonly spans: readonly SessionTraceSpan[];
}
export interface SessionTraceExporter {
  /** One bounded request, no internal retry/queue; the host owns deadlines and retries. */
  export(trace: SessionTrace, signal: AbortSignal): Promise<void>;
}
export interface SessionTraceImplementation {
  readonly settings: ProviderSettingsDescriptor;
  /** Pure validation/construction. Credentials stay private to the server. */
  create(values: Readonly<Record<string, string>>): SessionTraceExporter;
}
