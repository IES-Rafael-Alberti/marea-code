import { realpathSync } from "node:fs";
import { CredentialPasswordSchema } from "@marea/protocol";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { OperatorCliError, OperatorCliInterrupted } from "./errors.js";

export type JsonObject = Readonly<Record<string, unknown>>;

/** The longest valid credential: 256 UTF-16 units at three UTF-8 bytes each. */
export const MAX_PASSWORD_BYTES = 768;

export interface PasswordStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "end" | "error", listener: () => void): unknown;
  pause(): unknown;
}

const utf8 = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A completed password can be retried; terminal and stream failures cannot. */
export class PasswordValidationError extends OperatorCliError {
  constructor() {
    super("invalid-input");
  }
}

function invalid(): OperatorCliError {
  return new OperatorCliError("invalid-input");
}

/** Canonical regular JSON object file; aliases, symlinks, changes, bad UTF-8 and excess bytes fail. */
export function readJsonObject(path: string, maxBytes: number): JsonObject {
  try {
    if (realpathSync(path) !== path) throw invalid();
    const value: unknown = JSON.parse(utf8().decode(readBoundedBytes(path, maxBytes)));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
    return value as JsonObject;
  } catch {
    throw invalid();
  }
}

function erase(bytes: number[]): void {
  let byte: number;
  do byte = bytes.pop() ?? 0;
  while ((byte & 0xc0) === 0x80);
}

/**
 * A raw non-echoing TTY prompt without --password-stdin, or explicit non-TTY stdin with it.
 * Ctrl-C and signals cancel, EOF before a complete prompt line fails, and listeners are removed.
 */
export function readPassword(
  input: PasswordStream,
  fromStdin: boolean,
  prompt: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const tty = input.isTTY === true;
  if (tty === fromStdin) return Promise.reject(invalid());
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const bytes: number[] = [];
    const wasRaw = input.isRaw === true;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      try {
        input.pause();
        if (tty) {
          input.setRawMode(wasRaw);
          prompt("\n");
        }
        outcome();
      } catch {
        reject(invalid());
      }
    };
    const fail = (error: Error) => {
      settle(() => {
        reject(error);
      });
    };
    const finish = () => {
      settle(() => {
        try {
          const text = utf8().decode(Buffer.from(bytes));
          resolve(
            CredentialPasswordSchema.parse(!tty && text.endsWith("\n") ? text.slice(0, -1) : text),
          );
        } catch {
          reject(new PasswordValidationError());
        }
      });
    };
    const onAbort = () => {
      fail(signal.reason as Error);
    };
    const onError = () => {
      fail(invalid());
    };
    const onEnd = () => {
      if (tty) fail(invalid());
      else finish();
    };
    const accept = (byte: number): void => {
      if (tty && byte === 3) fail(new OperatorCliInterrupted(130));
      else if (tty && byte === 4) fail(invalid());
      else if (tty && (byte === 13 || byte === 10)) finish();
      else {
        if (tty && (byte === 8 || byte === 127)) erase(bytes);
        else bytes.push(byte);
        if (bytes.length > MAX_PASSWORD_BYTES + (tty ? 0 : 1)) fail(invalid());
      }
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (settled) break;
        accept(byte);
      }
    };
    signal.addEventListener("abort", onAbort);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    if (tty) {
      try {
        input.setRawMode(true);
        prompt("Password: ");
      } catch {
        fail(invalid());
      }
    }
  });
}
