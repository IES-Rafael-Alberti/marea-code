import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { reviewElements } from "../evaluation/react-tree.fixture.js";
import type { SessionState } from "./session-controller.js";
import { sessionMessages } from "./session-messages.js";
import { SessionBar, SignInModule, type SessionActions } from "./session-views.js";

const base: SessionState = {
  status: "signed-out",
  displayName: null,
  login: "profe",
  password: "secret-password",
  problem: null,
};

function actions() {
  return {
    setLogin: vi.fn<SessionActions["setLogin"]>(),
    setPassword: vi.fn<SessionActions["setPassword"]>(),
    signIn: vi.fn<SessionActions["signIn"]>(() => Promise.resolve()),
    signOut: vi.fn<SessionActions["signOut"]>(() => Promise.resolve()),
  };
}

interface Handlers {
  readonly name?: string;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onSubmit?: (event: { preventDefault(): void }) => void;
  readonly onClick?: () => void;
}

const elements = (node: ReactElement): readonly ReactElement<Handlers>[] =>
  reviewElements(node).map((element) => element as ReactElement<Handlers>);

describe("dashboard sign-in views", () => {
  it("shows only a status while the session is being checked", () => {
    const html = renderToStaticMarkup(
      <SignInModule locale="es" state={{ ...base, status: "checking" }} controller={actions()} />,
    );
    expect(html).toBe(
      '<section class="dashboard-module session-module" aria-live="polite"><p>Comprobando tu sesión…</p></section>',
    );
  });

  it("renders a labelled form that sends the typed credentials", () => {
    const controller = actions();
    const node = <SignInModule locale="en" state={base} controller={controller} />;
    const html = renderToStaticMarkup(node);
    expect(html).toContain('<h2 id="sign-in-heading">Sign in</h2>');
    expect(html).toContain(
      '<label>Username<input autoComplete="username" autoCapitalize="none" spellCheck="false" required="" name="username" value="profe"/></label>',
    );
    expect(html).toContain(
      '<label>Password<input type="password" autoComplete="current-password" required="" name="password" value="secret-password"/></label>',
    );
    expect(html).toContain('<button type="submit">Sign in</button>');
    expect(html).not.toContain('role="alert"');
    const tree = elements(node);
    const input = (name: string) => tree.find((element) => element.props.name === name);
    input("username")?.props.onChange?.({ currentTarget: { value: "ada" } });
    input("password")?.props.onChange?.({ currentTarget: { value: "another-password" } });
    expect(controller.setLogin).toHaveBeenCalledExactlyOnceWith("ada");
    expect(controller.setPassword).toHaveBeenCalledExactlyOnceWith("another-password");
    const preventDefault = vi.fn();
    tree.find((element) => element.type === "form")?.props.onSubmit?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(controller.signIn).toHaveBeenCalledOnce();
  });

  it("disables the form while signing in and explains every problem", () => {
    const busy = renderToStaticMarkup(
      <SignInModule locale="es" state={{ ...base, status: "signing-in" }} controller={actions()} />,
    );
    expect(busy.match(/disabled=""/gu)).toHaveLength(3);
    expect(busy).toContain("Iniciando sesión…");
    for (const locale of ["es", "en"] as const)
      for (const problem of ["invalid", "not-teacher", "unavailable"] as const)
        expect(
          renderToStaticMarkup(
            <SignInModule locale={locale} state={{ ...base, problem }} controller={actions()} />,
          ),
        ).toContain(
          `<p class="session-problem" role="alert">${sessionMessages(locale).problems[problem]}</p>`,
        );
  });

  it("shows the signed-in teacher with a sign-out action", () => {
    const controller = actions();
    const signedIn = { ...base, status: "signed-in", displayName: "Ada" } as const;
    const node = <SessionBar locale="es" state={signedIn} controller={controller} />;
    expect(renderToStaticMarkup(node)).toBe(
      '<div class="session-bar"><span>Sesión iniciada como Ada</span><button type="button">Cerrar sesión</button></div>',
    );
    elements(node)
      .find((element) => element.type === "button")
      ?.props.onClick?.();
    expect(controller.signOut).toHaveBeenCalledOnce();
    expect(
      renderToStaticMarkup(
        <SessionBar
          locale="en"
          state={{ ...signedIn, status: "signing-out", problem: "unavailable" }}
          controller={actions()}
        />,
      ),
    ).toBe(
      '<div class="session-bar"><span>Signed in as Ada</span><button type="button" disabled="">Signing out…</button><span class="session-problem" role="alert">The teacher server could not be reached. Try again in a moment.</span></div>',
    );
    expect(
      renderToStaticMarkup(
        <SessionBar
          locale="en"
          state={{ ...signedIn, displayName: null, problem: "invalid" }}
          controller={actions()}
        />,
      ),
    ).toBe(
      '<div class="session-bar"><span>Signed in as </span><button type="button">Sign out</button></div>',
    );
  });

  it("has complete Spanish and English texts", () => {
    const texts = (locale: "es" | "en") => {
      const { signedInAs, ...messages } = sessionMessages(locale);
      return { ...messages, signedInAs: signedInAs("Ada") };
    };
    expect(texts("en")).toEqual({
      heading: "Sign in",
      intro: "Sign in with the teacher account your administrator created for you.",
      checking: "Checking your session…",
      login: "Username",
      password: "Password",
      submit: "Sign in",
      submitting: "Signing in…",
      signedInAs: "Signed in as Ada",
      signOut: "Sign out",
      signingOut: "Signing out…",
      problems: {
        invalid: "The username or password is not correct.",
        "not-teacher": "This dashboard is for teachers. Students use the marea application.",
        unavailable: "The teacher server could not be reached. Try again in a moment.",
      },
    });
    expect(texts("es")).toEqual({
      heading: "Iniciar sesión",
      intro: "Inicia sesión con la cuenta de docente que te ha creado la administración.",
      checking: "Comprobando tu sesión…",
      login: "Usuario",
      password: "Contraseña",
      submit: "Iniciar sesión",
      submitting: "Iniciando sesión…",
      signedInAs: "Sesión iniciada como Ada",
      signOut: "Cerrar sesión",
      signingOut: "Cerrando sesión…",
      problems: {
        invalid: "El usuario o la contraseña no son correctos.",
        "not-teacher": "Este panel es para docentes. El alumnado usa la aplicación marea.",
        unavailable:
          "No se ha podido contactar con el servidor docente. Inténtalo de nuevo en un momento.",
      },
    });
  });
});
