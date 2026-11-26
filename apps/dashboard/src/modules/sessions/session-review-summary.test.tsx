import { expect, it } from "vitest";
import { reviewFacts, SessionReviewSummary } from "./session-review-summary.js";
import { sessionsMessages } from "./sessions-messages.js";

const m = sessionsMessages("es");
const review = { evaluation: "draft", criteria: 3, evidenced: 0, applied: 0, raised: 0 } as const;

it("states the evaluation, its evidence and the progress an approval applied", () => {
  expect(reviewFacts({ ...review, evaluation: "none", criteria: 0 }, m)).toEqual([
    "Sin evaluación",
  ]);
  expect(reviewFacts(review, m)).toEqual(["Pendiente de revisar", "Sin evidencia"]);
  expect(reviewFacts({ ...review, evidenced: 2 }, m)).toEqual([
    "Pendiente de revisar",
    "2/3 con evidencia",
  ]);
  expect(reviewFacts({ ...review, evaluation: "approved", evidenced: 3 }, m)).toEqual([
    "Aprobada",
    "3/3 con evidencia",
    "Progreso sin cambios",
  ]);
  expect(reviewFacts({ ...review, evaluation: "approved", evidenced: 3, applied: 3 }, m)).toEqual([
    "Aprobada",
    "3/3 con evidencia",
    "Progreso aplicado 3/3",
  ]);
  expect(
    reviewFacts({ ...review, evaluation: "approved", evidenced: 3, applied: 3, raised: 2 }, m),
  ).toEqual(["Aprobada", "3/3 con evidencia", "Progreso aplicado 3/3 · Niveles subidos: 2"]);
});

it("renders the facts on one line styled by evaluation state", () => {
  const node = SessionReviewSummary({ review: { ...review, evidenced: 1 }, messages: m });
  expect(node.props).toEqual({
    className: "session-review session-review-draft",
    children: "Pendiente de revisar · 1/3 con evidencia",
  });
});
