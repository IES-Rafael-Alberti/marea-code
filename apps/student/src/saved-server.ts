import * as z from "zod";

/** Beside settings.json in the student's state root; it holds an address, never a credential. */
export const SAVED_SERVER_FILE = "server.json";
const SAVED_SERVER_VERSION = 1;

export function serializeSavedServer(url: string): string {
  return JSON.stringify({ version: SAVED_SERVER_VERSION, server: url });
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, username, password } = new URL(value);
  return (protocol === "http:" || protocol === "https:") && username === "" && password === "";
}

const SavedServerSchema = z.object({
  version: z.literal(SAVED_SERVER_VERSION),
  server: z.string(),
});

/** The saved server address, or undefined when the content is not a valid saved server. */
export function parseSavedServer(text: string): string | undefined {
  let parsed: ReturnType<typeof SavedServerSchema.safeParse>;
  try {
    parsed = SavedServerSchema.safeParse(JSON.parse(text));
    // Stryker disable next-line BlockStatement: an undefined result also fails the check below.
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  const server = parsed.data.server.trim();
  return isHttpUrl(server) ? server : undefined;
}
