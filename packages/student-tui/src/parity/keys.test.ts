import { describe, expect, it } from "vitest";

import { actionForKey, type KeyContext, type KeyPress } from "./keys.js";

const IDLE: KeyContext = {
  approvalKeys: false,
  composerEmpty: false,
  composerFirstRow: false,
  composerLastRow: false,
};

function press(name: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { ctrl: false, name, shift: false, ...modifiers };
}

function act(name: string, modifiers: Partial<KeyPress> = {}, context: Partial<KeyContext> = {}) {
  return actionForKey(press(name, modifiers), { ...IDLE, ...context });
}

describe("application keys", () => {
  it("interrupts, exits and scrolls", () => {
    expect(act("escape")).toEqual({ type: "interrupt" });
    expect(act("d", { ctrl: true })).toEqual({ type: "exit" });
    expect(act("pageup")).toEqual({ type: "page-up" });
    expect(act("pagedown")).toEqual({ type: "page-down" });
  });

  it("toggles the last output", () => {
    expect(act("o", { ctrl: true })).toEqual({ type: "toggle-last-output" });
  });

  it("toggles the turn's outputs only with an empty composer", () => {
    expect(act("e", { ctrl: true }, { composerEmpty: true })).toEqual({
      type: "toggle-turn-outputs",
    });
    expect(act("e", { ctrl: true })).toBeNull();
  });

  it("leaves any other control key to the composer", () => {
    expect(act("a", { ctrl: true })).toBeNull();
    expect(act("j", { ctrl: true })).toBeNull();
  });

  it("does not read an inherited property name as a binding", () => {
    expect(act("constructor")).toBeNull();
    expect(act("constructor", { ctrl: true })).toBeNull();
    expect(act("toString")).toBeNull();
  });
});

describe("approval keys", () => {
  it("decides only while an approval is waiting outside a field", () => {
    expect(act("y", {}, { approvalKeys: true })).toEqual({ type: "approve" });
    expect(act("n", {}, { approvalKeys: true })).toEqual({ type: "reject" });
    expect(act("y")).toBeNull();
    expect(act("n")).toBeNull();
  });

  it("leaves any other letter alone during an approval", () => {
    expect(act("s", {}, { approvalKeys: true })).toBeNull();
  });

  it("still interrupts during an approval", () => {
    expect(act("escape", {}, { approvalKeys: true })).toEqual({ type: "interrupt" });
  });
});

describe("composer keys", () => {
  it("completes a command with Tab", () => {
    expect(act("tab")).toEqual({ type: "tab", backwards: false });
  });

  it("does not complete from any other key while a command is being typed", () => {
    expect(act("x")).toBeNull();
  });

  it("leaves Shift+Tab to move the focus", () => {
    expect(act("tab", { shift: true })).toEqual({ type: "tab", backwards: true });
  });

  it("recalls history from the first row and returns from the last", () => {
    expect(act("up", {}, { composerFirstRow: true })).toEqual({ type: "history-older" });
    expect(act("down", {}, { composerLastRow: true })).toEqual({ type: "history-newer" });
  });

  it("leaves the arrows to the cursor anywhere else", () => {
    expect(act("up")).toBeNull();
    expect(act("down")).toBeNull();
  });

  it("does not recall history from any other key on those rows", () => {
    expect(act("x", {}, { composerFirstRow: true })).toBeNull();
    expect(act("x", {}, { composerLastRow: true })).toBeNull();
    expect(act("down", {}, { composerFirstRow: true })).toBeNull();
    expect(act("up", {}, { composerLastRow: true })).toBeNull();
  });
});

it("preserves shifted selection keys instead of recalling history or toggling outputs", () => {
  expect(act("up", { shift: true }, { composerFirstRow: true })).toBeNull();
  expect(act("down", { shift: true }, { composerLastRow: true })).toBeNull();
  expect(act("e", { shift: true, ctrl: true }, { composerEmpty: true })).toBeNull();
  expect(act("y", { shift: true }, { approvalKeys: true })).toBeNull();
});
