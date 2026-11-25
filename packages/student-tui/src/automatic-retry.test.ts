import { describe, expect, it } from "vitest";

import { withoutSettledRetry } from "./automatic-retry.js";
import type { ConversationStatus } from "./conversation-contracts.js";

function retrying(status: ConversationStatus) {
  return withoutSettledRetry({ status, automaticRetry: 1 } as never);
}

describe("retry marker of a settled turn", () => {
  it.each(["ready", "failed", "cancelled"] as const)("is cleared once the turn is %s", (status) => {
    expect(retrying(status)).toStrictEqual({ status, automaticRetry: undefined });
  });

  it.each(["streaming", "approval", "questions"] as const)(
    "stays while the turn is %s",
    (status) => {
      expect(retrying(status)).toStrictEqual({ status, automaticRetry: 1 });
    },
  );
});
