import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import input from "@inquirer/input";
import { expect, it, vi } from "vitest";

import { withAuthenticationInput } from "./authentication-input.boundary.js";

it.each([
  ["\u001b[<35;10;5M"],
  ["\u001b[<0;10;5m"],
  ["\u001b[<1;1;1M\u001b[<64;1234;1234M"],
  ["\u001b[M !!"],
  ["\u001b", "[", "<", "35", ";", "10", ";", "5", "M"],
  ["\u001b[", "M", " ", "!", "!"],
])("filters complete and fragmented mouse reports: %j", async (...chunks) => {
  const source = new PassThrough();
  const text = await withAuthenticationInput(async ({ input: filtered }) => {
    const received: Buffer[] = [];
    filtered.on("data", (chunk: Buffer) => received.push(chunk));
    for (const chunk of ["á", ...chunks, "student", ...chunks, "\u001b[A", "\u0003"]) {
      source.write(chunk);
    }
    await setImmediate();
    return Buffer.concat(received).toString("utf8");
  }, source);
  expect(text).toBe("ástudent\u001b[A\u0003");
  expect(source.listenerCount("data")).toBe(0);
});

it("forwards raw mode to a TTY and removes its input listener after cancellation", async () => {
  const raw = vi.fn();
  const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: raw });
  let filtered: NodeJS.ReadableStream | undefined;
  await expect(
    withAuthenticationInput(async (context) => {
      filtered = context.input;
      expect(filtered).toHaveProperty("isTTY", true);
      const terminal = context.input as PassThrough & { setRawMode(enabled: boolean): void };
      terminal.setRawMode(true);
      await Promise.resolve();
      throw new Error("Sign-in cancelled");
    }, source),
  ).rejects.toThrow("Sign-in cancelled");
  expect(raw).toHaveBeenCalledExactlyOnceWith(true);
  expect(source.listenerCount("data")).toBe(0);
  expect(filtered).toHaveProperty("destroyed", true);
});

it("does not insert injected mouse reports into a real Inquirer username", async () => {
  const source = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk: Buffer) => {
    screen += chunk.toString("utf8");
  });
  const answer = withAuthenticationInput(
    (context) => input({ message: "Username" }, { ...context, output }),
    source,
  );
  await vi.waitFor(() => {
    expect(screen).toContain("Username");
  });
  for (const chunk of ["\u001b[<35;10;5M", "\u001b[<0;10;5m", "student\r"]) source.write(chunk);
  await expect(answer).resolves.toBe("student");
  expect(screen).not.toContain("35;10;5M");
  expect(screen).not.toContain("0;10;5m");
});

it.each(["", "\u001b[M", "\u001b[<35;"])(
  "restores raw mode when Ctrl+C interrupts a partial report (%j)",
  async (prefix) => {
    const raw = vi.fn();
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: raw });
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk: Buffer) => {
      screen += chunk.toString("utf8");
    });
    const answer = withAuthenticationInput(
      (context) => input({ message: "Cancel sign-in" }, { ...context, output }),
      source,
    );
    await vi.waitFor(() => {
      expect(screen).toContain("Cancel sign-in");
    });
    source.write(`${prefix}\u0003`);
    await expect(answer).rejects.toThrow("SIGINT");
    expect(raw).toHaveBeenCalledWith(true);
    expect(raw).toHaveBeenLastCalledWith(false);
    expect(source.listenerCount("data")).toBe(0);
  },
);
