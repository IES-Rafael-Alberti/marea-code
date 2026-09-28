import type { DashboardSessionClient } from "./session-client.boundary.js";

type SessionProblem = "invalid" | "not-teacher" | "unavailable";

export interface SessionState {
  /** `checking` until the first answer; `signed-in` shows the dashboard, anything else the form. */
  readonly status: "checking" | "signed-out" | "signing-in" | "signed-in" | "signing-out";
  readonly displayName: string | null;
  readonly login: string;
  readonly password: string;
  readonly problem: SessionProblem | null;
}

/** Owns the teacher session of one dashboard page: check, sign in and sign out. */
export class SessionController {
  public state: SessionState = {
    status: "checking",
    displayName: null,
    login: "",
    password: "",
    problem: null,
  };
  private readonly abort = new AbortController();

  public constructor(
    private readonly client: DashboardSessionClient,
    private readonly changed: (state: SessionState) => void,
  ) {}

  public async check(): Promise<void> {
    try {
      const session = await this.client.current(this.abort.signal);
      this.update(
        session.status === "signed-in"
          ? { status: "signed-in", displayName: session.displayName }
          : { status: "signed-out" },
      );
    } catch {
      this.update({ status: "signed-out", problem: "unavailable" });
    }
  }

  public setLogin(login: string): void {
    this.update({ login });
  }

  public setPassword(password: string): void {
    this.update({ password });
  }

  public async signIn(): Promise<void> {
    if (this.state.status !== "signed-out") return;
    this.update({ status: "signing-in", problem: null });
    try {
      const result = await this.client.signIn(
        this.state.login,
        this.state.password,
        this.abort.signal,
      );
      // The password is never kept once it has been submitted.
      this.update(
        result.status === "signed-in"
          ? { status: "signed-in", displayName: result.displayName, password: "" }
          : { status: "signed-out", problem: result.status, password: "" },
      );
    } catch {
      this.update({ status: "signed-out", problem: "unavailable", password: "" });
    }
  }

  public async signOut(): Promise<void> {
    if (this.state.status !== "signed-in") return;
    this.update({ status: "signing-out", problem: null });
    try {
      await this.client.signOut(this.abort.signal);
      this.update({ status: "signed-out", displayName: null });
    } catch {
      this.update({ status: "signed-in", problem: "unavailable" });
    }
  }

  public dispose(): void {
    this.abort.abort();
  }

  private update(change: Partial<SessionState>): void {
    if (this.abort.signal.aborted) return;
    this.state = { ...this.state, ...change };
    this.changed(this.state);
  }
}
