import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { startDashboard } from "./start-dashboard.js";
import type { DashboardAppProperties } from "./dashboard-app.js";
import { DashboardApp } from "./dashboard-app.js";
import { sessionPorts } from "../browser/typed-host-data.fixture.js";
import { DashboardLanguageRequestSchema } from "@marea/protocol";
import type { DashboardFetch } from "./modules/active-runs/active-runs-client.boundary.js";
import { renderToStaticMarkup } from "react-dom/server";

it.each([undefined, ["eu-ES"]])(
  "restores the account language with browser languages %j and isolates login requests",
  async (languages) => {
    let preference: string | null = "es";
    const request = vi.fn<DashboardFetch>((_url, init) => {
      const body = DashboardLanguageRequestSchema.parse(
        JSON.parse(typeof init.body === "string" ? init.body : ""),
      );
      if (body.kind === "save") preference = body.preference;
      return Promise.resolve(
        Response.json({ protocolVersion: "0.1", requestId: body.requestId, preference }),
      );
    });
    const session = {
      current: vi.fn().mockResolvedValue({ status: "signed-in", displayName: "Teacher" }),
      signIn: vi.fn().mockResolvedValue({ status: "signed-in", displayName: "Other" }),
      signOut: vi.fn().mockResolvedValue(undefined),
    };
    const partialDocument: Partial<Document> = {
      documentElement: { lang: "" } as HTMLElement,
      getElementById: () => ({}) as HTMLElement,
    };
    const document = partialDocument as Document;
    const storage = { getItem: () => "en", setItem: vi.fn() };
    const render = vi.fn();
    const profiles = { ...sessionPorts, fetch: request };
    const handle = startDashboard(
      { document, language: "en-GB", languages, storage },
      { load: vi.fn() },
      () => ({ render, unmount: vi.fn() }),
      undefined,
      undefined,
      undefined,
      undefined,
      session,
      undefined,
      undefined,
      profiles,
    );
    const app = () => (render.mock.lastCall?.[0] as ReactElement<DashboardAppProperties>).props;
    app().onPreferenceChange?.("eu");
    expect(app().preference).toBe("en");
    await handle.ready;
    expect(app().preference).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(storage.setItem).toHaveBeenLastCalledWith("marea.dashboard.interface-language.v1", "es");
    expect(renderToStaticMarkup(DashboardApp(app()))).toContain("Idioma de la interfaz");
    const pending = Promise.withResolvers<Response>();
    request.mockReturnValueOnce(pending.promise);
    app().onPreferenceChange?.("eu");
    expect(app().languageBusy).toBe(true);
    expect(document.documentElement.lang).toBe("eu");
    app().onPreferenceChange?.("en");
    expect(document.documentElement.lang).toBe("eu");
    const serialized = request.mock.calls.at(-1)?.[1].body;
    const body = DashboardLanguageRequestSchema.parse(
      JSON.parse(typeof serialized === "string" ? serialized : ""),
    );
    pending.resolve(
      Response.json({ protocolVersion: "0.1", requestId: body.requestId, preference: "eu" }),
    );
    await vi.waitFor(() => {
      expect(app().languageBusy).toBe(false);
    });
    expect(app().languageSaveWarning).toBe(false);
    request.mockRejectedValueOnce(new Error("offline"));
    app().onPreferenceChange?.("en");
    await vi.waitFor(() => {
      expect(app().languageSaveWarning).toBe(true);
    });
    await app().session?.controller.signOut();
    expect(request.mock.calls.at(-1)?.[1].signal?.aborted).toBe(true);
    expect(app().languageBusy).toBe(false);
    app().onPreferenceChange?.("es");
    expect(document.documentElement.lang).toBe("es");
    preference = null;
    await app().session?.controller.signIn();
    await vi.waitFor(() => {
      expect(app().languageBusy).toBe(false);
    });
    expect(document.documentElement.lang).toBe("es");
    await app().session?.controller.signOut();
    preference = "automatic";
    await app().session?.controller.signIn();
    await vi.waitFor(() => {
      expect(app().languageBusy).toBe(false);
    });
    expect(document.documentElement.lang).toBe(languages === undefined ? "en" : "eu");
    handle.dispose();
    expect(request.mock.calls.at(-1)?.[1].signal?.aborted).toBe(true);
  },
);
