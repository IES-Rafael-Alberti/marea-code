import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  CURRENT_PROTOCOL_VERSION,
  UsageQuerySchema,
  type UsageHealthPort,
  type UsageResponse,
} from "@marea/protocol";
import { LatestRequest } from "../latest-request.js";
import { defaultUsageRange, usageWindow, type UsageRange } from "./usage-range.js";

export const USAGE_PAGE_SIZE = 25;
export type UsageState = {
  /** The applied range, and the teacher's unapplied edits. */
  readonly range: UsageRange;
  readonly draft: UsageRange;
  readonly page: number;
} & (
  | { readonly status: "empty" | "loading" | "error" | "denied" }
  | { readonly status: "ready"; readonly response: UsageResponse }
);

/** Page-scoped usage reads for one class; every replacement or disposal cancels the old read. */
export class UsageController {
  state: UsageState;
  private classId: string | null = null;
  private cursors: (string | undefined)[] = [undefined];
  private readonly request = new LatestRequest();
  private disposed = false;

  constructor(
    private readonly port: Pick<UsageHealthPort, "queryUsage">,
    private readonly changed: () => void,
    now: Date = new Date(),
  ) {
    const range = defaultUsageRange(now);
    this.state = { status: "empty", range, draft: range, page: 1 };
  }

  start(classId: string | null): Promise<void> {
    this.classId = classId;
    return this.load();
  }

  edit(field: keyof UsageRange, value: string): void {
    if (this.disposed) return;
    this.state = { ...this.state, draft: { ...this.state.draft, [field]: value } };
    this.changed();
  }

  apply(): Promise<void> {
    if (usageWindow(this.state.draft) === undefined) return Promise.resolve();
    this.cursors = [undefined];
    this.state = { ...this.state, range: this.state.draft };
    return this.load();
  }

  next(): Promise<void> {
    const after = this.state.status === "ready" ? this.state.response.nextAfterAttemptId : null;
    if (after === null) return Promise.resolve();
    this.cursors.push(after);
    return this.load();
  }

  previous(): Promise<void> {
    if (this.cursors.length === 1 || this.state.status === "loading") return Promise.resolve();
    this.cursors.pop();
    return this.load();
  }

  refresh(): Promise<void> {
    return this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.request.cancel();
  }

  private async load(): Promise<void> {
    const { classId } = this;
    const window = usageWindow(this.state.range);
    if (this.disposed || classId === null || window === undefined) return;
    const { range } = this.state;
    const page = this.cursors.length;
    const after = this.cursors.at(-1);
    this.state = { status: "loading", range, draft: this.state.draft, page };
    this.changed();
    await this.request.run(
      (signal) =>
        this.port.queryUsage(
          UsageQuerySchema.parse({
            protocolVersion: CURRENT_PROTOCOL_VERSION,
            requestId: `usage:${browserRandomUUID()}`,
            kind: "class-usage-query",
            classId,
            ...window,
            limit: USAGE_PAGE_SIZE,
            ...(after === undefined ? {} : { afterAttemptId: after }),
          }),
          signal,
        ),
      (outcome) => {
        const current = { range, draft: this.state.draft, page };
        this.state = outcome.ok
          ? { ...current, status: "ready", response: outcome.value }
          : { ...current, status: outcome.status };
        this.changed();
      },
    );
  }
}
