import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { UnconfiguredNotice } from "./unconfigured.js";

it("offers the configuration shortcut only when the host provides one", () => {
  expect(renderToStaticMarkup(<UnconfiguredNotice text="Missing" action="Configure" />)).toBe(
    "<p>Missing </p>",
  );
  const configure = vi.fn();
  const notice = UnconfiguredNotice({ text: "Missing", action: "Configure", configure });
  expect(renderToStaticMarkup(notice)).toContain('<button type="button">Configure</button>');
});
