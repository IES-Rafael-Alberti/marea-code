import type { ModelGatewayRequest } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  approvalReviewId,
  approvalTurn,
  assistantText,
  collect,
  signal,
  unusedTool,
} from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import {
  COMPACTION_KEEP_MESSAGES,
  COMPACTION_TRIGGER_MESSAGES,
  SUMMARY_TRANSCRIPT_CHARACTERS,
} from "./compaction.boundary.js";
import type { AgentEvent, ApprovalTool } from "./contracts.js";
import {
  gatewayChunk,
  requestIds,
  ScriptedGateway,
  streamOf,
  textResponse,
  type GatewayScript,
} from "./gateway-model.fixture.js";
import { GATEWAY_MESSAGE_LIMIT } from "./gateway-model.boundary.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

const SUMMARY = "Synthetic summary: the student practised loops.";
const COMMANDS_PER_TURN = 12;

function isSummaryRequest(request: ModelGatewayRequest): boolean {
  return request.tools.length === 0;
}

function toolCallsSinceStudent(request: ModelGatewayRequest): number {
  const student = request.messages.findLastIndex((message) => message.role === "student");
  return request.messages.slice(student).filter((message) => message.role === "tool").length;
}

/** A synthetic tutor that runs one read per model step, twelve per turn, then answers. */
function classSession(result = () => "Synthetic file text."): {
  readonly gateway: ScriptedGateway;
  readonly result: () => string;
} {
  let call = 0;
  const step: GatewayScript = (request, streamSignal) => {
    if (isSummaryRequest(request)) return textResponse(SUMMARY)(request, streamSignal);
    const done = toolCallsSinceStudent(request);
    if (done >= COMMANDS_PER_TURN) return textResponse("Done.")(request, streamSignal);
    const approval = done === 0 && request.messages.at(-1)?.content === "Change it.";
    call += 1;
    return streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "tool-call", {
        callId: approval ? "approval-1" : `read-${String(call)}`,
        tool: approval ? "confirm_change" : "marea_read_project",
        arguments: { path: `src/file-${String(call)}.py` },
      }),
      gatewayChunk(request, 2, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 4, outputTokens: 1 },
      }),
    ]);
  };
  return { gateway: new ScriptedGateway(...Array.from({ length: 1_000 }, () => step)), result };
}

function sessionRuntime(gateway: ScriptedGateway, result: () => string, approval = unusedTool) {
  return createAgentRuntime({
    model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: approval,
    systemPrompt: "Teach clearly.",
    readOnlyTools: [
      {
        name: "marea_read_project",
        description: "Read a synthetic project file.",
        execute: () => Promise.resolve(result()),
      },
    ],
  });
}

async function runTurns(
  runtime: ReturnType<typeof sessionRuntime>,
  turns: number,
): Promise<AgentEvent[][]> {
  const results: AgentEvent[][] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    results.push(
      await collect(
        runtime.streamMessage(
          {
            sessionId: "class-session",
            messageId: `turn-${String(turn)}`,
            text: `Synthetic question ${String(turn)}`,
          },
          signal(),
        ),
      ),
    );
  }
  return results;
}

/** Every tool result must follow the assistant message that issued its call. */
function expectPairedToolResults(request: ModelGatewayRequest): void {
  const issued = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "assistant") for (const call of message.toolCalls) issued.add(call.callId);
    if (message.role === "tool") expect(issued).toContain(message.callId);
  }
}

