import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProviderConnections } from "./provider-connections.js";
import type { EditableSettings } from "./client.boundary.js";
it("renders the installed plugin's fields and secret placeholder in each interface language", () => {
  const state: EditableSettings = {
    administrator: true,
    initialized: true,
    revision: 1,
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
    providers: [
      {
        id: "synthetic",
        descriptor: {
          version: 1,
          name: { es: "Proveedor", en: "Provider", eu: "Hornitzailea" },
          fields: [
            {
              key: "token",
              kind: "secret",
              required: true,
              label: { es: "Clave", en: "Key", eu: "Gakoa" },
            },
          ],
        },
        configured: true,
        values: {},
        secrets: ["token"],
      },
    ],
  };
  for (const locale of ["es", "en", "eu"] as const) {
    const html = renderToStaticMarkup(
      <ProviderConnections
        state={state}
        locale={locale}
        connections={{ synthetic: {} }}
        change={vi.fn()}
      />,
    );
    expect(html).toContain(state.providers[0]?.descriptor?.name[locale]);
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).not.toContain("OpenRouter");
  }
});
