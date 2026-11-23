import { Transform, type Readable } from "node:stream";

interface TerminalInput extends Readable {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
}

// eslint-disable-next-line no-control-regex -- Mouse reports begin with a literal terminal escape.
const MOUSE_REPORT = /\u001b\[(?:<\d+;\d+;\d+[Mm]|M[\u0020-\u00ff]{3})/gu;
// eslint-disable-next-line no-control-regex -- Preserve incomplete terminal escapes across input chunks.
const MOUSE_PREFIX = /\u001b(?:\[(?:<\d*(?:;\d*(?:;\d*)?)?|M[\u0020-\u00ff]{0,2})?)?$/u;

/** Drop mouse reports already in transit when the TUI relinquishes the terminal. */
export async function withAuthenticationInput<T>(
  prompt: (context: { readonly input: NodeJS.ReadableStream }) => Promise<T>,
  source: TerminalInput = process.stdin,
): Promise<T> {
  let pending = "";
  const filtered = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      // Latin-1 preserves the original UTF-8 bytes while matching ASCII terminal reports.
      const text = (pending + chunk.toString("latin1")).replace(MOUSE_REPORT, "");
      const prefix = text.search(MOUSE_PREFIX);
      const boundary = prefix === -1 ? text.length : prefix;
      pending = text.slice(boundary);
      done(null, Buffer.from(text.slice(0, boundary), "latin1"));
    },
  });
  Object.assign(filtered, {
    isTTY: source.isTTY,
    setRawMode(enabled: boolean): void {
      source.setRawMode?.(enabled);
    },
  });
  source.pipe(filtered);
  try {
    return await prompt({ input: filtered });
  } finally {
    source.unpipe(filtered);
    filtered.destroy();
  }
}
