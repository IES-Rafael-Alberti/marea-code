import {
  CURRENT_PROTOCOL_VERSION,
  TelemetryPreviewRequestSchema,
  type TelemetryPreviewPort,
  type TelemetryPreviewResponse,
} from "@marea/protocol";
import { PreviewRequestError } from "./preview-client.boundary.js";

export type PreviewState =
  | { readonly status: "empty" | "loading" | "error" | "denied" }
  | { readonly status: "ready"; readonly response: TelemetryPreviewResponse };

export class PreviewController {
  state: PreviewState = { status: "empty" };
  private pending: AbortController | undefined;

  constructor(
    private readonly port: TelemetryPreviewPort,
    private readonly changed: () => void,
  ) {}

  async load(classId: string): Promise<void> {
    this.pending?.abort();
    const pending = new AbortController();
    this.pending = pending;
    this.state = { status: "loading" };
    this.changed();
    try {
      const response = await this.port.preview(
        TelemetryPreviewRequestSchema.parse({
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: `preview:${crypto.randomUUID()}`,
          kind: "telemetry-preview",
          classId,
        }),
        pending.signal,
      );
      if (pending.signal.aborted) return;
      this.state = { status: "ready", response };
    } catch (error) {
      if (pending.signal.aborted) return;
      this.state = {
        status:
          error instanceof PreviewRequestError && [401, 403].includes(error.status)
            ? "denied"
            : "error",
      };
    }
    this.changed();
  }

  dispose(): void {
    this.pending?.abort();
    this.state = { status: "empty" };
  }
}
