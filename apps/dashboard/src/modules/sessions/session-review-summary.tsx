import type { SessionReview } from "@marea/protocol";
import type { SessionsMessages } from "./sessions-messages.js";

/** Short review facts for a session row: evaluation state, evidence and applied progress. */
export function reviewFacts(review: SessionReview, m: SessionsMessages): readonly string[] {
  const facts = [m.evaluationState[review.evaluation]];
  if (review.criteria > 0)
    facts.push(
      review.evidenced === 0
        ? m.noEvidence
        : `${String(review.evidenced)}/${String(review.criteria)} ${m.withEvidence}`,
    );
  if (review.evaluation === "approved")
    facts.push(
      review.applied === 0
        ? m.progressUnchanged
        : `${m.progressApplied} ${String(review.applied)}/${String(review.criteria)}` +
            (review.raised === 0 ? "" : ` · ${m.levelRaised}: ${String(review.raised)}`),
    );
  return facts;
}

export function SessionReviewSummary({
  review,
  messages,
}: {
  readonly review: SessionReview;
  readonly messages: SessionsMessages;
}) {
  return (
    <small className={`session-review session-review-${review.evaluation}`}>
      {reviewFacts(review, messages).join(" · ")}
    </small>
  );
}
