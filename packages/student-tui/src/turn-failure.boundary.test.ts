import { describe, expect, it } from "vitest";

import { TurnFailureSignal, type TurnFailureInfo } from "./conversation-contracts.js";
import { failureFromRejection } from "./turn-failure.boundary.js";

const FAILURE: TurnFailureInfo = Object.freeze({
  detail: "The request exceeds the configured inference limits.",
  hasPrefix: false,
  kind: "provider-interrupted",
  recoverable: true,
  retryable: false,
});

describe("failureFromRejection", () => {
  it("carries the classified failure and names its signal", () => {
    const signal = new TurnFailureSignal(FAILURE);
    expect(signal.name).toBe("TurnFailureSignal");
    expect(signal.message).toBe("The conversation turn failed.");
    expect(failureFromRejection(signal)).toBe(FAILURE);
  });

  it.each([[new Error("boom")], ["boom"], [null], [undefined]])(
    "leaves an unclassified rejection without failure: %s",
    (reason) => {
      expect(failureFromRejection(reason)).toBeUndefined();
    },
  );
});
