export class TelemetryConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TelemetryConfigurationError";
  }
}

export class TelemetryEventValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TelemetryEventValidationError";
  }
}

export class TelemetryPipelineClosedError extends Error {
  public constructor() {
    super("The telemetry pipeline is closed.");
    this.name = "TelemetryPipelineClosedError";
  }
}
