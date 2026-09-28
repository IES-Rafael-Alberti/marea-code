import {
  SkillAuthoringDraftSchema,
  Sha256DigestSchema,
  SkillIdSchema,
  type SkillAuthoringDraft,
  type SkillAuthoringReadResponse,
} from "@marea/protocol";

import type {
  SkillAuthoringClientFailure,
  SkillAuthoringProblem,
  SkillAuthoringState,
} from "./skill-authoring-contracts.js";

type ImmutableValue = object | string | number | boolean | null;

export function validSkillSlug(slug: string): boolean {
  return slug.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);
}

export function editableDraftContext(
  state: SkillAuthoringState,
  disposed: boolean,
  busy: boolean,
): { classId: string; draft: SkillAuthoringDraft } | null {
  if (
    disposed ||
    busy ||
    !state.editable ||
    state.draft === null ||
    state.classId === null ||
    state.pendingTarget !== null ||
    state.recovery !== null
  ) {
    return null;
  }
  return { classId: state.classId, draft: state.draft };
}

export function writeBlocked(state: SkillAuthoringState): boolean {
  return state.problem === "conflict" || state.problem === "uncertain";
}

export function copyContext(
  state: SkillAuthoringState,
  disposed: boolean,
  busy: boolean,
  sourceSkillId: string,
  sourceDigest: string,
  slug: string,
): { classId: string } | null {
  if (
    disposed ||
    busy ||
    !SkillIdSchema.safeParse(sourceSkillId).success ||
    !Sha256DigestSchema.safeParse(sourceDigest).success ||
    !validSkillSlug(slug) ||
    state.classId === null ||
    state.pendingTarget !== null ||
    state.recovery !== null ||
    writeBlocked(state)
  ) {
    return null;
  }
  return { classId: state.classId };
}

export function newSkillDraft(slug: string): SkillAuthoringDraft {
  return freezeDraft({
    kind: "didactic",
    slug,
    files: [{ path: "SKILL.md", content: "" }],
  });
}

export function draftFromBundle(
  bundle: NonNullable<SkillAuthoringReadResponse["skill"]>,
): SkillAuthoringDraft {
  return freezeDraft(
    SkillAuthoringDraftSchema.parse({
      kind: bundle.kind,
      slug: bundle.name,
      files: bundle.files.map(({ path, content }) => ({ path, content })),
    }),
  );
}

export function cloneDraft(draft: SkillAuthoringDraft): SkillAuthoringDraft {
  return freezeDraft({
    kind: draft.kind,
    slug: draft.slug,
    files: draft.files.map((file) => ({ path: file.path, content: file.content })),
  });
}

function freezeDraft(draft: SkillAuthoringDraft): SkillAuthoringDraft {
  return immutableState({
    kind: draft.kind,
    slug: draft.slug,
    files: draft.files.map((file) => ({ path: file.path, content: file.content })),
  });
}

export function sameDraft(a: SkillAuthoringDraft, b: SkillAuthoringDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function compareBinary(a: string, b: string): number {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.min(left.byteLength, right.byteLength);
  const leftView = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const rightView = new DataView(right.buffer, right.byteOffset, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftView.getUint8(index) - rightView.getUint8(index);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export function problemOf(
  error: Error,
  kind: "load" | "validate" | "write" | undefined,
): SkillAuthoringProblem {
  const code = (error as Partial<SkillAuthoringClientFailure>).code;
  return isSkillAuthoringProblem(code) ? code : fallbackProblem(kind);
}

function fallbackProblem(kind: "load" | "validate" | "write" | undefined): SkillAuthoringProblem {
  if (kind === "write") return "uncertain";
  if (kind === "validate") return "invalid";
  return "load";
}

function isSkillAuthoringProblem(value: unknown): value is SkillAuthoringProblem {
  return new Set([
    "load",
    "invalid",
    "forbidden",
    "conflict",
    "uncertain",
    "skill-unavailable",
  ]).has(value as string);
}

export function isAbortError(error: Error): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function immutableState<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: ImmutableValue) => immutableState(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, ImmutableValue> = {};
    const entries = Object.entries(value) as [string, ImmutableValue][];
    for (const [key, item] of entries) result[key] = immutableState(item);
    return Object.freeze(result) as T;
  }
  return value;
}

export function initialSkillAuthoringState(): SkillAuthoringState {
  return immutableState({
    busy: false,
    classes: [],
    classesLoaded: false,
    classId: null,
    catalog: [],
    catalogLoaded: false,
    selectedSkillId: null,
    personalSlug: null,
    loadedBundle: null,
    editable: false,
    draft: null,
    dirty: false,
    validation: null,
    problem: null,
    recovery: null,
    pendingTarget: null,
  });
}