// Whole simulated class sessions: hundreds of checkpointed graph steps per test.
describe("long-session compaction", { timeout: 30_000 }, () => {
  it("keeps a twelve-command-per-turn class session below the gateway message limit", async () => {
    const { gateway, result } = classSession();
    const runtime = sessionRuntime(gateway, result);

    const turns = await runTurns(runtime, 11);

    for (const events of turns) {
      expect(events.at(-1)).toEqual({ type: "turn-completed" });
      expect(assistantText(events)).toBe("Done.");
    }
    const agentRequests = gateway.requests.filter((request) => !isSummaryRequest(request));
    const summaries = gateway.requests.filter(isSummaryRequest);
    // 11 turns of 26 messages each would be 286 messages without compaction.
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThan(4);
    for (const request of gateway.requests) {
      expect(request.messages.length).toBeLessThanOrEqual(COMPACTION_TRIGGER_MESSAGES);
      expect(request.messages.length).toBeLessThan(GATEWAY_MESSAGE_LIMIT);
    }
    for (const request of agentRequests) expectPairedToolResults(request);
    const last = agentRequests.at(-1);
    expect(last?.messages[1]?.content).toContain(SUMMARY);
    expect(last?.messages[0]?.role).toBe("system");
  });

  it("sends the summary as an internal request whose text never reaches the student", async () => {
    const { gateway, result } = classSession();
    const runtime = sessionRuntime(gateway, result);

    const turns = await runTurns(runtime, 8);

    const summary = gateway.requests.find(isSummaryRequest);
    expect(summary?.messages.map((message) => message.role)).toEqual(["system", "student"]);
    expect(summary?.messages[1]?.content).toContain("Student: Synthetic question 1");
    expect(summary?.messages[1]?.content).toContain("Tool result (marea_read_project)");
    expect(summary?.messages[1]?.content).toContain('[tool call marea_read_project {"path"');
    expect(
      turns
        .flat()
        .map((event) => JSON.stringify(event))
        .join(""),
    ).not.toContain(SUMMARY);
  });

  it("keeps the full durable history for recovery of compacted turns", async () => {
    const { gateway, result } = classSession();
    const runtime = sessionRuntime(gateway, result);
    await runTurns(runtime, 8);
    expect(gateway.requests.some(isSummaryRequest)).toBe(true);

    await expect(
      runtime.recoverMessage({ sessionId: "class-session", messageId: "turn-1" }),
    ).resolves.toEqual({
      type: "completed",
      assistantText: "Done.",
      events: [{ type: "assistant-text-delta", text: "Done." }, { type: "turn-completed" }],
    });
  });

  it("bounds the summary transcript when older tool results are large", async () => {
    const { gateway } = classSession();
    const runtime = sessionRuntime(gateway, () => "x".repeat(50_000));

    const turns = await runTurns(runtime, 7);

    expect(turns.at(-1)?.at(-1)).toEqual({ type: "turn-completed" });
    const summary = gateway.requests.find(isSummaryRequest);
    const transcript = summary?.messages[1]?.content ?? "";
    expect(transcript.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_CHARACTERS);
    expect(transcript).toContain("characters omitted");
  });

  it("compacts around a pending approval without splitting the tool call", async () => {
    const { gateway, result } = classSession();
    const confirm: ApprovalTool = {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      execute: () => Promise.resolve("changed"),
    };
    const runtime = sessionRuntime(gateway, result, confirm);
    // Six turns leave the session a few messages below the trigger: compaction happens
    // inside the approval turn, after the approved call and its result.
    await runTurns(runtime, 6);
    const before = gateway.requests.length;

    const pending = await collect(
      runtime.streamMessage(
        { sessionId: "class-session", messageId: "turn-approval", text: "Change it." },
        signal(),
      ),
    );
    const resumed = await collect(
      runtime.resumeApproval(
        approvalTurn("class-session", "turn-approval", approvalReviewId(pending)),
        signal(),
      ),
    );

    expect(pending.at(-1)?.type).toBe("tool-approval-required");
    expect(resumed.at(-1)).toEqual({ type: "turn-completed" });
    const after = gateway.requests.slice(before);
    expect(after.filter(isSummaryRequest)).toHaveLength(1);
    const agentRequests = after.filter((request) => !isSummaryRequest(request));
    for (const request of agentRequests) {
      expect(request.messages.length).toBeLessThanOrEqual(COMPACTION_TRIGGER_MESSAGES);
      expectPairedToolResults(request);
    }
    // System prompt, summary and the kept tail, widened by at most one batch boundary.
    const compacted = after[after.findIndex(isSummaryRequest) + 1];
    expect(compacted?.messages.length).toBeLessThanOrEqual(COMPACTION_KEEP_MESSAGES + 3);
    expect(compacted?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", callId: "approval-1", content: "changed" }),
    );
  });
});
