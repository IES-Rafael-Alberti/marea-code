import { createScreenController } from "./screen-controller.js";
import type { StudentTuiSnapshot, StudentTuiView } from "./contracts.js";

export const SMOKE_OUTPUT = "marea-student-tui smoke ok";

export function runNonInteractiveSmoke(): string {
  let lifecycle!: string;
  let rendered!: StudentTuiSnapshot;
  const view: StudentTuiView = {
    dispose(): void {
      lifecycle = SMOKE_OUTPUT;
    },
    render(snapshot): void {
      rendered = snapshot;
    },
  };
  const controller = createScreenController(view);
  controller.appendText("ok");
  controller.complete();
  controller.dispose();
  return `${lifecycle}: ${rendered.status}/${rendered.response}`;
}
