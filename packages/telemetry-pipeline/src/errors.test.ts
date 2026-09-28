import { describe, expect, it } from "vitest";

import {
  TelemetryConfigurationError,
  TelemetryEventValidationError,
  TelemetryPipelineClosedError,
} from "./errors.js";

describe("telemetry errors", () => {
  it("identifies a configuration error", () => {
    const error = new TelemetryConfigurationError("Invalid configuration.");

    expect(error.name).toBe("TelemetryConfigurationError");
    expect(error.message).toBe("Invalid configuration.");
  });

  it("identifies an event validation error", () => {
    const error = new TelemetryEventValidationError("Invalid event.");

    expect(error.name).toBe("TelemetryEventValidationError");
    expect(error.message).toBe("Invalid event.");
  });

  it("identifies a closed pipeline error", () => {
    const error = new TelemetryPipelineClosedError();

    expect(error.name).toBe("TelemetryPipelineClosedError");
    expect(error.message).toBe("The telemetry pipeline is closed.");
  });
});
