import { ModelStreamError } from "@marea/deepagents-adapter";
import { expect, it, vi } from "vitest";
import { StartupFixtureServer } from "./startup.fixture.js";
import type { AgentEvent, AgentQuestionTurn, QuestionReply } from "./contracts.js";
import { createFixtureController, FixtureAgent, FixtureInterface } from "./student.fixture.js";

const request = { interruptId: "q1", questions: [{ text: "Why?", choices: [], required: true }] };
class QuestionAgent extends FixtureAgent {
  readonly questionTurns: AgentQuestionTurn[] = [];
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "Before " };
    yield { type: "questions-required", request };
  }
  async *resumeQuestions(turn: AgentQuestionTurn): AsyncIterable<AgentEvent> {
    this.questionTurns.push(turn);
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "after" };
    yield { type: "turn-completed" };
  }
}
class QuestionInterface extends FixtureInterface {
  readonly askQuestions = vi
    .fn<(input: typeof request) => Promise<QuestionReply>>()
    .mockResolvedValue({ type: "answers", values: ["Because"] });
}

it("resumes the same logical turn with its persisted prefix and does not authorize a write", async () => {
  const agent = new QuestionAgent();
  const studentInterface = new QuestionInterface();
  const fixture = createFixtureController({ agent, studentInterface });
  await fixture.controller.start("Project");
  await fixture.controller.sendMessage(
    "message:q",
    "Help",
    new AbortController().signal,
    "attempt:q",
  );
  expect(studentInterface.askQuestions).toHaveBeenCalledExactlyOnceWith({
    ...request,
    messageId: "message:q",
    attemptId: "attempt:q",
  });
  expect([...fixture.server.events.values()]).toContainEqual(
    expect.objectContaining({
      eventType: "questions-resolved",
      interruptId: "q1",
      messageId: "message:q",
      questions: request.questions,
      answers: ["Because"],
      cancelled: false,
    }),
  );
  expect(agent.questionTurns).toHaveLength(1);
  expect(agent.questionTurns[0]).toMatchObject({
    request,
    values: ["Because"],
    assistantText: "Before ",
    messageId: "message:q",
    runId: "run:1",
  });
  expect(fixture.workspace.writes).toBe(0);
  expect(fixture.state.state.run?.approvals).toEqual([]);
  expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
    state: "completed",
    text: "Before after",
  });
});

it.each(["cancel", "abort"])("%s during a question cannot resume the agent", async (mode) => {
  const agent = new QuestionAgent();
  const studentInterface = new QuestionInterface();
  const abort = new AbortController();
  studentInterface.askQuestions.mockImplementation(async () => {
    await Promise.resolve();
    if (mode === "abort") abort.abort();
    return mode === "cancel" ? { type: "cancel" } : { type: "answers", values: ["late"] };
  });
  const fixture = createFixtureController({ agent, studentInterface });
  await fixture.controller.start("Project");
  await fixture.controller.sendMessage("message:q", "Help", abort.signal);
  const recorded = [...fixture.server.events.values()].filter(
    (event) => event.eventType === "questions-resolved",
  );
  expect(recorded).toEqual(
    mode === "cancel" ? [expect.objectContaining({ cancelled: true, answers: [] })] : [],
  );
  expect(agent.questionTurns).toEqual([]);
  expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
    state: "cancelled",
    text: "Before ",
  });
});

it("fails closed when either runtime or UI cannot service a question", async () => {
  const missingUi = createFixtureController({ agent: new QuestionAgent() });
  await missingUi.controller.start("Project");
  await expect(
    missingUi.controller.sendMessage("message:q", "Help", new AbortController().signal),
  ).rejects.toMatchObject({
    cause: { message: "Structured questions are not supported in this turn." },
  });
  const agent = new FixtureAgent();
  agent.streamMessage = new QuestionAgent().streamMessage.bind(agent);
  const missingRuntime = createFixtureController({
    agent,
    studentInterface: new QuestionInterface(),
  });
  await missingRuntime.controller.start("Project");
  await expect(
    missingRuntime.controller.sendMessage("message:q", "Help", new AbortController().signal),
  ).rejects.toMatchObject({
    cause: { message: "Structured questions are not supported in this turn." },
  });
});

it("retains a rejection reason over an interrupted resume and never performs the write", async () => {
  const agent = new FixtureAgent();
  const studentInterface = new FixtureInterface();
  const confirm = vi
    .spyOn(studentInterface, "confirmWrite")
    .mockResolvedValue({ decision: "rejected", reason: "Explain it first" });
  const original = agent.resumeApproval.bind(agent);
  agent.resumeApproval = async function* () {
    await Promise.resolve();
    yield await Promise.reject(
      new ModelStreamError({ code: "unavailable", message: "Interrupted resume", retryable: true }),
    );
  };
  const fixture = createFixtureController({ agent, studentInterface });
  await fixture.controller.start("Project");
  await expect(
    fixture.controller.sendMessage("message:r", "Write", new AbortController().signal),
  ).rejects.toThrow();
  expect(fixture.state.state.run?.approvals).toEqual([
    { approvalId: "approval:1", decision: "rejected", reason: "Explain it first" },
  ]);
  agent.resumeApproval = original;
  await fixture.controller.sendMessage("message:r", "Write", new AbortController().signal);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(agent.approvalTurns[0]).toMatchObject({
    decision: "rejected",
    reason: "Explain it first",
    effect: null,
  });
  expect(fixture.workspace.writes).toBe(0);
});

