import { describe, expect, it } from "vitest";

import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";
import {
  approvalReducer,
  approvalView,
  fullPreview,
  openApproval,
  previewExpandable,
  type ApprovalAction,
  type ApprovalRequest,
  type ApprovalState,
} from "./approval.js";

const copy = PARITY_TEST_COPY.approval;

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    arguments: {},
    interruptId: "i1",
    name: "execute",
    preview: "pytest -q",
    warnings: [],
    ...overrides,
  };
}

function apply(state: ApprovalState, ...actions: readonly ApprovalAction[]): ApprovalState {
  return actions.reduce(approvalReducer, state);
}

describe("full preview", () => {
  it("reconstructs a write with its line count and content", () => {
    const state = request({
      arguments: { content: "uno\ndos\n", filePath: "media.py" },
      name: "write_file",
      preview: "media.py  (3 líneas)",
    });
    expect(fullPreview(state, copy)).toBe("media.py  (3 líneas)\n\nuno\ndos\n");
  });

  it("counts an empty write as no lines", () => {
    const state = request({ arguments: { filePath: "a.py" }, name: "write_file" });
    expect(fullPreview(state, copy)).toBe("a.py  (0 líneas)\n\n");
  });

  it("shows a write with no path as an empty path rather than inventing one", () => {
    const state = request({ arguments: {}, name: "write_file" });
    expect(fullPreview(state, copy)).toBe("  (0 líneas)\n\n");
  });

  it("shows an edit with nothing supplied as empty rather than inventing text", () => {
    const state = request({ arguments: {}, name: "edit_file" });
    expect(fullPreview(state, copy)).toBe("  (una aparición)\n\n- antes\n\n\n+ después\n");
  });

  it("reconstructs an edit as a before and after pair", () => {
    const state = request({
      arguments: { filePath: "a.py", newString: "b", oldString: "a" },
      name: "edit_file",
    });
    expect(fullPreview(state, copy)).toBe("a.py  (una aparición)\n\n- antes\na\n\n+ después\nb");
  });

  it("names the scope of an edit that replaces everything", () => {
    const state = request({ arguments: { replaceAll: true }, name: "edit_file" });
    expect(fullPreview(state, copy)).toContain("(todas las apariciones)");
  });

  it("leaves any other operation with the preview the runtime formatted", () => {
    expect(fullPreview(request(), copy)).toBe("pytest -q");
    expect(previewExpandable(request(), copy)).toBe(false);
  });

  it("is expandable only when it says more than the compact form", () => {
    const write = request({ arguments: { content: "x" }, name: "write_file" });
    expect(previewExpandable(write, copy)).toBe(true);
    const same = request({ name: "write_file", preview: fullPreview(write, copy) });
    expect(previewExpandable({ ...same, arguments: write.arguments }, copy)).toBe(false);
  });
});

describe("approval state", () => {
  it("opens undecided, unexpanded and with no reason", () => {
    expect(openApproval(request())).toEqual({
      decision: null,
      expanded: false,
      reason: "",
      request: request(),
      stage: "deciding",
    });
  });
});

describe("approval view", () => {
  it("offers the actions and the warnings while deciding", () => {
    const state = openApproval(request({ warnings: ["Sale de la carpeta."] }));
    expect(approvalView(state, copy)).toEqual({
      actionsVisible: true,
      outcome: null,
      preview: "pytest -q",
      previewToggle: null,
      reasonVisible: false,
      title: "Autorizar · execute",
      warnings: ["Sale de la carpeta."],
    });
  });

  it("shows the toggle and swaps the preview when expanded", () => {
    const state = openApproval(
      request({ arguments: { content: "x", filePath: "a.py" }, name: "write_file" }),
    );
    expect(approvalView(state, copy).previewToggle).toBe("> mostrar todo");
    const expanded = approvalReducer(state, { type: "toggle-preview" });
    expect(approvalView(expanded, copy).previewToggle).toBe("v contraer");
    expect(approvalView(expanded, copy).preview).toContain("a.py  (1 línea)");
  });
});

describe("approval decisions", () => {
  it("authorizes", () => {
    const state = approvalReducer(openApproval(request()), { type: "approve" });
    expect(state.decision).toEqual({ type: "approve" });
    expect(approvalView(state, copy)).toMatchObject({
      actionsVisible: false,
      outcome: "Autorizado",
    });
  });

  it("opens the reason before rejecting and keeps what is typed", () => {
    const state = apply(
      openApproval(request()),
      { type: "start-reject" },
      { reason: "  prefiero hacerlo yo  ", type: "set-reason" },
    );
    expect(approvalView(state, copy).reasonVisible).toBe(true);
    const rejected = approvalReducer(state, { type: "confirm-reject" });
    expect(rejected.decision).toEqual({ reason: "prefiero hacerlo yo", type: "reject" });
    expect(approvalView(rejected, copy).outcome).toBe("Rechazado: prefiero hacerlo yo");
  });

  it("rejects without a reason", () => {
    const state = apply(
      openApproval(request()),
      { type: "start-reject" },
      { reason: "   ", type: "set-reason" },
      { type: "confirm-reject" },
    );
    expect(state.decision).toEqual({ reason: "", type: "reject" });
    expect(approvalView(state, copy).outcome).toBe("Rechazado");
  });

  it("treats setting the same reason again as no change", () => {
    const state = apply(openApproval(request()), { type: "start-reject" });
    expect(approvalReducer(state, { reason: "", type: "set-reason" })).toBe(state);
  });

  it("cancels rather than approving when the turn is interrupted", () => {
    const state = approvalReducer(openApproval(request()), { type: "cancel" });
    expect(state.decision).toEqual({ type: "cancel" });
    expect(approvalView(state, copy).outcome).toBe("Cancelado");
  });

  it("ignores everything once it is resolved", () => {
    const approved = approvalReducer(openApproval(request()), { type: "approve" });
    for (const action of [
      { type: "approve" },
      { type: "start-reject" },
      { type: "confirm-reject" },
      { type: "cancel" },
      { type: "toggle-preview" },
      { reason: "x", type: "set-reason" },
    ] satisfies ApprovalAction[]) {
      expect(approvalReducer(approved, action)).toBe(approved);
    }
  });
});
