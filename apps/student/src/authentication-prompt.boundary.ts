import input from "@inquirer/input";
import password from "@inquirer/password";
import select from "@inquirer/select";
import type { Translator } from "@marea/i18n";
import { InvitationCodeSchema } from "@marea/protocol";

import type { AuthenticationPrompt } from "./conversation-interface.js";
import type { AuthenticationInput, AuthenticationReason } from "./contracts.js";

type AuthenticationMethod = AuthenticationInput["kind"];

export interface AuthenticationMethodChoice {
  readonly name: string;
  readonly value: AuthenticationMethod;
}

export interface AuthenticationQuestions {
  choose(
    message: string,
    choices: readonly AuthenticationMethodChoice[],
  ): Promise<AuthenticationMethod>;
  secret(message: string): Promise<string>;
  text(message: string): Promise<string>;
}

export function createInquirerAuthenticationQuestions(
  translator: Translator,
): AuthenticationQuestions {
  return Object.freeze({
    choose: (message: string, choices: readonly AuthenticationMethodChoice[]) =>
      select({ choices, message }),
    secret: (message: string) =>
      password({
        mask: "*",
        message,
        validate: (value) => value.length > 0 || translator.t("student.auth.required"),
      }),
    text: (message: string) => input({ message, required: true }),
  });
}

export function createAuthenticationPrompt(
  questions: AuthenticationQuestions,
  translator: Translator,
): AuthenticationPrompt {
  const text = (key: Parameters<Translator["t"]>[0]) => translator.t(key);
  return Object.freeze({
    async authenticate(reason: AuthenticationReason): Promise<AuthenticationInput> {
      const method = await questions.choose(
        text(reason === "rejected" ? "student.auth.method-rejected" : "student.auth.method"),
        [
          { name: text("student.auth.login"), value: "login" },
          { name: text("student.auth.enroll"), value: "enroll" },
        ],
      );
      if (method === "login") {
        return {
          kind: "login",
          login: await questions.text(text("student.auth.login-label")),
          password: await questions.secret(text("student.auth.password-label")),
        };
      }
      return {
        displayName: await questions.text(text("student.auth.display-name-label")),
        invitationCode: InvitationCodeSchema.parse(
          await questions.text(text("student.auth.invitation-label")),
        ),
        kind: "enroll",
        login: await questions.text(text("student.auth.login-label")),
        password: await questions.secret(text("student.auth.password-label")),
      };
    },
  });
}
