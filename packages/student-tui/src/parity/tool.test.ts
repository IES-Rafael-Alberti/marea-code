import { describe, expect, it } from "vitest";

import type { ToolCopy } from "./copy.js";
import {
  filterToolArguments,
  summarizeTool,
  toolHeader,
  toolLabel,
  toolOutput,
  toolShouldExpand,
  toolSummary,
  type ToolCall,
  type ToolRow,
} from "./tool.js";

const copy: ToolCopy = {
  emptyOutput: "(sin output)",
  linesRead: (count) => `${String(count)} líneas leídas`,
  omittedMany: (count) => `… ${String(count)} líneas anteriores`,
  omittedOne: "… 1 línea anterior",
  output: "output",
  seeContent: "Ctrl+O para ver el contenido",
  seeOutput: "Ctrl+O para ver el output completo",
};

function call(name: string, args: ToolCall["arguments"] = {}): ToolCall {
  return { arguments: args, callId: "c1", name };
}

function row(name: string, outcome: ToolRow["outcome"], expanded = false): ToolRow {
  return { call: call(name), expanded, outcome };
}

describe("tool labels", () => {
  it("uses localized question and subagent labels in headers", () => {
    const localized = { ...copy, questionLabel: "galdera", subagentLabel: "azpiagentea" };
    for (const name of ["ask_user", "marea_ask_user"]) {
      expect(toolHeader(row(name, null), localized).label).toBe("galdera");
      expect(toolLabel(name, { question: "" })).toBe("");
    }
    expect(toolHeader(row("task", null), localized).label).toBe("azpiagentea");
    expect(toolLabel("task", { subagent: "" })).toBe("");
  });

  it("relabels the tools the reference relabels", () => {
    expect(toolLabel("read_file")).toBe("read");
    expect(toolLabel("write_file")).toBe("write");
    expect(toolLabel("edit_file")).toBe("edit");
    expect(toolLabel("delete")).toBe("del");
    expect(toolLabel("execute")).toBe("shell");
    expect(toolLabel("ask_user")).toBe("pregunta");
    expect(toolLabel("marea_ask_user")).toBe("pregunta");
    expect(toolLabel("write_todos")).toBe("plan");
    expect(toolLabel("task")).toBe("subagente");
  });

  it("relabels the Marea project tools to their short verbs", () => {
    expect(toolLabel("marea_read_project")).toBe("read");
    expect(toolLabel("marea_write_file")).toBe("write");
    expect(toolLabel("marea_list_project")).toBe("list");
    expect(toolLabel("marea_read_skill")).toBe("skill");
  });

  it("leaves an unknown tool under its own name", () => {
    expect(toolLabel("grep")).toBe("grep");
    expect(toolLabel("constructor")).toBe("constructor");
  });
});

describe("tool summaries", () => {
  it("shows the command of a shell call", () => {
    expect(summarizeTool(call("execute", { command: "pytest -q", filePath: "x.py" }))).toBe(
      "pytest -q",
    );
  });

  it("prefers the first argument the reference prefers", () => {
    expect(summarizeTool(call("read_file", { description: "d", filePath: "a.py" }))).toBe("a.py");
    expect(summarizeTool(call("grep", { description: "d", path: "b", pattern: "p" }))).toBe("b");
    expect(summarizeTool(call("grep", { description: "d", pattern: "p" }))).toBe("p");
    expect(summarizeTool(call("task", { description: "d" }))).toBe("d");
  });

  it("is empty when no shown argument is present", () => {
    expect(summarizeTool(call("execute"))).toBe("");
    expect(summarizeTool(call("task"))).toBe("");
  });

  it("truncates a long value to ninety-seven cells and an ellipsis", () => {
    const summary = summarizeTool(call("execute", { command: "a".repeat(120) }));
    expect(Array.from(summary)).toHaveLength(98);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarizeTool(call("execute", { command: "b".repeat(100) }))).toBe("b".repeat(100));
  });

  it("counts a wide character as one cell when truncating", () => {
    const summary = summarizeTool(call("execute", { command: "é".repeat(120) }));
    expect(Array.from(summary)).toHaveLength(98);
  });
});

