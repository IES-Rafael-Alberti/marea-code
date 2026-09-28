import { describe, expect, it } from "vitest";

import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";
import {
  enterAction,
  openQuestions,
  questionsReducer,
  questionsView,
  resolveAnswer,
  type Question,
  type QuestionsAction,
  type QuestionsRequest,
  type QuestionsState,
} from "./questions.js";

const copy = PARITY_TEST_COPY.question;

const CHOICE_QUESTION: Question = {
  choices: ["0", "None", "Un error"],
  required: true,
  text: "¿Qué debe devolver?",
};
const FREE_QUESTION: Question = { choices: [], required: false, text: "¿Por qué?" };

const REQUEST: QuestionsRequest = {
  interruptId: "i2",
  questions: [CHOICE_QUESTION, FREE_QUESTION],
};

function apply(state: QuestionsState, ...actions: readonly QuestionsAction[]): QuestionsState {
  return actions.reduce(questionsReducer, state);
}

describe("questions view", () => {
  it("opens on the first question, with its choices and no way back", () => {
    expect(questionsView(openQuestions(REQUEST), copy)).toEqual({
      answer: "",
      choices: ["0", "None", "Un error"],
      error: null,
      nextVisible: true,
      outcome: null,
      previousEnabled: false,
      progress: "Pregunta 1 de 2",
      required: true,
      sendVisible: false,
      text: "¿Qué debe devolver?",
      title: "El agente necesita que decidas",
    });
  });

  it("offers sending, not advancing, on the last question", () => {
    const state = apply(openQuestions(REQUEST), { type: "type", value: "1" }, { type: "next" });
    expect(questionsView(state, copy)).toMatchObject({
      choices: [],
      nextVisible: false,
      previousEnabled: true,
      progress: "Pregunta 2 de 2",
      required: false,
      sendVisible: true,
    });
  });

  it("opens with no answers recorded", () => {
    expect(openQuestions(REQUEST).answers.size).toBe(0);
  });

  it("shows nothing rather than failing on a request with no questions", () => {
    const empty = openQuestions({ interruptId: "i3", questions: [] });
    expect(questionsView(empty, copy)).toMatchObject({
      answer: "",
      choices: [],
      required: false,
      text: "",
    });
    expect(questionsReducer(empty, { type: "submit" }).decision).toEqual({
      type: "answers",
      values: [],
    });
  });
});

describe("required answers", () => {
  it("refuses to advance past a blank required question", () => {
    const state = questionsReducer(openQuestions(REQUEST), { type: "next" });
    expect(state.index).toBe(0);
    expect(questionsView(state, copy).error).toBe("Esta pregunta es obligatoria.");
  });

  it("refuses to send a blank required question", () => {
    const state = questionsReducer(openQuestions(REQUEST), { type: "submit" });
    expect(state.decision).toBeNull();
    expect(state.requiredError).toBe(true);
  });

  it("treats whitespace as blank", () => {
    const state = apply(openQuestions(REQUEST), { type: "type", value: "   " }, { type: "next" });
    expect(state.requiredError).toBe(true);
  });

  it("clears the message once the question is answered", () => {
    const state = apply(
      openQuestions(REQUEST),
      { type: "next" },
      { type: "type", value: "1" },
      { type: "next" },
    );
    expect(state.index).toBe(1);
    expect(state.requiredError).toBe(false);
    expect(questionsView(state, copy).error).toBeNull();
  });

  it("clears the message when the student goes back, sends or cancels", () => {
    const shown = apply(
      openQuestions(REQUEST),
      { type: "type", value: "1" },
      { type: "next" },
      { type: "previous" },
      { type: "type", value: "" },
      { type: "next" },
    );
    expect(shown.requiredError).toBe(true);
    const moved = apply(shown, { type: "type", value: "1" }, { type: "next" });
    expect(moved).toMatchObject({ index: 1, requiredError: false });
    expect(questionsReducer(moved, { type: "previous" })).toMatchObject({
      index: 0,
      requiredError: false,
    });
    expect(questionsReducer(shown, { type: "cancel" })).toMatchObject({
      requiredError: false,
      resolved: true,
    });
    const answered = questionsReducer(shown, { type: "type", value: "1" });
    expect(questionsReducer(answered, { type: "submit" }).requiredError).toBe(false);
  });

  it("lets a blank optional answer through", () => {
    const state = apply(
      openQuestions(REQUEST),
      { type: "type", value: "1" },
      { type: "next" },
      { type: "submit" },
    );
    expect(state.decision).toEqual({ type: "answers", values: ["0", ""] });
  });
});

