import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:readline/promises", () => mocks);
import { acceptUpdate, question } from "./preview-terminal.boundary.js";
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  mocks.createInterface.mockReturnValue({ question: mocks.question, close: mocks.close });
  mocks.question.mockResolvedValue("");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
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

it("explains the protocol requirement before requesting an update", async () => {
  mocks.question.mockResolvedValueOnce("s");
  expect(await acceptUpdate("0.1.0-preview.3", true)).toBe(true);
  expect(mocks.question).toHaveBeenCalledWith(
    "El servidor requiere una versión compatible (0.1.0-preview.3). ¿Instalarla para conectarte? (s/n) [n]: ",
  );
});
