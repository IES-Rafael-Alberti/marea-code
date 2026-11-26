import { expect, it } from "vitest";

import { rejectionReason } from "./rejection-reason.js";

it.each([undefined, "", " ", "\t\n"])("uses the default for the reason %j", (reason) => {
  expect(rejectionReason(reason, "fallback")).toBe("fallback");
});

it("keeps what the student typed, untrimmed", () => {
  expect(rejectionReason(" no, gracias ", "fallback")).toBe(" no, gracias ");
});