it("cancels while the question UI is still pending and ignores its late answer", async () => {
  const agent = new QuestionAgent();
  const studentInterface = new QuestionInterface();
  const asked = Promise.withResolvers<undefined>();
  const answer = Promise.withResolvers<QuestionReply>();
  studentInterface.askQuestions.mockImplementation(() => {
    asked.resolve(undefined);
    return answer.promise;
  });
  const abort = new AbortController();
  const fixture = createFixtureController({ agent, studentInterface });
  await fixture.controller.start("Project");
  const running = fixture.controller.sendMessage("message:pending", "Help", abort.signal);
  await asked.promise;
  abort.abort();
  await running;
  expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
    state: "cancelled",
    text: "Before ",
  });
  answer.resolve({ type: "answers", values: ["late"] });
  await Promise.resolve();
  expect(agent.questionTurns).toEqual([]);
  expect(fixture.workspace.writes).toBe(0);
});

it("rejects questions during startup even when both ports exist", async () => {
  const agent = Object.assign(new QuestionAgent(), {
    streamStartup: () => new QuestionAgent().streamMessage(),
  });
  const fixture = createFixtureController({
    agent,
    server: new StartupFixtureServer(),
    studentInterface: new QuestionInterface(),
  });
  await fixture.controller.start("Project");
  await expect(fixture.controller.sendStartup(new AbortController().signal)).rejects.toMatchObject({
    cause: { message: "Structured questions are not supported in this turn." },
  });
});

it("reports an invalid UI rejection as a question failure with its saved prefix", async () => {
  const studentInterface = new QuestionInterface();
  studentInterface.askQuestions.mockRejectedValue("invalid rejection");
  const fixture = createFixtureController({ agent: new QuestionAgent(), studentInterface });
  await fixture.controller.start("Project");
  await expect(
    fixture.controller.sendMessage("message:failed", "Help", new AbortController().signal),
  ).rejects.toMatchObject({ prefix: "Before ", cause: { message: "Structured question failed." } });
});

it("fails closed when an installed question interface returns no reply", async () => {
  const studentInterface = new QuestionInterface();
  studentInterface.askQuestions.mockResolvedValue(undefined as never);
  const fixture = createFixtureController({ agent: new QuestionAgent(), studentInterface });
  await fixture.controller.start("Project");
  await expect(
    fixture.controller.sendMessage("message:invalid", "Help", new AbortController().signal),
  ).rejects.toMatchObject({ cause: { message: "The question interface returned no reply." } });
  expect(fixture.workspace.writes).toBe(0);
});

it.each([1, 2, 3])(
  "cancellation after the UI response wins before question continuation (%s microtasks)",
  async (turns) => {
    const asked = Promise.withResolvers<undefined>();
    const agent = new QuestionAgent();
    const answer = Promise.withResolvers<QuestionReply>();
    const studentInterface = new QuestionInterface();
    studentInterface.askQuestions.mockImplementation(() => {
      asked.resolve(undefined);
      return answer.promise;
    });
    const fixture = createFixtureController({ agent, studentInterface });
    const abort = new AbortController();
    await fixture.controller.start("Project");
    const running = fixture.controller.sendMessage("message:race", "Help", abort.signal);
    await asked.promise;
    answer.resolve({ type: "answers", values: ["Because"] });
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    abort.abort();
    await running;
    expect(agent.questionTurns).toEqual([]);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
      state: "cancelled",
      text: "Before ",
    });
  },
);

it("retains two distinct question replies in one attempt without coalescing their event keys", async () => {
  const agent = new QuestionAgent();
  agent.resumeQuestions = async function* (turn) {
    await Promise.resolve();
    yield turn.request.interruptId === "q1"
      ? { type: "questions-required", request: { ...request, interruptId: "q2" } }
      : { type: "turn-completed" };
  };
  const fixture = createFixtureController({ agent, studentInterface: new QuestionInterface() });
  await fixture.controller.start("Project");
  await fixture.controller.sendMessage(
    "message:two-questions",
    "Help",
    new AbortController().signal,
  );
  expect(
    [...fixture.server.events.values()]
      .filter((event) => event.eventType === "questions-resolved")
      .map((event) => event.interruptId),
  ).toEqual(["q1", "q2"]);
});

it("does not resume the model if cancellation arrives while the answer is being acknowledged", async () => {
  const agent = new QuestionAgent();
  const fixture = createFixtureController({ agent, studentInterface: new QuestionInterface() });
  await fixture.controller.start("Project");
  const abort = new AbortController();
  const append = fixture.server.appendRunEvents.bind(fixture.server);
  fixture.server.appendRunEvents = async (token, input) => {
    const result = await append(token, input);
    if (input.events.some((event) => event.eventType === "questions-resolved")) abort.abort();
    return result;
  };
  await fixture.controller.sendMessage("message:cancel-ack", "Help", abort.signal);
  expect(agent.questionTurns).toEqual([]);
  expect(fixture.state.state.run?.turns.at(-1)?.state).toBe("cancelled");
});

it("does not record an answer when cancellation wins before presentation resumes", async () => {
  const agent = new QuestionAgent();
  const studentInterface = new QuestionInterface();
  const abort = new AbortController();
  studentInterface.askQuestions.mockImplementation(() => {
    const reply = Promise.resolve<QuestionReply>({ type: "answers", values: ["Too late"] });
    void reply.then(() => {
      queueMicrotask(() => {
        abort.abort();
      });
    });
    return reply;
  });
  const fixture = createFixtureController({ agent, studentInterface });
  await fixture.controller.start("Project");
  await fixture.controller.sendMessage("message:cancel-answer", "Help", abort.signal);
  expect(agent.questionTurns).toEqual([]);
  expect(
    [...fixture.server.events.values()].some((event) => event.eventType === "questions-resolved"),
  ).toBe(false);
});
