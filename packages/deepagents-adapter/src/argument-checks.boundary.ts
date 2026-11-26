import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type WhenPredicate } from "langchain";
import * as z from "zod";

import type { ApprovalTool } from "./contracts.js";
import { QUESTION_TOOL_NAME, questionsProblem } from "./questions.boundary.js";
import type { createSocraticGate } from "./socratic-gate.boundary.js";
import { toPublicToolName } from "./tool-names.js";

type ArgumentCheck = (arguments_: Readonly<Record<string, string>>) => string | null;

const TextArguments = z.record(z.string(), z.string());

/**
 * A call whose arguments cannot be applied is answered as a tool error, before any approval is
 * requested, so the model corrects it. Nothing is stored for the student to decide, and no
 * pending approval is left behind to be replayed on every retry.
 */
function createArgumentChecks(checks: ReadonlyMap<string, ArgumentCheck>) {
  const problem = (toolCall: { readonly name: string; readonly args: unknown }): string | null => {
    const check = checks.get(toolCall.name);
    if (check === undefined) return null;
    const text = TextArguments.safeParse(toolCall.args);
    return text.success ? check(text.data) : "Every argument must be text.";
  };
  const invalid = ({ toolCall }: Parameters<WhenPredicate>[0]): boolean =>
    problem(toolCall) !== null;
  return {
    invalid,
    middleware: createMiddleware({
      name: "MareaArgumentChecks",
      wrapToolCall: (request, handler) => {
        const message = problem(request.toolCall);
        if (message === null) return handler(request);
        return new ToolMessage({
          // LangGraph assigns an ID before entering tool middleware.
          tool_call_id: z.string().parse(request.toolCall.id),
          name: request.toolCall.name,
          status: "error",
          content: `Error: ${toPublicToolName(request.toolCall.name)} was not run. ${message}`,
        });
      },
    }),
  };
}

/**
 * The argument checks of every reviewed tool, and the predicate that skips review for a call that
 * cannot be applied or that the Socratic gate answers itself.
 */
export function createReviewChecks(
  effects: readonly ApprovalTool[],
  gate: ReturnType<typeof createSocraticGate>,
) {
  const checks = createArgumentChecks(
    new Map([
      ...effects.flatMap((effect) =>
        effect.validate === undefined ? [] : [[effect.name, effect.validate.bind(effect)] as const],
      ),
      [QUESTION_TOOL_NAME, questionsProblem] as const,
    ]),
  );
  const noReview: WhenPredicate = async (request) =>
    checks.invalid(request) || (gate !== null && (await gate.shouldBlock(request)));
  return { middleware: checks.middleware, noReview };
}
