import { describe, expect, it, vi } from "vitest";

import type { StudentTuiIntent } from "../contracts.js";
import { TEST_COPY } from "../../test-support/copy.js";

type KeyboardInput = Readonly<{ ctrl: boolean; name: string }>;
type KeyboardHandler = (input: KeyboardInput) => void;

let keyboardHandler: KeyboardHandler = () => undefined;
const useKeyboard = vi.hoisted(() =>
  vi.fn((handler: KeyboardHandler) => {
    keyboardHandler = handler;
  }),
);

vi.mock("@opentui/react", () => ({ useKeyboard }));

import { intentForKey, StudentScreen } from "./student-screen.js";

describe("StudentScreen", () => {
  it.each([
    [{ response: "", status: "ready" }, "cancel", TEST_COPY.emptyResponse],
    [{ response: "Streamed answer", status: "streaming" }, "interrupt", "Streamed answer"],
  ] as const)(
    "renders a Marea snapshot and wires keyboard intent",
    (snapshot, intent, expectedResponse) => {
      const onIntent = vi.fn<(intent: StudentTuiIntent) => void>();

      const element = StudentScreen({ copy: TEST_COPY, onIntent, snapshot });
      keyboardHandler({
        ctrl: intent === "interrupt",
        name: intent === "cancel" ? "escape" : "c",
      });

      expect(element).toMatchObject({
        props: {
          children: [
            { props: { children: TEST_COPY.title } },
            { props: { children: TEST_COPY.statuses[snapshot.status] } },
            { props: { children: expectedResponse } },
            { props: { children: TEST_COPY.controls } },
          ],
        },
      });
      expect(useKeyboard).toHaveBeenCalled();
      expect(onIntent).toHaveBeenCalledWith(intent);
      onIntent.mockClear();
      keyboardHandler({ ctrl: false, name: "x" });
      expect(onIntent).not.toHaveBeenCalled();
    },
  );
});

describe("intentForKey", () => {
  it.each([
    ["c", true, "interrupt"],
    ["escape", false, "cancel"],
    ["q", false, "quit"],
    ["c", false, undefined],
    ["x", true, undefined],
    ["x", false, undefined],
  ] as const)("maps %s with ctrl=%s", (key, ctrl, intent) => {
    expect(intentForKey(key, ctrl)).toBe(intent);
  });
});
