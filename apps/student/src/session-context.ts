import type { ConversationCopy } from "@marea/student-tui";
import * as z from "zod";

import type { ProjectGitContext } from "./project-git.boundary.js";

/**
 * Assembles the banner session context from values the session supplies.
 *
 * Every field is sanitized: control characters (including escapes) are
 * dropped so a hostile branch name or remote URL cannot inject terminal
 * sequences, overlong values are truncated so one row cannot break the
 * banner, and credentials embedded in a remote URL are redacted. A field
 * that ends up empty is omitted by the banner, exactly as the reference
 * shows a context row only when the session supplies it.
 */

type ParityContext = NonNullable<ConversationCopy["parity"]>["context"];

const MAX_SHORT_FIELD_LENGTH = 128;
const MAX_PATH_LENGTH = 512;
const MAX_URL_LENGTH = 256;

const CONTROL_CHARACTERS = /\p{Cc}/gu;

export function sanitizeContextField(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARACTERS, "").slice(0, maxLength);
}

/** Drops `user:password@` from a remote URL so secrets never reach the screen. */
export function redactRemoteUserinfo(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return url;
  const tail = url.slice(schemeEnd + 3);
  const at = tail.indexOf("@");
  // With no "@", at is -1: redacting from 0 is still the identity, so the
  // head check below already decides correctly and no extra branch is needed.
  if (tail.slice(0, at).includes("/")) return url;
  return `${url.slice(0, schemeEnd + 3)}${tail.slice(at + 1)}`;
}

const StartedSessionSchema = z.object({
  snapshot: z.object({ modelAlias: z.string() }).optional(),
});

/** The display-safe model alias from a started session, or empty when absent. */
export function sessionModelAlias(started: object | null): string {
  // safeParse already rejects null, so no separate branch is needed for it.
  const parsed = StartedSessionSchema.safeParse(started);
  if (!parsed.success) return "";
  const alias = parsed.data.snapshot?.modelAlias;
  if (alias === undefined) return "";
  return sanitizeContextField(alias, MAX_SHORT_FIELD_LENGTH);
}

export interface SessionContextInput {
  readonly cwd: string;
  readonly git: ProjectGitContext;
  readonly model: string;
}

export function createProjectContext(input: Omit<SessionContextInput, "model">) {
  return {
    branch: sanitizeContextField(input.git.branch, MAX_SHORT_FIELD_LENGTH),
    cwd: sanitizeContextField(input.cwd, MAX_PATH_LENGTH),
    repositoryUrl: redactRemoteUserinfo(
      sanitizeContextField(input.git.repositoryUrl, MAX_URL_LENGTH),
    ),
  };
}
export function createSessionContext(input: SessionContextInput): ParityContext {
  return {
    ...createProjectContext(input),
    model: sanitizeContextField(input.model, MAX_SHORT_FIELD_LENGTH),
  };
}
