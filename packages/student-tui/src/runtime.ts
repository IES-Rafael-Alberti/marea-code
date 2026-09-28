import type {
  StudentTuiCopy,
  StudentTuiEnvironment,
  StudentTuiIntent,
  StudentTuiSession,
  StudentTuiViewFactory,
} from "./contracts.js";
import { createStudentTuiSession } from "./session.js";
import { StudentTuiStartupError } from "./startup-error.js";

export async function startStudentTuiWithPorts(
  copy: StudentTuiCopy,
  environment: StudentTuiEnvironment,
  createView: StudentTuiViewFactory,
): Promise<StudentTuiSession> {
  if (!environment.interactive) throw new StudentTuiStartupError("NON_INTERACTIVE");

  let handleIntent: (intent: StudentTuiIntent) => void = () => undefined;
  try {
    const view = await createView(copy, (intent) => {
      handleIntent(intent);
    });
    const binding = createStudentTuiSession({
      setExitCode: environment.setExitCode,
      signals: environment.signals,
      view,
    });
    handleIntent = (intent) => {
      binding.handleIntent(intent);
    };
    return binding.session;
  } catch {
    throw new StudentTuiStartupError("RENDERER_FAILED");
  }
}
