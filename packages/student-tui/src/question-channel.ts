import type { QuestionsRequest } from "./parity/questions.js";

export type QuestionReply =
  { readonly type: "answers"; readonly values: readonly string[] } | { readonly type: "cancel" };

/** One pending question interrupt. Answers never resolve a different request. */
export function createQuestionChannel() {
  let pending: {
    request: QuestionsRequest;
    resolve: (reply: QuestionReply) => void;
  } | null = null;
  return {
    request(request: QuestionsRequest): Promise<QuestionReply> {
      if (pending !== null) return Promise.reject(new Error("Questions already pending."));
      const result = Promise.withResolvers<QuestionReply>();
      pending = { request, resolve: result.resolve };
      return result.promise;
    },
    answer(interruptId: string, values: readonly string[]): boolean {
      if (pending?.request.interruptId !== interruptId) return false;
      const questions = pending.request.questions;
      // Paired by position: values and questions advance together, so a
      // short, long or invalid batch fails without indexing either side.
      const remaining = values[Symbol.iterator]();
      for (const question of questions) {
        const next = remaining.next();
        if (next.done) return false;
        if (next.value.length > 8192 || (question.required && next.value.trim() === ""))
          return false;
      }
      if (remaining.next().done === false) return false;
      const { resolve } = pending;
      pending = null;
      resolve({ type: "answers", values: [...values] });
      return true;
    },
    cancel(): void {
      pending?.resolve({ type: "cancel" });
      pending = null;
    },
  };
}
