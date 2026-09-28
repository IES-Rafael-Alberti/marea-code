import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { readJsonObject, readPassword, MAX_PASSWORD_BYTES } from "./input.js";
import { OperatorCliInterrupted } from "./errors.js";
import {
  PasswordInput,
  temporaryInstallation,
  cleanupInstallations,
} from "./filesystem.fixture.js";

afterEach(() => {
  cleanupInstallations();
  vi.restoreAllMocks();
});

function reader(tty = false, fromStdin = !tty, controller = new AbortController()) {
  const input = new PasswordInput(tty);
  const prompt = vi.fn();
  const start = () => readPassword(input, fromStdin, prompt, controller.signal);
  return { input, prompt, controller, start };
}

describe("strict bounded JSON files", () => {
  it("reads an exact-size object and preserves all own keys without accepting excess bytes", () => {
    const root = temporaryInstallation();
    const path = join(root, "request.json");
    const text = '{"__proto__":{"x":1},"a":"é"}';
    writeFileSync(path, text);
    const size = Buffer.byteLength(text);
    expect(readJsonObject(path, size)).toEqual(JSON.parse(text));
    expect(() => readJsonObject(path, size - 1)).toThrow("invalid-input");
    expect(() => readJsonObject(path, 0)).toThrow("invalid-input");
    expect(() => readJsonObject("relative.json", size)).toThrow("invalid-input");
    expect(() => readJsonObject(`${root}/./request.json`, size)).toThrow("invalid-input");
  });
  it("rejects nonobjects, malformed UTF-8, NUL, trailing JSON and BOM instead of replacing bytes", () => {
    const root = temporaryInstallation();
    const path = join(root, "request.json");
    for (const text of [
      "null",
      "[]",
      "1",
      "true",
      '"x"',
      "{",
      "{}{}",
      "{}\0",
      "\ufeff{}",
      Buffer.from([0xc3, 0x28]),
    ]) {
      writeFileSync(path, text);
      expect(() => readJsonObject(path, 100)).toThrow("invalid-input");
    }
    writeFileSync(path, "{}\n");
    expect(readJsonObject(path, 3)).toEqual({});
    writeFileSync(
      path,
      Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    expect(() => readJsonObject(path, 100)).toThrow("invalid-input");
  });
  it("rejects missing files, directories, leaf symlinks and parent aliases", () => {
    const root = temporaryInstallation();
    const path = join(root, "request.json");
    expect(() => readJsonObject(path, 100)).toThrow("invalid-input");
    expect(() => readJsonObject(root, 100)).toThrow("invalid-input");
    writeFileSync(path, "{}");
    const alias = join(root, "alias.json");
    symlinkSync(path, alias);
    expect(() => readJsonObject(alias, 100)).toThrow("invalid-input");
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "input.json"), "{}");
    symlinkSync(nested, join(root, "alias"));
    expect(() => readJsonObject(join(root, "alias/input.json"), 100)).toThrow("invalid-input");
  });
});

