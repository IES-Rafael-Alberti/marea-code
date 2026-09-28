/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { StudentTuiCopy, StudentTuiIntent, StudentTuiSnapshot } from "../contracts.js";

interface StudentScreenProperties {
  readonly copy: StudentTuiCopy;
  readonly onIntent: (intent: StudentTuiIntent) => void;
  readonly snapshot: StudentTuiSnapshot;
}

export function intentForKey(name: string, ctrl: boolean): StudentTuiIntent | undefined {
  if (ctrl && name === "c") return "interrupt";
  if (name === "escape") return "cancel";
  if (name === "q") return "quit";
  return undefined;
}

export function StudentScreen({ copy, onIntent, snapshot }: StudentScreenProperties) {
  useKeyboard((key) => {
    const intent = intentForKey(key.name, key.ctrl);
    if (intent !== undefined) onIntent(intent);
  });

  return (
    <box flexDirection="column" padding={1}>
      <text fg="#38bdf8">{copy.title}</text>
      <text>{copy.statuses[snapshot.status]}</text>
      <text>{snapshot.response.length === 0 ? copy.emptyResponse : snapshot.response}</text>
      <text fg="#94a3b8">{copy.controls}</text>
    </box>
  );
}
