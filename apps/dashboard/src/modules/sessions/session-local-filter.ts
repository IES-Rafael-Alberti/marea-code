import {
  MAX_SESSION_SEARCH_LENGTH,
  sessionSearchMatches,
  type ClassSessionItem,
} from "@marea/protocol";
import type { SessionFilters } from "./sessions-client.boundary.js";

/**
 * The same filters the server applies, over rows already loaded, so the list reacts at once
 * while the complete server answer is on its way. A row the browser cannot judge, such as one
 * without a review summary, is kept; the server answer settles it.
 */
export function sessionMatchesFilters(run: ClassSessionItem, filters: SessionFilters): boolean {
  const { review } = run;
  return (
    (filters.runState === undefined || run.state === filters.runState) &&
    (filters.search === undefined ||
      sessionSearchMatches(filters.search, run.studentDisplayName, run.projectDisplayName)) &&
    (review === undefined ||
      ((filters.evaluation === undefined || filters.evaluation.includes(review.evaluation)) &&
        (filters.evidence === undefined ||
          (filters.evidence === "with"
            ? review.evidenced > 0
            : review.criteria > 0 && review.evidenced === 0))))
  );
}

/** The filters as the server reads them: a search is trimmed, capped, and dropped when blank. */
export function normalizedFilters(filters: SessionFilters): SessionFilters {
  const search = filters.search?.trim().slice(0, MAX_SESSION_SEARCH_LENGTH);
  return { ...filters, search: search === "" ? undefined : search };
}
