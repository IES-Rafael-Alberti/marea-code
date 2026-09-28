import { ActiveRunDashboardResponseSchema } from "@marea/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../dashboard-app.js";
import type { ActiveRunsClient } from "../active-runs/active-runs-client.boundary.js";
import { startDashboard } from "../../start-dashboard.js";
import { mockClient, classSummary, classesPage } from "../teaching/teaching-controller.fixture.js";
import type { DashboardSessionClient } from "./session-client.boundary.js";
import type { SessionState } from "./session-controller.js";

const runs = ActiveRunDashboardResponseSchema.parse({
  kind: "active-runs-response",
  protocolVersion: "0.1",
  requestId: "request:dashboard",
  generatedAt: "2026-09-15T08:00:00.000Z",
  viewer: { role: "teacher", displayName: "Ada" },
  runs: [],
  nextCursor: null,
});

const actions = {
  setLogin: () => undefined,
  setPassword: () => undefined,
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
};

const state = (status: SessionState["status"]): SessionState => ({
  status,
  displayName: "Ada",
  login: "",
  password: "",
  problem: null,
});

function sessionClient() {
  return {
    current: vi.fn<DashboardSessionClient["current"]>(),
    signIn: vi.fn<DashboardSessionClient["signIn"]>(),
    signOut: vi.fn<DashboardSessionClient["signOut"]>(),
  };
}

function start(session: ReturnType<typeof sessionClient>) {
  const rendered: ReactNode[] = [];
  const unmount = vi.fn();
  const load = vi.fn<ActiveRunsClient["load"]>().mockResolvedValue(runs);
  const teaching = mockClient();
  teaching.classes.mockResolvedValue(classesPage([classSummary()]));
  const handle = startDashboard(
    {
      document: {
        documentElement: { lang: "" },
        getElementById: (id: string): HTMLElement | null =>
          id === "root" ? ({} as HTMLElement) : null,
      } as Document,
      language: "es",
    },
    { load },
    () => ({
      render: (children) => {
        rendered.push(children);
      },
      unmount,
    }),
    undefined,
    teaching,
    undefined,
    undefined,
    session,
  );
  const html = () => renderToStaticMarkup(rendered.at(-1));
  return { handle, html, load, teaching, unmount, rendered };
}

