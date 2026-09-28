import type {
  StudentTuiCopy,
  StudentTuiIntent,
  StudentTuiSession,
  StudentTuiView,
} from "./contracts.js";
import { createNodeEnvironment } from "./platform/node-environment.boundary.js";
import { startStudentTuiWithPorts } from "./runtime.js";

async function createLazyOpenTuiView(
  copy: StudentTuiCopy,
  onIntent: (intent: StudentTuiIntent) => void,
): Promise<StudentTuiView> {
  const { createOpenTuiView } = await import("./platform/opentui-view.js");
  return createOpenTuiView(copy, onIntent);
}

export async function startStudentTui(copy: StudentTuiCopy): Promise<StudentTuiSession> {
  const environment = createNodeEnvironment();
  return startStudentTuiWithPorts(copy, environment, createLazyOpenTuiView);
}
