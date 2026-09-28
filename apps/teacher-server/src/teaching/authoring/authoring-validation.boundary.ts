import {
  isSkillFilePath,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  Sha256DigestSchema,
  SkillIdSchema,
  type Sha256Digest,
} from "@marea/protocol";
import * as z from "zod";

import { SkillAuthoringError } from "./errors.js";
import { isValidSkillName, type SkillBundle, type SkillKind } from "../skills/skill-source.js";

export interface SkillAuthoringFile {
  readonly path: string;
  readonly content: string;
}

export interface SkillOwnerIdentity {
  readonly source: "teacher" | "center";
  readonly id: string;
}

export interface SkillSaveRequest {
  readonly kind: SkillKind;
  readonly slug: string;
  readonly files: readonly SkillAuthoringFile[];
  readonly expectedDigest: Sha256Digest | null;
}

export interface SkillSaveRequestSnapshot {
  readonly kind: SkillKind;
  readonly slug: string;
  readonly files: readonly SkillAuthoringFile[];
  readonly expectedDigest: Sha256Digest | null;
}

const UTF8_BYTES = new TextEncoder();
const UTF8 = new TextDecoder();
const MAXIMUM_FILES = 256;
const SKILL_KINDS: readonly SkillKind[] = ["didactic", "evaluation"];
const SkillKindSchema = z.enum(["didactic", "evaluation"]);
const SkillSlugSchema = z.string().refine(isValidSkillName);

export function isSkillKindName(value: string): value is SkillKind {
  return (SKILL_KINDS as readonly string[]).includes(value);
}

export function validateKind(value: unknown): SkillKind {
  return SkillKindSchema.parse(value);
}

export function validateSlug(value: string): string {
  return SkillSlugSchema.parse(value);
}

export function validateSaveRequest(request: unknown): SkillSaveRequestSnapshot {
  if (request === null || typeof request !== "object") {
    throw new SkillAuthoringError(
      "UNSAFE_AUTHORING_INPUT",
      "skill-request",
      "Provide a skill save request object.",
    );
  }
  const candidate = request as Partial<SkillSaveRequest>;
  if (typeof candidate.slug !== "string") {
    throw new SkillAuthoringError(
      "UNSAFE_AUTHORING_INPUT",
      "skill-request",
      "Provide a string skill slug.",
    );
  }
  const kind = validateKind(candidate.kind);
  const slug = SkillSlugSchema.parse(decodeText(candidate.slug, "skill-request"));
  const files = validateAuthoringFiles(kind, slug, candidate.files);
  const rawDigest = candidate.expectedDigest;
  const digestText =
    typeof rawDigest === "string" ? decodeText(rawDigest, "skill-request") : rawDigest;
  const expectedDigest = rawDigest === null ? null : Sha256DigestSchema.parse(digestText);
  return Object.freeze({ kind, slug, files: Object.freeze(files), expectedDigest });
}

export function validateAuthoringFiles(
  kind: SkillKind,
  slug: string,
  files: unknown,
): readonly SkillAuthoringFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAXIMUM_FILES) {
    throw new SkillAuthoringError(
      "AUTHORING_LIMIT",
      `${kind}/${slug}`,
      `Provide between 1 and ${String(MAXIMUM_FILES)} complete skill files.`,
    );
  }
  const paths = new Set<string>();
  let bundleBytes = 0;
  const canonical: SkillAuthoringFile[] = [];
  for (const file of files) {
    if (file === null) {
      throw unsafeFileInput(kind, slug);
    }
    const entry = file as { path?: unknown; content?: unknown };
    if (typeof entry.path !== "string" || typeof entry.content !== "string") {
      throw unsafeFileInput(kind, slug);
    }
    const path = decodeText(entry.path, `${kind}/${slug}`);
    const content = decodeText(entry.content, `${kind}/${slug}`);
    if (paths.has(path) || !isSkillFilePath(path) || content.includes("\0")) {
      throw new SkillAuthoringError(
        "UNSAFE_AUTHORING_INPUT",
        `${kind}/${slug}/${path}`,
        "Use each contained text-file path exactly once without duplicate or unsafe values.",
      );
    }
    paths.add(path);
    const sizeBytes = UTF8_BYTES.encode(content).byteLength;
    if (sizeBytes > MAX_SKILL_FILE_BYTES) {
      throw new SkillAuthoringError(
        "AUTHORING_LIMIT",
        `${kind}/${slug}/${path}`,
        `Reduce the file below ${String(MAX_SKILL_FILE_BYTES)} bytes.`,
      );
    }
    bundleBytes += sizeBytes;
    if (bundleBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillAuthoringError(
        "AUTHORING_LIMIT",
        `${kind}/${slug}`,
        `Reduce the complete bundle below ${String(MAX_SKILL_BUNDLE_BYTES)} bytes.`,
      );
    }
    canonical.push({ path, content });
  }
  return canonical;
}

export function assertCrossKindSlugAvailable(
  kind: SkillKind,
  slug: string,
  other: SkillKind,
  hasOtherKind: boolean,
): void {
  if (hasOtherKind) {
    throw new SkillAuthoringError(
      "SKILL_EXISTS",
      `${kind}/${slug}`,
      `The '${other}' kind already uses slug '${slug}'.`,
    );
  }
}

export function decodeText(value: string, location: string): string {
  const encoded = UTF8_BYTES.encode(value);
  const decoded = UTF8.decode(encoded);
  if (decoded !== value) {
    throw new SkillAuthoringError(
      "UNSAFE_AUTHORING_INPUT",
      location,
      "Provide well-formed UTF-8 text without orphan surrogates.",
    );
  }
  return value;
}

export function validateOwnerIdentity(owner: unknown): SkillOwnerIdentity {
  if (owner === null || typeof owner !== "object") {
    throw new SkillAuthoringError(
      "UNSAFE_AUTHORING_INPUT",
      "owner-identity",
      "Provide an explicit teacher or center owner identity.",
    );
  }
  const candidate = owner as { source?: unknown; id?: unknown };
  if (typeof candidate.source !== "string" || typeof candidate.id !== "string") {
    throw new SkillAuthoringError(
      "UNSAFE_AUTHORING_INPUT",
      "owner-identity",
      "Provide string owner source and id values.",
    );
  }
  const source = decodeText(candidate.source, "owner-identity");
  const id = decodeText(candidate.id, "owner-identity");
  SkillIdSchema.parse(`${source}/${id}/identity-probe`);
  return Object.freeze({ source, id }) as SkillOwnerIdentity;
}

export function withOwnerProvenance(bundle: SkillBundle, owner: SkillOwnerIdentity): SkillBundle {
  return Object.freeze({
    ...bundle,
    id: SkillIdSchema.parse(`${owner.source}/${owner.id}/${bundle.name}`),
    source: owner.source,
  });
}

function unsafeFileInput(kind: SkillKind, slug: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "UNSAFE_AUTHORING_INPUT",
    `${kind}/${slug}`,
    "Provide path and text content for every skill file.",
  );
}
