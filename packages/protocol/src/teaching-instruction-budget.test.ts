import { expect, it } from "vitest";
import { ClassInstructionsSchema } from "./teaching-configuration.js";

it.each(["tutoring", "free"])(
  "limits %s instruction bytes independently of character count",
  (field) => {
    const parse = (text: string) =>
      ClassInstructionsSchema.safeParse({ tutoring: "Ask", free: "Help", [field]: text });
    expect(parse("é".repeat(131_072)).success).toBe(true);
    expect(parse("é".repeat(131_072) + "x").success).toBe(false);
    expect(parse("😀".repeat(65_536)).success).toBe(true);
    expect(parse("😀".repeat(65_536) + "x").success).toBe(false);
  },
);
