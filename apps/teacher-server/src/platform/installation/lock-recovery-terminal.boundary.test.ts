import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  processExists,
  processLockRecovery,
  streamTerminal,
} from "./lock-recovery-terminal.boundary.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function streams(inputTTY?: boolean, outputTTY?: boolean) {
  const input = Object.assign(new PassThrough(), inputTTY === undefined ? {} : { isTTY: inputTTY });
  const written: string[] = [];
  const output = {
    ...(outputTTY === undefined ? {} : { isTTY: outputTTY }),
    write: (text: string) => written.push(text),
  };
  const signals = new EventEmitter();
  return { input, output, written, signals };
}

describe("lock recovery terminal", () => {
  it("is interactive only when both input and output are terminals and writes through output", () => {
    for (const [input, output, interactive] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [undefined, true, false],
      [true, undefined, false],
    ] as const) {
      const s = streams(input, output);
      expect(streamTerminal(s.input, s.output, s.signals).interactive).toBe(interactive);
    }
    const s = streams(true, true);
    const terminal = streamTerminal(s.input, s.output, s.signals);
    terminal.write("question");
    expect(s.written).toEqual(["question"]);
    expect(Object.isFrozen(terminal)).toBe(true);
  });

  it("reads one line across chunks and releases input and signal listeners", async () => {
    const s = streams(true, true);
    const pause = vi.spyOn(s.input, "pause");
    const answer = streamTerminal(s.input, s.output, s.signals).readLine();
    s.input.write("ye");
    s.input.write("s\nignored\n");
    expect(await answer).toBe("yes");
    // A second question in the same process reads the paused input again.
    const empty = streamTerminal(s.input, s.output, s.signals).readLine();
    s.input.write("\n");
    expect(await empty).toBe("");
    expect(pause).toHaveBeenCalled();
    expect([s.input.listenerCount("data"), s.input.listenerCount("end")]).toEqual([0, 0]);
    expect([s.signals.listenerCount("SIGINT"), s.signals.listenerCount("SIGTERM")]).toEqual([0, 0]);
  });

  it("answers nothing when input ends or the question is interrupted", async () => {
    for (const interrupt of [
      (s: ReturnType<typeof streams>) => s.input.end(),
      (s: ReturnType<typeof streams>) => s.signals.emit("SIGINT"),
      (s: ReturnType<typeof streams>) => s.signals.emit("SIGTERM"),
    ]) {
      const s = streams(true, true);
      const answer = streamTerminal(s.input, s.output, s.signals).readLine();
      s.input.write("y");
      interrupt(s);
      s.input.resume();
      expect(await answer).toBeUndefined();
      expect([s.signals.listenerCount("SIGINT"), s.signals.listenerCount("SIGTERM")]).toEqual([
        0, 0,
      ]);
    }
  });

  it("recognises existing processes, including those owned by another user", () => {
    expect(processExists(process.pid)).toBe(true);
    const kill = vi.spyOn(process, "kill");
    for (const [thrown, exists] of [
      [Object.assign(new Error("denied"), { code: "EPERM" }), true],
      [Object.assign(new Error("missing"), { code: "ESRCH" }), false],
      [new Error("no code"), false],
      [{ code: "EPERM" }, false],
    ] as const) {
      kill.mockImplementationOnce(() => {
        throw thrown as Error;
      });
      expect(processExists(4242)).toBe(exists);
    }
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("wires the process streams and process table", () => {
    const tty = (stream: NodeJS.ReadStream | NodeJS.WriteStream) =>
      Object.getOwnPropertyDescriptor(stream, "isTTY");
    const saved = [tty(process.stdin), tty(process.stderr)] as const;
    try {
      for (const stream of [process.stdin, process.stderr])
        Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
      expect(processLockRecovery().terminal.interactive).toBe(true);
    } finally {
      for (const [stream, descriptor] of [
        [process.stdin, saved[0]],
        [process.stderr, saved[1]],
      ] as const) {
        if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
        else Object.defineProperty(stream, "isTTY", descriptor);
      }
    }
    const recovery = processLockRecovery();
    expect(recovery.processExists).toBe(processExists);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    recovery.terminal.write("text");
    expect(write).toHaveBeenCalledWith("text");
  });
});