describe("private bounded password reader", () => {
  it("requires explicit non-TTY stdin or the non-echoing TTY prompt", async () => {
    for (const [tty, flag] of [
      [true, true],
      [false, false],
    ] as const) {
      const r = reader(tty, flag);
      await expect(r.start()).rejects.toThrow("invalid-input");
      expect(r.input.eventNames()).toEqual([]);
      expect(r.prompt).not.toHaveBeenCalled();
      expect(r.input.rawModes).toEqual([]);
    }
  });
  it("counts UTF-8 bytes while preserving exact Unicode and stripping only one stdin newline", async () => {
    for (const password of [
      "a".repeat(12),
      "b".repeat(256),
      "界".repeat(256),
      "😀".repeat(128),
      "\ufeff" + "p".repeat(12),
      "p".repeat(12) + "\r",
    ]) {
      for (const suffix of ["", "\n"]) {
        const r = reader();
        const result = r.start();
        const bytes = Buffer.from(password + suffix);
        for (let offset = 0; offset < bytes.length; offset += 2)
          r.input.send(bytes.subarray(offset, offset + 2));
        r.input.end();
        await expect(result).resolves.toBe(password);
        expect(r.input.pauses).toBe(1);
        expect(r.input.eventNames()).toEqual([]);
        expect(r.input.rawModes).toEqual([]);
        expect(r.prompt).not.toHaveBeenCalled();
      }
    }
    expect(MAX_PASSWORD_BYTES).toBe(768);
  });
  it("rejects bad encoding, character/byte limits, empty EOF, and failed streams", async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("x".repeat(11)),
      Buffer.from("x".repeat(257)),
      Buffer.from("界".repeat(256) + "aa"),
      Buffer.from([0xc3, 0x28]),
      Buffer.concat([Buffer.from("long-password"), Buffer.from([0xff])]),
      Buffer.from("界".repeat(256) + "\n\n"),
    ]) {
      const r = reader();
      const result = r.start();
      r.input.send(bytes);
      r.input.end();
      await expect(result).rejects.toThrow("invalid-input");
      expect(r.input.eventNames()).toEqual([]);
      expect(r.input.pauses).toBe(1);
    }
    const r = reader();
    const result = r.start();
    r.input.emit("error");
    await expect(result).rejects.toThrow("invalid-input");
  });
  it("restores raw mode, handles CR/LF, Unicode erase and ignores bytes after completion", async () => {
    for (const terminator of ["\r", "\n"]) {
      const r = reader(true);
      const result = r.start();
      expect(r.input.rawModes).toEqual([true]);
      expect(r.prompt.mock.calls).toEqual([["Password: "]]);
      r.input.send("\b\u007f");
      r.input.send("keep-passwordé😀\u007f\bX\b");
      r.input.send(terminator + "must-not-be-password");
      await expect(result).resolves.toBe("keep-password");
      expect(r.input.rawModes).toEqual([true, false]);
      expect(r.prompt.mock.calls).toEqual([["Password: "], ["\n"]]);
      expect(r.input.eventNames()).toEqual([]);
      expect(r.input.pauses).toBe(1);
    }
    const r = reader(true);
    r.input.isRaw = true;
    const result = r.start();
    r.input.send("long-password\n");
    await expect(result).resolves.toBe("long-password");
    expect(r.input.rawModes).toEqual([true, true]);
  });
  it("cancels Ctrl-C, rejects Ctrl-D/early TTY EOF and over-limit TTY bytes", async () => {
    for (const [bytes, message] of [
      ["\x03", "interrupted"],
      ["\x04", "invalid-input"],
      ["界".repeat(256) + "a", "invalid-input"],
      ["short\n", "invalid-input"],
    ] as const) {
      const r = reader(true);
      const result = r.start();
      r.input.send(bytes);
      await expect(result).rejects.toThrow(message);
      expect(r.input.rawModes).toEqual([true, false]);
    }
    for (const partial of ["", "valid-but-unterminated-password"]) {
      const r = reader(true);
      const result = r.start();
      r.input.send(partial);
      r.input.end();
      await expect(result).rejects.toThrow("invalid-input");
    }
  });
  it("accepts a maximal TTY value and restores only owned listeners on abort", async () => {
    const maximal = reader(true);
    const value = maximal.start();
    maximal.input.send("界".repeat(256));
    maximal.input.send("\n");
    await expect(value).resolves.toBe("界".repeat(256));
    for (const before of [true, false]) {
      const r = reader(true);
      const own = vi.fn();
      r.input.on("data", own);
      r.controller.signal.addEventListener("abort", own);
      const reason = new OperatorCliInterrupted(143);
      if (before) r.controller.abort(reason);
      const result = r.start();
      if (!before) r.controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(r.input.listeners("data")).toEqual([own]);
      expect(r.input.listeners("end")).toEqual([]);
      expect(r.input.listeners("error")).toEqual([]);
      expect(r.input.rawModes).toEqual(before ? [] : [true, false]);
      expect(getEventListeners(r.controller.signal, "abort")).toEqual([own]);
    }
  });
  it("settles reentrant events once and fails cleanly if raw mode or prompt I/O fails", async () => {
    const r = reader();
    const result = r.start();
    const data = r.input.listeners("data")[0] as (chunk: Buffer) => void;
    const end = r.input.listeners("end")[0] as () => void;
    data(Buffer.from("valid-password"));
    end();
    end();
    data(Buffer.alloc(800));
    await expect(result).resolves.toBe("valid-password");
    expect(r.input.pauses).toBe(1);
    const ignored = Buffer.alloc(100);
    const iterator = ignored[Symbol.iterator]();
    const next = vi.spyOn(iterator, "next");
    vi.spyOn(ignored, Symbol.iterator).mockReturnValue(iterator);
    data(ignored);
    expect(next).toHaveBeenCalledTimes(1);
    for (const failure of ["raw", "prompt", "pause", "restore"] as const) {
      const f = reader(true);
      if (failure === "raw")
        vi.spyOn(f.input, "setRawMode").mockImplementation(() => {
          throw new Error("private");
        });
      if (failure === "prompt")
        f.prompt.mockImplementation(() => {
          throw new Error("private");
        });
      if (failure === "pause")
        vi.spyOn(f.input, "pause").mockImplementation(() => {
          throw new Error("private");
        });
      const pending = f.start();
      if (failure === "restore")
        vi.spyOn(f.input, "setRawMode").mockImplementation(() => {
          throw new Error("private");
        });
      if (failure === "pause" || failure === "restore") f.input.send("valid-password\n");
      await expect(pending).rejects.toThrow("invalid-input");
      expect(f.input.eventNames()).toEqual([]);
    }
  });
});
