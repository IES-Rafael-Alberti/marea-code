import { NoticeTextSchema, type TeacherNoticeStatus } from "@marea/protocol";
import type { NoticeClient } from "./notice-client.boundary.js";

export interface NoticeState {
  readonly draft: string;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly error: boolean;
  readonly publication: TeacherNoticeStatus | null;
}
/** One outbox per run; uncertain writes keep their body/key until explicit readback or retry. */
export class NoticeController {
  public state: NoticeState = {
    draft: "",
    busy: false,
    uncertain: false,
    error: false,
    publication: null,
  };
  private pending: { text: string; key: string } | undefined;
  private readonly abort = new AbortController();
  constructor(
    private readonly runId: string,
    private readonly client: NoticeClient,
    private readonly changed: () => void,
    private readonly key = () => `notice:${crypto.randomUUID()}`,
  ) {}
  edit(draft: string): void {
    if (!this.state.busy && !this.state.uncertain) this.update({ draft });
  }
  async send(): Promise<void> {
    if (this.state.busy || this.state.publication !== null || this.abort.signal.aborted) return;
    const text = NoticeTextSchema.safeParse(this.state.draft);
    if (!text.success) {
      this.update({ error: true });
      return;
    }
    this.pending ??= { text: text.data, key: this.key() };
    this.update({ busy: true, uncertain: true, error: false });
    try {
      const response = await this.client.publish(
        this.runId,
        this.pending.text,
        this.pending.key,
        this.abort.signal,
      );
      this.update({
        publication: { notice: response.notice, acknowledgedAt: null },
        draft: "",
        uncertain: false,
      });
    } catch {
      this.update({ error: true });
    } finally {
      this.update({ busy: false });
    }
  }
  async refresh(): Promise<void> {
    if (this.pending === undefined || this.state.busy || this.abort.signal.aborted) return;
    this.update({ busy: true });
    try {
      const result = await this.client.query(this.runId, this.pending.key, this.abort.signal);
      this.update({
        publication: result.publication,
        error: false,
        ...(result.publication === null ? {} : { uncertain: false, draft: "" }),
      });
    } catch {
      this.update({ error: true });
    } finally {
      this.update({ busy: false });
    }
  }
  newMessage(): void {
    if (this.state.busy || this.state.uncertain) return;
    this.pending = undefined;
    this.update({ publication: null, draft: "", error: false });
  }
  dispose(): void {
    this.abort.abort();
  }
  private update(patch: Partial<NoticeState>): void {
    if (this.abort.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    this.changed();
  }
}
