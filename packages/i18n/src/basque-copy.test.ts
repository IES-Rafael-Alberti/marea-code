import { expect, it } from "vitest";

import { createTranslator } from "./index.js";
import { BASQUE_CATALOG } from "./catalogs/eu.js";

it("preserves the reviewed Basque interface copy", () => {
  expect(BASQUE_CATALOG).toMatchSnapshot();
});

it("keeps runnable commands and Markdown code spans in Basque help", () => {
  const help = createTranslator("eu").t("student.tui.help");
  for (const command of ["/help", "/retry", "/details", "/language", "/exit", "--no-mouse"]) {
    expect(help).toContain(`\`${command}\``);
  }
  expect(help).not.toContain("\\`");
});
