import { fill, type QuestionCopy } from "./copy.js";

/**
 * The agent asking the student to decide.
 *
 * One question at a time, one input, and the answers kept while moving back
 * and forth. A number on a question with choices means that choice; anything
 * else is sent as written, so a student is never forced into the options.
 */

export interface Question {
  readonly choices: readonly string[];
  readonly required: boolean;
  readonly text: string;
}

export interface QuestionsRequest {
  readonly interruptId: string;
  readonly questions: readonly Question[];
}

type QuestionsDecision =
  { readonly type: "answers"; readonly values: readonly string[] } | { readonly type: "cancel" };

export interface QuestionsState {
  /** Only the questions the student has typed into appear here. */
  readonly answers: ReadonlyMap<number, string>;
  readonly decision: QuestionsDecision | null;
  readonly index: number;
  readonly request: QuestionsRequest;
  readonly requiredError: boolean;
  readonly resolved: boolean;
}

export function openQuestions(request: QuestionsRequest): QuestionsState {
  return {
    answers: new Map(),
    decision: null,
    index: 0,
    request,
    requiredError: false,
    resolved: false,
  };
}

const EMPTY_QUESTION: Question = Object.freeze({ choices: [], required: false, text: "" });

/** The answer held for a position, empty while it is unanswered. */
function answerAt(state: QuestionsState, index: number): string {
  return state.answers.get(index) ?? "";
}

function questionAt(state: QuestionsState, index: number): Question {
  return state.request.questions[index] ?? EMPTY_QUESTION;
}

export interface QuestionsView {
  /** What the input holds for the question on screen. */
  readonly answer: string;
  readonly choices: readonly string[];
  readonly error: string | null;
  readonly nextVisible: boolean;
  readonly outcome: string | null;
  readonly previousEnabled: boolean;
  readonly progress: string;
  readonly required: boolean;
  readonly sendVisible: boolean;
  readonly text: string;
  readonly title: string;
}

function outcomeLabel(state: QuestionsState, copy: QuestionCopy): string | null {
  if (state.decision === null) return null;
  return state.decision.type === "answers" ? copy.sent : copy.cancelled;
}

export function questionsView(state: QuestionsState, copy: QuestionCopy): QuestionsView {
  const total = state.request.questions.length;
  const question = questionAt(state, state.index);
  const last = state.index + 1 === total;
  return {
    answer: answerAt(state, state.index),
    choices: question.choices,
    error: state.requiredError ? copy.required : null,
    nextVisible: !state.resolved && !last,
    outcome: outcomeLabel(state, copy),
    previousEnabled: state.index > 0,
    progress: fill(copy.progress, { index: state.index + 1, total }),
    required: question.required,
    sendVisible: !state.resolved && last,
    text: question.text,
    title: copy.title,
  };
}

/**
 * The value actually sent for one answer: the chosen text when the student
 * typed a number that names a choice, and the raw answer otherwise.
 */
export function resolveAnswer(question: Question, answer: string): string {
  if (!/^\d+$/u.test(answer)) return answer;
  return question.choices[Number(answer) - 1] ?? answer;
}

export type QuestionsAction =
  | { readonly type: "type"; readonly value: string }
  | { readonly type: "previous" }
  | { readonly type: "next" }
  | { readonly type: "submit" }
  | { readonly type: "cancel" };

function withAnswer(state: QuestionsState, value: string): QuestionsState {
  // The input reports its value on every render; only a real edit is a change.
  if (answerAt(state, state.index) === value) return state;
  return { ...state, answers: new Map(state.answers).set(state.index, value) };
}

function blocked(state: QuestionsState): boolean {
  return questionAt(state, state.index).required && answerAt(state, state.index).trim() === "";
}

function submit(state: QuestionsState): QuestionsState {
  const values = state.request.questions.map((question, index) =>
    resolveAnswer(question, answerAt(state, index).trim()),
  );
  return { ...state, decision: { type: "answers", values }, requiredError: false, resolved: true };
}

function advance(state: QuestionsState): QuestionsState {
  if (blocked(state)) return { ...state, requiredError: true };
  const next = state.index + 1;
  return next < state.request.questions.length
    ? { ...state, index: next, requiredError: false }
    : { ...state, requiredError: false };
}

/**
 * Applies one action. A resolved panel ignores everything, so navigation left
 * on screen after an answer was sent cannot send a second one.
 */
export function questionsReducer(state: QuestionsState, action: QuestionsAction): QuestionsState {
  if (state.resolved) return state;
  switch (action.type) {
    case "type":
      return withAnswer(state, action.value);
    case "previous":
      return state.index === 0 ? state : { ...state, index: state.index - 1, requiredError: false };
    case "next":
      return advance(state);
    case "submit":
      return blocked(state) ? { ...state, requiredError: true } : submit(state);
    case "cancel":
      return { ...state, decision: { type: "cancel" }, requiredError: false, resolved: true };
  }
}

/** Enter in the input advances, or sends on the last question. */
export function enterAction(state: QuestionsState): QuestionsAction {
  return state.index + 1 < state.request.questions.length ? { type: "next" } : { type: "submit" };
}
