import type { TeachingCatalogEntry, TeachingSettings } from "@marea/protocol";

type TeachingSelectionStatus = "current" | "stale" | "missing";

export interface ReviewedTeachingSelection {
  readonly id: string;
  readonly digest: string;
  readonly status: TeachingSelectionStatus;
  readonly entry: TeachingCatalogEntry | null;
}

export interface ReviewedTeachingSelections {
  readonly didactic: readonly ReviewedTeachingSelection[];
  readonly evaluation: readonly ReviewedTeachingSelection[];
  readonly available: {
    readonly didactic: readonly TeachingCatalogEntry[];
    readonly evaluation: readonly TeachingCatalogEntry[];
  };
}

function review(
  revisions: readonly { readonly id: string; readonly digest: string }[],
  catalog: readonly TeachingCatalogEntry[],
): ReviewedTeachingSelection[] {
  return revisions.map((revision) => {
    const entry = catalog.find((candidate) => candidate.id === revision.id) ?? null;
    return {
      id: revision.id,
      digest: revision.digest,
      status: entry === null ? "missing" : entry.digest === revision.digest ? "current" : "stale",
      entry,
    };
  });
}

/** Compares draft selections against today's catalog without ever mutating digests. */
export function reviewTeachingSelections(
  settings: TeachingSettings,
  catalog: readonly TeachingCatalogEntry[],
): ReviewedTeachingSelections {
  return {
    didactic: review(settings.selection.didactic, catalog),
    evaluation: review(settings.selection.evaluation, catalog),
    available: {
      didactic: catalog.filter((entry) => entry.kind === "didactic"),
      evaluation: catalog.filter((entry) => entry.kind === "evaluation"),
    },
  };
}

function withSelection(
  settings: TeachingSettings,
  kind: "didactic" | "evaluation",
  next: readonly { readonly id: string; readonly digest: string }[],
): TeachingSettings {
  const evaluation = kind === "evaluation" ? next : settings.selection.evaluation;
  return {
    ...settings,
    selection: { ...settings.selection, [kind]: next },
    automaticEvaluation: evaluation.length !== 1 ? false : settings.automaticEvaluation,
  };
}

export function withToggledRevision(
  settings: TeachingSettings,
  kind: "didactic" | "evaluation",
  revision: { readonly id: string; readonly digest: string },
): TeachingSettings {
  const current = settings.selection[kind];
  const next = current.some((item) => item.id === revision.id && item.digest === revision.digest)
    ? current.filter((item) => item.id !== revision.id)
    : [...current.filter((item) => item.id !== revision.id), revision];
  return withSelection(settings, kind, next);
}

export function withoutRevision(
  settings: TeachingSettings,
  kind: "didactic" | "evaluation",
  id: string,
): TeachingSettings {
  const next = settings.selection[kind].filter((item) => item.id !== id);
  return withSelection(settings, kind, next);
}
