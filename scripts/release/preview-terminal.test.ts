import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  readPassword: vi.fn(),
}));
vi.mock("node:readline/promises", () => mocks);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/input.js", async (original) => ({
  ...(await original<
    typeof import("../../apps/teacher-server/src/platform/operator-cli/input.js")
  >()),
  readPassword: mocks.readPassword,
}));
import { PasswordValidationError } from "../../apps/teacher-server/src/platform/operator-cli/input.js";
import {
  OperatorCliError,
  OperatorCliInterrupted,
} from "../../apps/teacher-server/src/platform/operator-cli/errors.js";
import { acceptUpdate, question, secret, serverQuestions } from "./preview-terminal.boundary.js";
let output: MockInstance<typeof process.stderr.write>;
let resume: MockInstance<typeof process.stdin.resume>;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  mocks.createInterface.mockReturnValue({ question: mocks.question, close: mocks.close });
  mocks.question.mockResolvedValue("");
  mocks.readPassword.mockResolvedValue("private-password");
  resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stderr, stderrTty],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
});

it("handles defaults, blank input, trimming and terminal cleanup after cancellation", async () => {
  expect(await question("Name", "School")).toBe("School");
  expect(mocks.createInterface).toHaveBeenCalledWith({
    input: process.stdin,
    output: process.stderr,
  });
  expect(mocks.question).toHaveBeenCalledWith("Name [School]: ");
  expect(await question("Name")).toBe("");
  expect(mocks.question).toHaveBeenLastCalledWith("Name: ");
  mocks.question.mockResolvedValueOnce("  Answer  ");
  expect(await question("Name", "default")).toBe("Answer");
  mocks.question.mockRejectedValueOnce(new Error("cancelled"));
  await expect(question("Name")).rejects.toThrow("cancelled");
  expect(mocks.close).toHaveBeenCalledTimes(4);
  Object.defineProperty(process.stdin, "isTTY", { value: false });
  await expect(question("Name")).rejects.toThrow("interactive terminal");
});

it("uses the existing hidden-password reader and resumes input after a previous question", async () => {
  expect(await secret("Secret: ")).toBe("private-password");
  const prompt = mocks.readPassword.mock.calls[0]?.[2] as (text: string) => void;
  prompt("Password: ");
  prompt("\n");
  expect(output).toHaveBeenCalledWith("Secret: ");
  expect(output).toHaveBeenCalledWith("\n");
  expect(resume).toHaveBeenCalledOnce();
  expect(mocks.readPassword).toHaveBeenCalledWith(
    process.stdin,
    false,
    expect.any(Function),
    expect.any(AbortSignal),
  );
});

it("never accepts an update without an interactive affirmative answer", async () => {
  expect(await acceptUpdate("0.1.0-preview.2")).toBe(false);
  mocks.question.mockResolvedValueOnce("S");
  expect(await acceptUpdate("0.1.0-preview.2")).toBe(true);
  Object.defineProperty(process.stdin, "isTTY", { value: false });
  expect(await acceptUpdate("v")).toBe(false);
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  Object.defineProperty(process.stderr, "isTTY", { value: false });
  expect(await acceptUpdate("v")).toBe(false);
  expect(mocks.question.mock.calls).toMatchSnapshot("update consent prompts");
  expect(mocks.question).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "collects validated setup answers, with optional Google: %s",
  async (google) => {
    const replies = [
      "School",
      "",
      "Teacher",
      "",
      "",
      "",
      google ? "s" : "n",
      "school.test",
      "google-client-id",
    ];
    for (const reply of replies) mocks.question.mockResolvedValueOnce(reply);
    const result = await serverQuestions();
    expect(result).toEqual({
      password: "private-password",
      answers: {
        center: "School",
        classroom: "Clase de prueba",
        teacher: "Teacher",
        login: "profe",
        port: 18787,
        origin: "http://127.0.0.1:18787",
        google: google
          ? {
              domain: "school.test",
              clientId: "google-client-id",
              clientSecret: "private-password",
            }
          : undefined,
      },
    });
    expect(mocks.question.mock.calls).toMatchSnapshot("setup questions");
    for (const call of mocks.readPassword.mock.calls) {
      const prompt = call[2] as (text: string) => void;
      prompt("Password: ");
    }
    expect(output.mock.calls).toMatchSnapshot("setup guidance and secret prompts");
    expect(mocks.readPassword).toHaveBeenCalledTimes(google ? 3 : 2);
  },
);

it("retries mismatching passwords without repeating the school questions", async () => {
  mocks.question.mockResolvedValue("School").mockResolvedValueOnce("School");
  for (const reply of ["", "Teacher", "", "", "", "n"]) mocks.question.mockResolvedValueOnce(reply);
  mocks.readPassword
    .mockResolvedValueOnce("first-password")
    .mockResolvedValueOnce("other-password");
  expect((await serverQuestions()).password).toBe("private-password");
  expect(output).toHaveBeenCalledWith("Las contraseñas no coinciden. Vuelve a introducirlas.\n");
  expect(mocks.readPassword).toHaveBeenCalledTimes(4);
  expect(mocks.question).toHaveBeenCalledTimes(7);
});

it.each([false, true])(
  "retries invalid password input, including confirmation: %s",
  async (confirmation) => {
    for (const reply of ["School", "", "Teacher", "", "", "", "n"])
      mocks.question.mockResolvedValueOnce(reply);
    if (confirmation) mocks.readPassword.mockResolvedValueOnce("first-password");
    mocks.readPassword.mockRejectedValueOnce(new PasswordValidationError());
    expect((await serverQuestions()).password).toBe("private-password");
    expect(output).toHaveBeenCalledWith(
      "Contraseña no válida: usa entre 12 y 256 caracteres. Inténtalo de nuevo.\n",
    );
    expect(mocks.readPassword).toHaveBeenCalledTimes(confirmation ? 4 : 3);
  },
);

it.each([
  new OperatorCliInterrupted(130),
  new OperatorCliError("invalid-input"),
  new Error("stream failed"),
])("does not retry interruptions or terminal failures: %s", async (error) => {
  mocks.readPassword.mockRejectedValueOnce(error);
  await expect(serverQuestions()).rejects.toBe(error);
  expect(mocks.readPassword).toHaveBeenCalledOnce();
});

it("explains the protocol requirement before requesting an update", async () => {
  mocks.question.mockResolvedValueOnce("s");
  expect(await acceptUpdate("0.1.0-preview.3", true)).toBe(true);
  expect(mocks.question).toHaveBeenCalledWith(
    "El servidor requiere una versión compatible (0.1.0-preview.3). ¿Instalarla para conectarte? (s/n) [n]: ",
  );
});
