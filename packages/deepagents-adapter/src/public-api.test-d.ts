import type * as publicApi from "./index.js";
import type {
  AgentCheckpoint,
  AgentModel,
  AgentRuntime,
  AgentRuntimeOptions,
  ApprovalTurn,
  LocalCheckpointOptions,
  MareaGatewayModelOptions,
} from "./index.js";
import {
  closeAgentCheckpoint,
  createAgentRuntime,
  createLocalCheckpoint,
  createMareaGatewayModel,
} from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Assert<Value extends true> = Value;

type ExpectedValueExports =
  | "AgentAdapterError"
  | "ModelStreamError"
  | "ReadOnlyToolInputError"
  | "closeAgentCheckpoint"
  | "createAgentRuntime"
  | "createLocalCheckpoint"
  | "createMareaGatewayModel"
  | "normalizeDiagnosticCause"
  | "QUESTION_TOOL_NAME"
  | "parseQuestions"
  | "questionAnswers";

export type OnlyMareaValuesEscape = Assert<Equal<keyof typeof publicApi, ExpectedValueExports>>;
export type ModelInputIsOwned = Assert<
  Equal<Parameters<typeof createMareaGatewayModel>, [options: MareaGatewayModelOptions]>
>;
export type ModelOutputIsOwned = Assert<
  Equal<ReturnType<typeof createMareaGatewayModel>, AgentModel>
>;
export type CheckpointInputIsOwned = Assert<
  Equal<Parameters<typeof createLocalCheckpoint>, [options: LocalCheckpointOptions]>
>;
export type CheckpointOutputIsOwned = Assert<
  Equal<ReturnType<typeof createLocalCheckpoint>, AgentCheckpoint>
>;
export type CheckpointCloseIsOwned = Assert<
  Equal<Parameters<typeof closeAgentCheckpoint>, [checkpoint: AgentCheckpoint]>
>;
export type RuntimeInputIsOwned = Assert<
  Equal<Parameters<typeof createAgentRuntime>, [options: AgentRuntimeOptions]>
>;
export type RuntimeOutputIsOwned = Assert<
  Equal<ReturnType<typeof createAgentRuntime>, AgentRuntime>
>;
export type ApprovalResumeIdentifiesReview = Assert<Equal<ApprovalTurn["reviewId"], string>>;
