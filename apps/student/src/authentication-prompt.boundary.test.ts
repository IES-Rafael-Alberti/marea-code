import { beforeEach, describe, expect, it, vi } from "vitest";

interface InputOptions {
  readonly message: string;
  readonly required: boolean;
}

interface PasswordOptions {
  readonly mask: string;
  readonly message: string;
  readonly validate: (value: string) => boolean | string;
}

interface SelectOptions {
  readonly choices: readonly { readonly name: string; readonly value: string }[];
  readonly message: string;
}

const vendor = vi.hoisted(() => ({
  input: vi.fn<(options: InputOptions) => Promise<string>>(),
  password: vi.fn<(options: PasswordOptions) => Promise<string>>(),
  select: vi.fn<(options: SelectOptions) => Promise<string>>(),
}));

vi.mock("@inquirer/input", () => ({ default: vendor.input }));
vi.mock("@inquirer/password", () => ({ default: vendor.password }));
vi.mock("@inquirer/select", () => ({ default: vendor.select }));

import { createTranslator } from "@marea/i18n";
import { IdentityProviderIdSchema } from "@marea/protocol";

import {
  createAuthenticationPrompt,
  createInquirerAuthenticationQuestions,
  type AuthenticationMethodChoice,
  type AuthenticationQuestions,
} from "./authentication-prompt.boundary.js";

const NO_PROVIDERS = { providers: [] };
const GOOGLE = {
  providerId: IdentityProviderIdSchema.parse("org.marea.google-workspace"),
  displayName: { es: "Google del centro", en: "School Google", eu: "Ikastetxeko Google" },
};

class ScriptedQuestions implements AuthenticationQuestions {
  readonly choices: {
    readonly message: string;
    readonly values: readonly AuthenticationMethodChoice[];
  }[] = [];
  readonly prompts: string[] = [];
  method = "login";
  secrets: string[] = ["password"];
  texts: string[] = ["student"];

  choose(message: string, choices: readonly AuthenticationMethodChoice[]) {
    this.choices.push({ message, values: choices });
    return Promise.resolve(this.method);
  }

  secret(message: string): Promise<string> {
    this.prompts.push(message);
    return Promise.resolve(this.secrets.shift() ?? "");
  }

  text(message: string): Promise<string> {
    this.prompts.push(message);
    return Promise.resolve(this.texts.shift() ?? "");
  }
}

describe("student authentication prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects a login with localized labels", async () => {
    const questions = new ScriptedQuestions();
    const translator = createTranslator("en");

    await expect(
      createAuthenticationPrompt(questions, translator).authenticate("missing", NO_PROVIDERS),
    ).resolves.toEqual({
      kind: "login",
      login: "student",
      password: "password",
    });
    expect(questions.choices).toEqual([
      {
        message: "How would you like to continue?",
        values: [
          { name: "Sign in", value: "login" },
          { name: "Create my account with an invitation", value: "enroll" },
        ],
      },
    ]);
    expect(questions.prompts).toEqual(["Username", "Password"]);
  });

  it("collects enrollment and explains a rejected stored session", async () => {
    const questions = new ScriptedQuestions();
    questions.method = "enroll";
    questions.texts = ["Student Ada", "physics_invite_2026", "ada.student"];
    const prompt = createAuthenticationPrompt(questions, createTranslator("en"));

    await expect(prompt.authenticate("rejected", NO_PROVIDERS)).resolves.toEqual({
      displayName: "Student Ada",
      invitationCode: "physics_invite_2026",
      kind: "enroll",
      login: "ada.student",
      password: "password",
    });
    expect(questions.choices[0]?.message).toContain("saved session is no longer valid");
    expect(questions.prompts).toEqual([
      "Name shown to your teacher",
      "Invitation code",
      "Username",
      "Password",
    ]);
  });

  it("offers each external provider in the interface language and returns its choice", async () => {
    const questions = new ScriptedQuestions();
    questions.method = "external:org.marea.google-workspace";
    const prompt = createAuthenticationPrompt(questions, createTranslator("es"));

    await expect(prompt.authenticate("missing", { providers: [GOOGLE] })).resolves.toEqual({
      kind: "external",
      providerId: "org.marea.google-workspace",
    });
    expect(questions.choices[0]?.values).toEqual([
      { name: "Iniciar sesión", value: "login" },
      { name: "Crear mi cuenta con una invitación", value: "enroll" },
      { name: "Entrar con Google del centro", value: "external:org.marea.google-workspace" },
    ]);
    expect(questions.prompts).toEqual([]);
    questions.method = "external:org.other";
    questions.texts = ["Student Ada", "physics_invite_2026", "ada.student"];
    await expect(prompt.authenticate("missing", { providers: [GOOGLE] })).resolves.toMatchObject({
      kind: "enroll",
    });
  });

  it("asks which class to work in by its display name", async () => {
    const questions = new ScriptedQuestions();
    questions.method = "class:two";
    const prompt = createAuthenticationPrompt(questions, createTranslator("en"));
    await expect(
      prompt.chooseClass([
        { classId: "class:one", displayName: "Databases" },
        { classId: "class:two", displayName: "Programming" },
      ]),
    ).resolves.toBe("class:two");
    expect(questions.choices).toEqual([
      {
        message: "Which class are you working in?",
        values: [
          { name: "Databases", value: "class:one" },
          { name: "Programming", value: "class:two" },
        ],
      },
    ]);
  });

  it("rejects an invalid invitation at the input boundary", async () => {
    const questions = new ScriptedQuestions();
    questions.method = "enroll";
    questions.texts = ["Student Ada", "invalid code"];

    await expect(
      createAuthenticationPrompt(questions, createTranslator("es")).authenticate(
        "missing",
        NO_PROVIDERS,
      ),
    ).rejects.toThrow();
  });

  it("adapts Inquirer with required text and masked validated secrets", async () => {
    vendor.select.mockResolvedValue("login");
    vendor.input.mockResolvedValue("student");
    vendor.password.mockResolvedValue("password");
    const questions = createInquirerAuthenticationQuestions(createTranslator("en"));
    const choices = [{ name: "Sign in", value: "login" }];

    await expect(questions.choose("Method", choices)).resolves.toBe("login");
    await expect(questions.text("Username")).resolves.toBe("student");
    await expect(questions.secret("Password")).resolves.toBe("password");
    expect(vendor.select).toHaveBeenCalledWith({ choices, message: "Method" });
    expect(vendor.input).toHaveBeenCalledWith({ message: "Username", required: true });
    const passwordOptions = vendor.password.mock.calls[0]?.[0];
    if (passwordOptions === undefined) throw new Error("Password options were not captured.");
    expect(passwordOptions).toMatchObject({ mask: "*", message: "Password" });
    expect(passwordOptions.validate("")).toBe("This field is required.");
    expect(passwordOptions.validate("secret")).toBe(true);
  });
});
