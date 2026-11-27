import { createTranslator } from "@marea/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@inquirer/select", () => ({ default: prompt.select }));

import { createVersionGate } from "./version-gate.boundary.js";

const translator = createTranslator("es");

function setTerminal(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
}

describe("version gate at a real terminal", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.stdin, "isTTY");
    Reflect.deleteProperty(process.stdout, "isTTY");
    prompt.select.mockReset();
  });

  it("asks with a selection whose first choice is to leave", async () => {
    setTerminal(true, true);
    prompt.select.mockResolvedValue(true);
    const gate = createVersionGate({ serverUrl: "https://teacher.example", translator });
    await expect(gate("1.0.1", "1.0.0")).resolves.toBeUndefined();
    const [question] = prompt.select.mock.calls[0] as [
      { message: string; choices: { name: string; value: boolean }[] },
    ];
    expect(question.message).toContain("1.0.1");
    expect(question.message).toContain("1.0.0");
    expect(question.choices).toEqual([
      { name: translator.t("student.version.exit"), value: false },
      { name: translator.t("student.version.continue"), value: true },
    ]);
  });

  it.each([
    [true, false],
    [false, true],
  ])("refuses unless both input and output are a terminal (%s, %s)", async (stdin, stdout) => {
    setTerminal(stdin, stdout);
    const gate = createVersionGate({ serverUrl: "https://teacher.example", translator });
    await expect(gate("1.0.1", "1.0.0")).rejects.toThrow(
      translator.t("student.version.terminal-required"),
    );
    expect(prompt.select).not.toHaveBeenCalled();
  });
});
