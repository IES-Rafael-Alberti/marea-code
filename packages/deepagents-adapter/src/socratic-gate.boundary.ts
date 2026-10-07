import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type WhenPredicate } from "langchain";
import * as z from "zod";
import type { AgentRuntimeOptions } from "./contracts.js";
import { QUESTION_TOOL_NAME } from "./questions.boundary.js";

const CODE = new Set(
  "py js ts tsx jsx java kt c h cpp hpp cs go rs rb php swift dart scala sh sql html css scss vue svelte".split(
    " ",
  ),
);
const SETUP = new Set(
  "pyproject.toml setup.py setup.cfg requirements.txt package.json package-lock.json tsconfig.json pytest.ini tox.ini makefile dockerfile docker-compose.yml .gitignore .editorconfig readme.md conftest.py vite.config.js vite.config.ts cargo.toml".split(
    " ",
  ),
);

function exerciseFile(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = name.lastIndexOf(".");
  return extension > 0 && !SETUP.has(name) && CODE.has(name.slice(extension + 1));
}

/** All decisions come from durable messages, never a process-local attempt counter. */
export function createSocraticGate(policy: AgentRuntimeOptions["socratic"]) {
  if (policy === undefined || policy.mode === "off") return null;
  const shouldBlock: WhenPredicate = ({ toolCall, state }) => {
    if (!policy.tools.includes(toolCall.name) || !exerciseFile(toolCall.args.path)) return false;
    // Ignore results from this same batch: HITL and tool execution must make the same
    // decision even if a sibling question finishes first or the process is restarted.
    const batch = state.messages.findLastIndex((message) => AIMessage.isInstance(message));
    const history = state.messages.slice(0, batch);
    const turn = history.slice(
      history.findLastIndex((message) => HumanMessage.isInstance(message)) + 1,
    );
    const results = turn.filter((message) => ToolMessage.isInstance(message));
    if (
      results.some((message) => message.name === QUESTION_TOOL_NAME && message.status !== "error")
    )
      return false;
    return (
      results.filter((message) => message.additional_kwargs.marea_socratic_block === true).length <
      (policy.mode === "strict" ? 3 : 1)
    );
  };
  return {
    shouldBlock,
    middleware: createMiddleware({
      name: "MareaSocraticGate",
      wrapToolCall: async (request, handler) => {
        if (!(await shouldBlock(request))) return handler(request);
        return new ToolMessage({
          // LangGraph assigns an ID before entering tool middleware.
          tool_call_id: z.string().parse(request.toolCall.id),
          name: request.toolCall.name,
          status: "error",
          additional_kwargs: { marea_socratic_block: true },
          content:
            "Pedagogical pause: no file was changed. Before writing exercise code, ask the student a concrete design question with marea_ask_user. If scaffolding is necessary, explain why and retry. Student permission to change files remains a separate requirement.",
        });
      },
    }),
  };
}
