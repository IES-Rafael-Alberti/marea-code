import {
  CURRENT_PROTOCOL_VERSION,
  TeacherHealthRequestSchema,
  type TeacherHealthResponse,
  type UsageHealthPort,
} from "@marea/protocol";
import { LatestRequest } from "../latest-request.js";

export type HealthState =
  | { readonly status: "empty" | "loading" | "error" | "denied" }
  | { readonly status: "ready"; readonly response: TeacherHealthResponse };

/** Teacher-safe health for one class; observations are shown exactly as the server returns them. */
export class HealthController {
  state: HealthState = { status: "empty" };
  private classId: string | null = null;
  private readonly request = new LatestRequest();
  private disposed = false;

  constructor(
    private readonly port: Pick<UsageHealthPort, "readHealth">,
    private readonly changed: () => void,
  ) {}

  start(classId: string | null): Promise<void> {
    this.classId = classId;
    return this.refresh();
  }

  async refresh(): Promise<void> {
    const { classId } = this;
    if (this.disposed || classId === null) return;
    this.state = { status: "loading" };
    this.changed();
    await this.request.run(
      (signal) =>
        this.port.readHealth(
          TeacherHealthRequestSchema.parse({
            protocolVersion: CURRENT_PROTOCOL_VERSION,
            requestId: `health:${crypto.randomUUID()}`,
            kind: "teacher-health-read",
            classId,
          }),
          signal,
        ),
      (outcome) => {
        this.state = outcome.ok
          ? { status: "ready", response: outcome.value }
          : { status: outcome.status };
        this.changed();
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.request.cancel();
  }
}
