import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  CURRENT_PROTOCOL_VERSION,
  ReviewedEvidenceQuerySchema,
  type ReviewedCriterionKey,
  type ReviewedEvidencePort,
  type ReviewedEvidenceQuery,
  type ReviewedEvidenceResponse,
} from "@marea/protocol";
import { LatestRequest } from "../latest-request.js";

type Selection = {
  [Kind in ReviewedEvidenceQuery["kind"]]: Omit<
    Extract<ReviewedEvidenceQuery, { kind: Kind }>,
    "classId" | "requestId" | "protocolVersion" | "limit"
  >;
}[ReviewedEvidenceQuery["kind"]];

export class ReviewedEvidenceController {
  status: "empty" | "loading" | "ready" | "error" | "denied" = "empty";
  response: ReviewedEvidenceResponse | null = null;
  navigationBlocked = false;
  private classId: string | null = null;
  private selection: Selection | null = null;
  private readonly request = new LatestRequest();
  private disposed = false;
  constructor(
    private readonly port: ReviewedEvidencePort,
    private readonly changed: () => void,
  ) {}
  start(classId: string | null): Promise<void> {
    this.request.cancel();
    this.classId = classId;
    this.response = null;
    const selection = { kind: "students" } as const;
    this.selection = selection;
    this.status = "empty";
    this.navigationBlocked = false;
    this.changed();
    return this.load(selection);
  }
  students(): Promise<void> {
    return this.load({ kind: "students" });
  }
  criteria(studentId: string): Promise<void> {
    return this.load({ kind: "criteria", studentId });
  }
  history(studentId: string, criterion: ReviewedCriterionKey): Promise<void> {
    return this.load({ kind: "history", studentId, criterion });
  }
  refresh(): Promise<void> {
    if (this.selection === null) return this.start(this.classId);
    return this.load({ ...this.selection, after: undefined });
  }
  more(): Promise<void> {
    const page = this.response;
    if (page?.next == null) return Promise.resolve();
    return this.load(ReviewedEvidenceQuerySchema.parse({ ...page.query, after: page.next }));
  }
  async open(runId: string, navigate: (runId: string) => Promise<boolean>): Promise<void> {
    if (this.disposed) return;
    const selection = this.selection;
    let opened = false;
    try {
      opened = await navigate(runId);
    } catch {
      /* Navigation failure stays local and contains no exception text. */
    }
    if (!this.current(selection)) return;
    this.navigationBlocked = !opened;
    this.changed();
  }
  private current(selection: Selection | null): boolean {
    return !this.disposed && this.selection === selection;
  }
  dispose(): void {
    this.disposed = true;
    this.request.cancel();
  }
  private async load(selection: Selection): Promise<void> {
    if (this.disposed || this.classId === null) return;
    this.navigationBlocked = false;
    this.selection = selection;
    const request = ReviewedEvidenceQuerySchema.parse({
      ...selection,
      classId: this.classId,
      requestId: `evidence:${browserRandomUUID()}`,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      limit: 25,
    });
    this.response = null;
    this.status = "loading";
    this.changed();
    await this.request.run(
      (signal) => this.port.read(request, signal),
      (outcome) => {
        this.status = outcome.ok ? "ready" : outcome.status;
        this.response = outcome.ok ? outcome.value : null;
        this.changed();
      },
    );
  }
}
