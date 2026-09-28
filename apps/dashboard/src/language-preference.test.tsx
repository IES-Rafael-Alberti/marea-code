import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { DashboardApp, type DashboardAppProperties } from "./dashboard-app.js";
import { reviewElements } from "./modules/evaluation/react-tree.fixture.js";
import { startDashboard } from "./start-dashboard.js";
import { signedOutSession } from "./modules/session/sign-in.fixture.js";

it.each([undefined, ["fr-FR", "eu-ES"]])(
  "restores explicit preferences and detects automatic language from %j",
  async (languages) => {
    const partialDocument: Partial<Document> = {
      documentElement: { lang: "" } as HTMLElement,
      getElementById: () => ({}) as HTMLElement,
    };
    const document = partialDocument as Document;
    const storage = { getItem: vi.fn(() => "en"), setItem: vi.fn() };
    let current: ReactNode;
    const handle = startDashboard(
      { document, language: "en-US", languages, storage },
      { load: vi.fn().mockRejectedValue(new Error("offline")) },
      () => ({
        render: (node) => {
          current = node;
        },
        unmount: vi.fn(),
      }),
    );
    function app() {
      if (!isValidElement<DashboardAppProperties>(current)) throw new Error("Missing app");
      return current.props;
    }
    try {
      await handle.ready;
      expect(app().preference).toBe("en");
      expect(app().locale).toBe("en");
      expect(app().languageSaveWarning).toBe(false);
      app().onPreferenceChange?.("automatic");
      expect(app().preference).toBe("automatic");
      expect(app().locale).toBe(languages === undefined ? "en" : "eu");
      expect(document.documentElement.lang).toBe(languages === undefined ? "en" : "eu");
      expect(app().languageSaveWarning).toBe(false);
      storage.setItem.mockImplementationOnce(() => {
        throw new Error("blocked");
      });
      app().onPreferenceChange?.("eu");
      expect(app().locale).toBe("eu");
      expect(app().languageSaveWarning).toBe(true);
      app().onPreferenceChange?.("es");
      expect(app().languageSaveWarning).toBe(false);
    } finally {
      handle.dispose();
    }
  },
);

it("defaults to automatic without a persistence warning or a change callback", () => {
  const tree = DashboardApp({ locale: "en", session: signedOutSession });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('<option value="automatic" selected="">Automatic</option>');
  expect(html).not.toContain("could not be saved");
  const select = reviewElements(tree).find((element) => element.type === "select");
  if (select === undefined) throw new Error("Missing language selector");
  expect(() => select.props.onChange?.({ currentTarget: { value: "eu" } })).not.toThrow();
});
