import type { ReactElement, ReactNode } from "react";

import type { DashboardLocale } from "../../messages.js";
import type { SessionState } from "./session-controller.js";
import { sessionMessages } from "./session-messages.js";

export interface SessionActions {
  setLogin(login: string): void;
  setPassword(password: string): void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export interface SessionViewProperties {
  readonly locale: DashboardLocale;
  readonly state: SessionState;
  readonly controller: SessionActions;
}

/** The sign-in form shown instead of the dashboard modules while no teacher is signed in. */
export function SignInModule({
  locale,
  state,
  controller,
  languageControl,
}: SessionViewProperties & {
  readonly languageControl?: ReactNode;
}): ReactElement {
  const messages = sessionMessages(locale);
  if (state.status === "checking")
    return (
      <section className="dashboard-module session-module" aria-live="polite">
        <p>{messages.checking}</p>
      </section>
    );
  const busy = state.status === "signing-in";
  return (
    <section className="dashboard-module session-module" aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">{messages.heading}</h2>
      <p>{messages.intro}</p>
      <form
        className="session-form"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.signIn();
        }}
      >
        <label>
          {messages.login}
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={busy}
            value={state.login}
            onChange={(event) => {
              controller.setLogin(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          {messages.password}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
            value={state.password}
            onChange={(event) => {
              controller.setPassword(event.currentTarget.value);
            }}
          />
        </label>
        {languageControl}
        {state.problem !== null && (
          <p className="session-problem" role="alert">
            {messages.problems[state.problem]}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? messages.submitting : messages.submit}
        </button>
      </form>
    </section>
  );
}

/** The signed-in teacher and the sign-out action, shown in the dashboard header. */
export function SessionBar({ locale, state, controller }: SessionViewProperties): ReactElement {
  const messages = sessionMessages(locale);
  const busy = state.status === "signing-out";
  return (
    <div className="session-bar">
      <span>{messages.signedInAs(state.displayName ?? "")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void controller.signOut();
        }}
      >
        {busy ? messages.signingOut : messages.signOut}
      </button>
      {state.problem === "unavailable" && (
        <span className="session-problem" role="alert">
          {messages.problems.unavailable}
        </span>
      )}
    </div>
  );
}