describe("tool header", () => {
  it("has no output marker while the tool runs", () => {
    expect(toolHeader(row("execute", null), copy)).toEqual({
      glyph: "running",
      label: "shell",
      marker: null,
      summary: "",
    });
  });

  it("marks a finished tool as openable and an open one as closable", () => {
    const outcome = { failed: false, result: "ok" };
    expect(toolHeader(row("execute", outcome), copy).marker).toBe("> output");
    expect(toolHeader(row("execute", outcome, true), copy).marker).toBe("v output");
    expect(toolHeader(row("execute", outcome, true), copy).glyph).toBe("done");
  });

  it("marks a failure", () => {
    expect(toolHeader(row("execute", { failed: true, result: "boom" }), copy).glyph).toBe("failed");
  });
});

describe("tool output", () => {
  it("trims the result", () => {
    expect(toolOutput({ failed: false, result: "  hola\n" }, copy, "execute")).toBe("hola");
  });

  it("names an empty result", () => {
    expect(toolOutput({ failed: false, result: "   " }, copy, "execute")).toBe("(sin output)");
  });
});

describe("compact tool summary", () => {
  it("is absent while the tool runs", () => {
    expect(toolSummary(row("execute", null), copy)).toBeNull();
  });

  it("shows a short output whole, with no hidden-line notice", () => {
    expect(toolSummary(row("execute", { failed: false, result: "a\nb" }), copy)).toEqual({
      hint: null,
      lines: ["a", "b"],
      omitted: null,
    });
  });

  it("keeps the last three lines and counts the rest", () => {
    const result = ["1", "2", "3", "4", "5"].join("\n");
    expect(toolSummary(row("execute", { failed: false, result }), copy)).toEqual({
      hint: copy.seeOutput,
      lines: ["3", "4", "5"],
      omitted: "… 2 líneas anteriores",
    });
  });

  it("says one line in the singular", () => {
    const result = ["1", "2", "3", "4"].join("\n");
    expect(toolSummary(row("execute", { failed: false, result }), copy)?.omitted).toBe(
      "… 1 línea anterior",
    );
  });

  it.each(["read_file", "marea_read_project", "marea_read_skill"])(
    "summarises %s by how much it read",
    (name) => {
      const result = Array.from({ length: 40 }, (_line, index) => `linea ${String(index)}`).join(
        "\n",
      );
      expect(toolSummary(row(name, { failed: false, result }), copy)).toEqual({
        hint: copy.seeContent,
        lines: ["40 líneas leídas"],
        omitted: null,
      });
    },
  );

  it("shows a short read like any other output", () => {
    expect(toolSummary(row("read_file", { failed: false, result: "a\nb" }), copy)).toEqual({
      hint: null,
      lines: ["a", "b"],
      omitted: null,
    });
  });
});

describe("expansion mode", () => {
  it("leaves a running tool closed", () => {
    expect(toolShouldExpand(row("execute", null), true)).toBe(false);
  });

  it("opens every finished tool in detailed mode", () => {
    expect(toolShouldExpand(row("execute", { failed: false, result: "ok" }), true)).toBe(true);
  });

  it("keeps a failure open even in compact mode", () => {
    expect(toolShouldExpand(row("execute", { failed: true, result: "boom" }), false)).toBe(true);
    expect(toolShouldExpand(row("execute", { failed: false, result: "ok" }), false)).toBe(false);
  });
});

describe("shown tool arguments", () => {
  it("keeps every display key and drops the rest", () => {
    expect(
      filterToolArguments({
        command: "ls",
        content: "unseen",
        description: "d",
        filePath: "a",
        path: "b",
        pattern: "p",
      }),
    ).toEqual({ command: "ls", description: "d", filePath: "a", path: "b", pattern: "p" });
  });

  it("keeps an empty row empty", () => {
    expect(filterToolArguments({})).toStrictEqual({});
    expect(filterToolArguments({ content: "unseen" })).toStrictEqual({});
  });
});

it("presents the new controlled tools with the reference labels and useful argument summaries", () => {
  for (const [name, label] of [
    ["marea_edit_file", "edit"],
    ["marea_delete", "del"],
    ["marea_execute", "shell"],
    ["marea_search_project", "grep"],
    ["marea_glob_project", "glob"],
  ]) {
    if (name === undefined || label === undefined) throw new Error("Missing example");
    expect(toolLabel(name)).toBe(label);
  }
  expect(summarizeTool(call("marea_execute", { command: "npm test" }))).toBe("npm test");
  expect(summarizeTool(call("marea_search_project", { query: "needle" }))).toBe("needle");
  expect(filterToolArguments({ query: "needle", secret: "hidden" })).toEqual({ query: "needle" });
});
