import { expect, it } from "vitest";
import { exportMessages } from "./export-messages.js";
it.each(["en", "es", "eu"] as const)(
  "preserves export privacy, bounds and date-filter copy in %s",
  (locale) => {
    expect(exportMessages(locale)).toMatchSnapshot();
  },
);
