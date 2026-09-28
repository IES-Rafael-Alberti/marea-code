import {
  ClassSessionsResponseSchema,
  RunHistoryResponseSchema,
  EvaluationResponseSchema,
} from "@marea/protocol";
import type { SessionPluginPorts } from "../src/profiles/session-plugin.js";
const timestamp = "2026-09-22T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const envelope = { protocolVersion: "0.1", requestId: "request:synthetic" };
const classes = ClassSessionsResponseSchema.parse({
  ...envelope,
  kind: "class-sessions-response",
  nextBeforeRunId: null,
  runs: [
    {
      runId: "run:synthetic",
      classId: "class:a",
      studentDisplayName: "Synthetic pupil",
      classDisplayName: "Synthetic class",
      projectDisplayName: "Synthetic project",
      state: "closed",
      openedAt: timestamp,
      closedAt: timestamp,
    },
  ],
});
const history = RunHistoryResponseSchema.parse({
  ...envelope,
  kind: "run-history-response",
  runId: "run:synthetic",
  state: "closed",
  snapshot: {
    id: "snapshot:synthetic",
    agentMode: "free",
    modelAlias: "marea",
    didacticSkills: [],
    prompt: { version: "prompt:synthetic", content: "Synthetic", digest },
    teacherToolPolicy: { version: "policy:synthetic", restrictions: [] },
  },
  afterSequence: 0,
  throughSequence: 0,
  nextSequence: null,
  events: [],
});
const evaluation = EvaluationResponseSchema.parse({
  ...envelope,
  kind: "evaluation-response",
  evaluation: {
    evaluationId: "evaluation:synthetic",
    runId: "run:synthetic",
    generation: 1,
    snapshotId: "snapshot:synthetic",
    inputDigest: digest,
    evaluator: { id: "marea/evaluation", digest },
    didacticSkills: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    state: "draft",
    draft: {
      studentFeedback: "Synthetic feedback",
      teacherNote: "",
      difficulties: [],
      criteria: [],
    },
  },
});
const unused = () => Promise.reject(new Error("Synthetic fixture does not authorize writes"));
export const sessionPorts: SessionPluginPorts = {
  sessions: {
    classes: () => Promise.resolve(classes),
    history: () => Promise.resolve(history),
    query: () => Promise.resolve(evaluation),
    sessions: unused,
    generate: unused,
    approve: unused,
  },
  notices: { publish: unused, query: unused },
};
