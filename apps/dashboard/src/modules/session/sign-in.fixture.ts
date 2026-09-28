import type { SessionViewProperties } from "./session-views.js";

export const signedOutSession: Omit<SessionViewProperties, "locale"> = {
  state: { status: "signed-out", displayName: null, login: "", password: "", problem: null },
  controller: {
    setLogin: () => undefined,
    setPassword: () => undefined,
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  },
};
