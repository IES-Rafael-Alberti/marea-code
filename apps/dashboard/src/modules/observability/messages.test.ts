import { expect, it } from "vitest";
import { observabilityMessages } from "./messages.js";
it.each(["en", "es", "eu"] as const)(
  "preserves the full-content delivery explanation and status copy in %s",
  (locale) => {
    expect(observabilityMessages(locale)).toMatchSnapshot();
  },
);