describe("dashboard behind the teacher session", () => {
  it("shows the sign-in form instead of the modules until a teacher is signed in", () => {
    for (const status of ["checking", "signed-out", "signing-in"] as const) {
      const html = renderToStaticMarkup(
        <DashboardApp locale="es" session={{ state: state(status), controller: actions }} />,
      );
      expect(html, status).toContain("session-module");
      expect(html, status).not.toContain("Sesiones activas");
      expect(html, status).not.toContain("Sesión iniciada como");
      if (status === "checking") expect(html).not.toContain("<select");
      else {
        expect(html.indexOf('name="password"')).toBeLessThan(html.indexOf("<select"));
        expect(html.indexOf("<select")).toBeLessThan(html.indexOf('type="submit"'));
        expect(html).toContain(
          status === "signing-in"
            ? '<select aria-label="Idioma de la interfaz" disabled=""'
            : '<select aria-label="Idioma de la interfaz">',
        );
      }
    }
    for (const status of ["signed-in", "signing-out"] as const) {
      const html = renderToStaticMarkup(
        <DashboardApp locale="es" session={{ state: state(status), controller: actions }} />,
      );
      expect(html, status).toContain("Sesiones activas");
      expect(html, status).toContain("Sesión iniciada como Ada");
      expect(html, status).not.toContain("session-module");
      expect(html, status).not.toContain("<select");
    }
    const withoutSession = renderToStaticMarkup(<DashboardApp locale="es" />);
    expect(withoutSession).toContain("Sesiones activas");
    expect(withoutSession).not.toContain("session");
    expect(withoutSession).not.toContain("<select");
  });

  it("chooses the interface before sign-in and keeps it until sign-out", async () => {
    const session = sessionClient();
    session.current.mockResolvedValue({ status: "signed-out" });
    const dashboard = start(session);
    const checking = dashboard.rendered.at(-1) as {
      props: { onPreferenceChange: (preference: "en") => void; locale: string };
    };
    checking.props.onPreferenceChange("en");
    expect((dashboard.rendered.at(-1) as typeof checking).props.locale).toBe("es");
    await dashboard.handle.ready;
    const signedOut = dashboard.rendered.at(-1) as {
      props: { onPreferenceChange: (preference: "automatic" | "es" | "en" | "eu") => void };
    };
    signedOut.props.onPreferenceChange("en");
    expect(dashboard.html()).toContain("Sign in");
    expect((dashboard.rendered.at(-1) as { props: { locale: string } }).props.locale).toBe("en");
    expect(dashboard.load).not.toHaveBeenCalled();

    const authentication =
      Promise.withResolvers<Awaited<ReturnType<DashboardSessionClient["signIn"]>>>();
    session.signIn.mockReturnValue(authentication.promise);
    const signingIn = (
      dashboard.rendered.at(-1) as {
        props: { session: { controller: { signIn(): Promise<void> } } };
      }
    ).props.session.controller.signIn();
    signedOut.props.onPreferenceChange("eu");
    expect((dashboard.rendered.at(-1) as { props: { locale: string } }).props.locale).toBe("en");
    expect(dashboard.html()).toContain('<select aria-label="Interface language" disabled=""');
    authentication.resolve({ status: "signed-in", displayName: "Ada" });
    await signingIn;
    await vi.waitFor(() => {
      expect(dashboard.html()).toContain("Active sessions");
    });
    expect(dashboard.load).toHaveBeenCalledOnce();
    const signedIn = dashboard.rendered.at(-1) as {
      props: { onPreferenceChange: (preference: "automatic" | "es" | "en" | "eu") => void };
    };
    signedIn.props.onPreferenceChange("eu");
    expect((dashboard.rendered.at(-1) as { props: { locale: string } }).props.locale).toBe("en");
    expect(dashboard.html()).not.toContain("interface-language");
    expect(dashboard.load).toHaveBeenCalledOnce();
    session.signOut.mockResolvedValue(undefined);
    await (
      dashboard.rendered.at(-1) as {
        props: { session: { controller: { signOut(): Promise<void> } } };
      }
    ).props.session.controller.signOut();
    expect(dashboard.html()).toContain('<option value="en" selected="">');
    signedOut.props.onPreferenceChange("eu");
    expect((dashboard.rendered.at(-1) as { props: { locale: string } }).props.locale).toBe("eu");
    dashboard.handle.dispose();
  });

  it("loads nothing for a signed-out visitor, then starts the modules after sign-in", async () => {
    const session = sessionClient();
    session.current.mockResolvedValue({ status: "signed-out" });
    const dashboard = start(session);
    expect(dashboard.html()).toContain("Comprobando tu sesión…");
    await dashboard.handle.ready;
    expect(dashboard.html()).toContain("Iniciar sesión");
    expect(dashboard.load).not.toHaveBeenCalled();
    expect(dashboard.teaching.classes).not.toHaveBeenCalled();

    session.signIn.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    const rendered = dashboard.rendered.length;
    // The controller behind the rendered form signs in and the modules start once.
    const app = dashboard.rendered.at(-1) as {
      props: { session: { controller: { signIn(): Promise<void> } } };
    };
    await app.props.session.controller.signIn();
    await vi.waitFor(() => {
      expect(dashboard.html()).toContain("Sesión iniciada como Ada");
    });
    expect(dashboard.rendered.length).toBeGreaterThan(rendered);
    expect(dashboard.load).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(dashboard.teaching.classes).toHaveBeenCalledOnce();
    });
    dashboard.handle.dispose();
    expect(dashboard.unmount).toHaveBeenCalledOnce();
  });

  it("starts the modules for an existing session and discards them on sign-out", async () => {
    const session = sessionClient();
    session.current.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    session.signOut.mockResolvedValue(undefined);
    const dashboard = start(session);
    await dashboard.handle.ready;
    expect(dashboard.load).toHaveBeenCalledOnce();
    expect(dashboard.teaching.classes).toHaveBeenCalledOnce();
    const signal = dashboard.load.mock.calls[0] ?? [];
    expect(dashboard.html()).toContain("Sesión iniciada como Ada");
    const app = dashboard.rendered.at(-1) as {
      props: { session: { controller: { signOut(): Promise<void> } } };
    };
    const navigation = dashboard.rendered.at(-1) as {
      props: { navigation: { section: string; select(section: string): void } };
    };
    navigation.props.navigation.select("skills");
    await app.props.session.controller.signOut();
    const signedOut = dashboard.rendered.at(-1) as typeof navigation;
    expect(signedOut.props.navigation.section).toBe("sessions");
    expect(signal[0]?.aborted).toBe(true);
    expect(dashboard.html()).toContain("Iniciar sesión");
    expect(dashboard.html()).not.toContain("Sesiones activas");
    dashboard.handle.dispose();
    const after = dashboard.rendered.length;
    session.current.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    await app.props.session.controller.signOut();
    expect(dashboard.rendered).toHaveLength(after);
  });

  it("keeps the same modules through a failed sign-out and waits for their first load", async () => {
    const session = sessionClient();
    session.current.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    const dashboard = start(session);
    let loaded: (value: typeof runs) => void = () => undefined;
    dashboard.load.mockReset();
    dashboard.load.mockReturnValue(
      new Promise((resolve) => {
        loaded = resolve;
      }),
    );
    let ready = false;
    void dashboard.handle.ready.then(() => {
      ready = true;
    });
    await vi.waitFor(() => {
      expect(dashboard.load).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toBe(false);
    loaded(runs);
    await dashboard.handle.ready;
    expect(dashboard.html()).toContain("Esperando sesiones activas");

    let failSignOut: (error: Error) => void = () => undefined;
    session.signOut.mockReturnValue(
      new Promise((_resolve, reject) => {
        failSignOut = reject;
      }),
    );
    const app = dashboard.rendered.at(-1) as {
      props: { session: { controller: { signOut(): Promise<void> } } };
    };
    const signingOut = app.props.session.controller.signOut();
    expect(dashboard.html()).toContain("Cerrando sesión…");
    expect(dashboard.html()).toContain("Esperando sesiones activas");
    failSignOut(new Error("offline"));
    await signingOut;
    expect(dashboard.html()).toContain("Esperando sesiones activas");
    expect(dashboard.load).toHaveBeenCalledOnce();
    expect(dashboard.teaching.classes).toHaveBeenCalledOnce();
    dashboard.handle.dispose();
  });
});
