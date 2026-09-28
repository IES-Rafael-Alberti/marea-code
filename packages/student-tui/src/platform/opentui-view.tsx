/** @jsxImportSource @opentui/react */
import type {
  StudentTuiCopy,
  StudentTuiIntent,
  StudentTuiSnapshot,
  StudentTuiView,
} from "../contracts.js";
import { createNativeOpenTuiHost, type OpenTuiHost } from "./native-host.boundary.js";
import { StudentScreen } from "./student-screen.js";

export type OpenTuiHostFactory = () => Promise<OpenTuiHost>;

export async function createOpenTuiView(
  copy: StudentTuiCopy,
  onIntent: (intent: StudentTuiIntent) => void,
  createHost: OpenTuiHostFactory = createNativeOpenTuiHost,
): Promise<StudentTuiView> {
  const host = await createHost();
  return Object.freeze({
    dispose(): void {
      host.dispose();
    },
    render(snapshot: StudentTuiSnapshot): void {
      host.render(<StudentScreen copy={copy} onIntent={onIntent} snapshot={snapshot} />);
    },
  });
}
