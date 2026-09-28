import { EvaluationController } from "../evaluation/evaluation-controller.js";
import type { EvaluationClient } from "../evaluation/evaluation-client.boundary.js";
import type { NoticeClient } from "./notice-client.boundary.js";
import { NoticeController } from "./notice-controller.js";

/** Per-session drafts survive navigation, but are discarded on logout or revoked access. */
export class SessionDrafts {
  private readonly reviews = new Map<string | null, EvaluationController>();
  private readonly notices = new Map<string | null, NoticeController>();
  constructor(
    private readonly client: EvaluationClient,
    private readonly noticeClient: NoticeClient,
    private readonly changed: () => void,
  ) {}
  review(runId: string | null): EvaluationController | undefined {
    return this.reviews.get(runId);
  }
  notice(runId: string | null): NoticeController | undefined {
    return this.notices.get(runId);
  }
  select(runId: string): void {
    if (!this.notices.has(runId))
      this.notices.set(runId, new NoticeController(runId, this.noticeClient, this.changed));
  }
  async openReview(runId: string | null): Promise<void> {
    if (runId === null || this.reviews.has(runId)) return;
    const review = new EvaluationController(this.client, this.changed);
    this.reviews.set(runId, review);
    await review.select(runId);
  }
  remove(runId: string): void {
    this.reviews.get(runId)?.dispose();
    this.reviews.delete(runId);
    this.notices.get(runId)?.dispose();
    this.notices.delete(runId);
  }
  get hasUnsavedDrafts(): boolean {
    return (
      [...this.notices.values()].some(
        (item) => item.state.draft !== "" || item.state.uncertain || item.state.busy,
      ) ||
      [...this.reviews.values()].some(
        (item) =>
          item.state.busy ||
          item.state.uncertain ||
          (item.state.evaluation?.state === "draft" &&
            JSON.stringify(item.state.draft) !== JSON.stringify(item.state.evaluation.draft)),
      )
    );
  }
  clear(): void {
    for (const review of this.reviews.values()) review.dispose();
    for (const notice of this.notices.values()) notice.dispose();
    this.reviews.clear();
    this.notices.clear();
  }
}
