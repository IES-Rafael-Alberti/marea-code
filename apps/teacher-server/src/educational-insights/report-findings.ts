import * as z from "zod";
import { ReportSynthesisSchema, type ReportSynthesis } from "@marea/protocol";
import { PROMPT_RESERVE_BYTES, type Evidence } from "./reports-model.js";

type Finding = ReportSynthesis["findings"][number];

const text = (max: number) => z.string().transform((value) => value.trim().slice(0, max));
const list = (max: number, itemMax: number) =>
  z.array(z.string()).transform((items) =>
    items
      .map((item) => item.slice(0, itemMax))
      .filter((item) => item.length > 0)
      .slice(0, max),
  );

/** Unknown keys are stripped and long text or lists are clamped; only unusable findings drop. */
const LenientFindingSchema = z.object({
  title: text(200).refine((value) => value.length > 0),
  mode: z.enum(["tutoring", "free"]),
  skillIds: list(64, 256),
  evaluable: list(1000, 256),
  affected: list(1000, 256),
  evidence: list(1000, 256),
  explanation: text(4000).default(""),
  recommendation: text(2000).default(""),
});

/** Model-facing synthesis contract: tolerant of extra keys, long text and malformed findings. */
export const ModelSynthesisSchema = z
  .object({
    summary: text(4000).default(""),
    findings: z.array(z.unknown()).default([]),
    recommendation: text(3000).default(""),
  })
  .transform((value) => {
    const parsed = value.findings.map((item) => LenientFindingSchema.safeParse(item));
    const kept = parsed.flatMap((item) => (item.success ? [item.data] : [])).slice(0, 100);
    return {
      synthesis: ReportSynthesisSchema.parse({
        summary: value.summary,
        findings: kept,
        recommendation: value.recommendation,
      }),
      dropped: value.findings.length - kept.length,
    };
  });

const unique = (values: readonly string[]) => [...new Set(values)];

/**
 * Repairs a finding against the evidence it may cite: unknown or duplicated references are
 * removed. A finding left without any evidence is dropped.
 */
function reconcile(finding: Finding, evidence: readonly Evidence[]): Finding | undefined {
  const eligible = evidence.filter(
    (e) => e.mode === finding.mode && finding.skillIds.every((s) => e.skills.includes(s)),
  );
  const aliases = new Set(eligible.map((e) => e.alias));
  const ids = new Set(eligible.map((e) => e.runId));
  const cited = unique(finding.evidence).filter((id) => ids.has(id));
  if (cited.length === 0) return undefined;
  const evaluable = unique(finding.evaluable).filter((alias) => aliases.has(alias));
  const affected = unique(finding.affected).filter(
    (alias) =>
      evaluable.includes(alias) &&
      eligible.some((e) => e.alias === alias && cited.includes(e.runId)),
  );
  return { ...finding, evaluable, affected, evidence: cited };
}

const unchanged = (a: Finding, b: Finding) =>
  a.evaluable.length === b.evaluable.length &&
  a.affected.length === b.affected.length &&
  a.evidence.length === b.evidence.length;

/** Invalid references are repaired or dropped rather than failing; `adjusted` counts changes. */
export function validateFindings(
  synthesis: ReportSynthesis,
  evidence: readonly Evidence[],
): { readonly synthesis: ReportSynthesis; readonly adjusted: number } {
  let adjusted = 0;
  const findings = synthesis.findings.flatMap((finding) => {
    const repaired = reconcile(finding, evidence);
    if (repaired === undefined || !unchanged(finding, repaired)) adjusted++;
    return repaired === undefined ? [] : [repaired];
  });
  return { synthesis: { ...synthesis, findings }, adjusted };
}

/** One student counts once per mode and assessed skill, regardless of session count. */
export function computedDenominators(
  synthesis: ReportSynthesis,
  evidence: readonly Evidence[],
): { readonly synthesis: ReportSynthesis; readonly adjusted: number } {
  let adjusted = 0;
  const findings = synthesis.findings.map((finding) => {
    const evaluable = unique(
      evidence
        .filter(
          (e) =>
            e.mode === finding.mode &&
            e.status !== "unavailable" &&
            finding.skillIds.every((skill) =>
              e.evaluation?.criteria.some((c) => c.skillId === skill && c.result !== "no-evidence"),
            ),
        )
        .map((e) => e.alias),
    );
    const affected = finding.affected.filter((alias) => evaluable.includes(alias));
    if (affected.length !== finding.affected.length) adjusted++;
    return { ...finding, evaluable, affected };
  });
  return { synthesis: { ...synthesis, findings }, adjusted };
}

type Result = "passed" | "not-passed" | "no-evidence";
const RANK: Record<Result, number> = { "no-evidence": 0, passed: 1, "not-passed": 2 };
const DETAIL_LEVELS = [
  { difficulties: 3, note: 200 },
  { difficulties: 1, note: 100 },
] as const;
const MINIMAL_DETAIL = { difficulties: 0, note: 0 } as const;

/** The worst result per skill: any not-passed outranks passed, which outranks no evidence. */
function skillResults(evidence: Evidence): Record<string, Result> {
  const results: Record<string, Result> = {};
  // Stryker disable next-line ArrayDeclaration: iterating a string yields no skill results.
  for (const c of evidence.evaluation?.criteria ?? [])
    if (RANK[c.result] >= RANK[results[c.skillId] ?? "no-evidence"]) results[c.skillId] = c.result;
  return results;
}

function compactOne(
  evidence: Evidence,
  detail: (typeof DETAIL_LEVELS)[number] | typeof MINIMAL_DETAIL,
) {
  const note = evidence.evaluation?.teacherNote.split("\n", 1).at(0) ?? "";
  return {
    runId: evidence.runId,
    alias: evidence.alias,
    mode: evidence.mode,
    skills: evidence.skills,
    status: evidence.status,
    results: skillResults(evidence),
    ...(detail.note === 0 ? {} : { note: note.slice(0, detail.note) }),
    ...(detail.difficulties === 0
      ? {}
      : {
          difficulties: (evidence.evaluation?.difficulties ?? [])
            .slice(0, detail.difficulties)
            .map((d) => d.slice(0, 120)),
        }),
  };
}

/**
 * One short dossier per evaluation so that a whole class fits the input ceiling. Detail is
 * reduced step by step until the payload fits; the model never sees feedback for students.
 */
export function compactEvidence(
  evidence: readonly Evidence[],
  ceiling: number | null,
): ReturnType<typeof compactOne>[] {
  for (const detail of DETAIL_LEVELS) {
    const dossiers = evidence.map((e) => compactOne(e, detail));
    if (
      ceiling === null ||
      Buffer.byteLength(JSON.stringify(dossiers)) <= ceiling - PROMPT_RESERVE_BYTES
    )
      return dossiers;
  }
  return evidence.map((e) => compactOne(e, MINIMAL_DETAIL));
}