describe("navigation", () => {
  it("keeps the answers when moving back and forward", () => {
    const state = apply(
      openQuestions(REQUEST),
      { type: "type", value: "2" },
      { type: "next" },
      { type: "type", value: "porque sí" },
      { type: "previous" },
    );
    expect(questionsView(state, copy).answer).toBe("2");
    const forward = questionsReducer(state, { type: "next" });
    expect(questionsView(forward, copy).answer).toBe("porque sí");
  });

  it("treats typing the same answer again as no change", () => {
    const state = openQuestions(REQUEST);
    expect(questionsReducer(state, { type: "type", value: "" })).toBe(state);
  });

  it("stays put on the first question", () => {
    const state = openQuestions(REQUEST);
    expect(questionsReducer(state, { type: "previous" })).toBe(state);
  });

  it("stays on the last question when asked to advance", () => {
    const state = apply(openQuestions(REQUEST), { type: "type", value: "1" }, { type: "next" });
    const again = questionsReducer(state, { type: "next" });
    expect(again.index).toBe(1);
    expect(again.decision).toBeNull();
    expect(again.requiredError).toBe(false);
  });

  it("advances with Enter, and sends with it on the last question", () => {
    const first = openQuestions(REQUEST);
    expect(enterAction(first)).toEqual({ type: "next" });
    const second = apply(first, { type: "type", value: "1" }, { type: "next" });
    expect(enterAction(second)).toEqual({ type: "submit" });
  });
});

describe("answers", () => {
  it("turns a choice number into the choice", () => {
    expect(resolveAnswer(CHOICE_QUESTION, "2")).toBe("None");
  });

  it("sends a number outside the choices as written", () => {
    expect(resolveAnswer(CHOICE_QUESTION, "0")).toBe("0");
    expect(resolveAnswer(CHOICE_QUESTION, "4")).toBe("4");
  });

  it("reads a two-digit choice number", () => {
    const many: Question = {
      choices: Array.from({ length: 12 }, (_choice, index) => `opción ${String(index + 1)}`),
      required: true,
      text: "¿cuál?",
    };
    expect(resolveAnswer(many, "10")).toBe("opción 10");
    expect(resolveAnswer(many, "12")).toBe("opción 12");
  });

  it("only reads an answer that is nothing but digits", () => {
    expect(resolveAnswer(CHOICE_QUESTION, " 1")).toBe(" 1");
    expect(resolveAnswer(CHOICE_QUESTION, "1 ")).toBe("1 ");
    expect(resolveAnswer(CHOICE_QUESTION, "+1")).toBe("+1");
    expect(resolveAnswer(CHOICE_QUESTION, "1a")).toBe("1a");
  });

  it("sends free text as written, numbers included when there are no choices", () => {
    expect(resolveAnswer(CHOICE_QUESTION, "otra cosa")).toBe("otra cosa");
    expect(resolveAnswer(FREE_QUESTION, "2")).toBe("2");
    expect(resolveAnswer(CHOICE_QUESTION, "1.5")).toBe("1.5");
  });

  it("sends every answer in order and reports the panel as resolved", () => {
    const state = apply(
      openQuestions(REQUEST),
      { type: "type", value: "3" },
      { type: "next" },
      { type: "type", value: " me lo dijo el profe " },
      { type: "submit" },
    );
    expect(state.decision).toEqual({
      type: "answers",
      values: ["Un error", "me lo dijo el profe"],
    });
    expect(questionsView(state, copy)).toMatchObject({
      nextVisible: false,
      outcome: "Respuestas enviadas",
      sendVisible: false,
    });
  });

  it("cancels", () => {
    const state = questionsReducer(openQuestions(REQUEST), { type: "cancel" });
    expect(state).toMatchObject({ requiredError: false, resolved: true });
    expect(state.decision).toEqual({ type: "cancel" });
    expect(questionsView(state, copy).outcome).toBe("Cancelado");
  });

  it("ignores everything once it is resolved", () => {
    const sent = apply(
      openQuestions(REQUEST),
      { type: "type", value: "1" },
      { type: "next" },
      { type: "submit" },
    );
    for (const action of [
      { type: "type", value: "x" },
      { type: "previous" },
      { type: "next" },
      { type: "submit" },
      { type: "cancel" },
    ] satisfies QuestionsAction[]) {
      expect(questionsReducer(sent, action)).toBe(sent);
    }
  });
});
