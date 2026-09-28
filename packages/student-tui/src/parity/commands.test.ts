import { describe, expect, it } from "vitest";

import { commandList, completionFor, localCommand, suggestionsFor } from "./commands.js";
import type { CommandDescriptions } from "./copy.js";

const copy: CommandDescriptions = {
  details: "compact or detailed outputs",
  exit: "leave Marea",
  help: "commands and shortcuts",
  language: "change the interface language",
  retry: "resume the interrupted turn",
};

describe("local commands", () => {
  it("recognises every command and its Spanish alias", () => {
    expect(localCommand("/exit")).toBe("exit");
    expect(localCommand("/salir")).toBe("exit");
    expect(localCommand("/help")).toBe("help");
    expect(localCommand("/ayuda")).toBe("help");
    expect(localCommand("/retry")).toBe("retry");
    expect(localCommand("/reintentar")).toBe("retry");
    expect(localCommand("/details")).toBe("details");
    expect(localCommand("/language")).toBe("language");
    expect(localCommand("/lang")).toBe("language");
  });

  it("ignores surrounding whitespace", () => {
    expect(localCommand("  /help \n")).toBe("help");
  });

  it("treats anything else as a message for the model", () => {
    expect(localCommand("/detalles")).toBeNull();
    expect(localCommand("explícame /exit")).toBeNull();
    expect(localCommand("")).toBeNull();
  });

  it("does not treat an inherited property name as a command", () => {
    expect(localCommand("constructor")).toBeNull();
    expect(localCommand("__proto__")).toBeNull();
  });
});

describe("command suggestions", () => {
  it("lists the commands in the reference order", () => {
    expect(commandList(copy).map((suggestion) => suggestion.value)).toEqual([
      "/exit",
      "/help",
      "/language",
      "/retry",
      "/details",
    ]);
    expect(commandList(copy)[0]).toEqual({
      command: "exit",
      description: copy.exit,
      value: "/exit",
    });
    expect(commandList(copy)[2]).toEqual({
      command: "language",
      description: copy.language,
      value: "/language",
    });
  });

  it("shows every command for a bare slash", () => {
    expect(suggestionsFor(copy, "/")).toHaveLength(5);
  });

  it("narrows to the matching prefix", () => {
    expect(suggestionsFor(copy, "/re").map((suggestion) => suggestion.value)).toEqual(["/retry"]);
  });

  it("hides while the draft does not start with a slash", () => {
    expect(suggestionsFor(copy, "hola")).toEqual([]);
    expect(suggestionsFor(copy, "")).toEqual([]);
    expect(suggestionsFor(copy, "   ")).toEqual([]);
    expect(suggestionsFor(copy, "explícame /exit")).toEqual([]);
  });

  it("hides once the draft says more than a command", () => {
    expect(suggestionsFor(copy, "/help me")).toEqual([]);
    expect(suggestionsFor(copy, "/help\nmás")).toEqual([]);
    expect(suggestionsFor(copy, "/zzz")).toEqual([]);
  });

  it("ignores the whitespace around the draft", () => {
    expect(suggestionsFor(copy, "  /re  ").map((suggestion) => suggestion.value)).toEqual([
      "/retry",
    ]);
  });

  it("completes to the first match, or to nothing", () => {
    expect(completionFor(copy, "/d")).toBe("/details");
    expect(completionFor(copy, "/")).toBe("/exit");
    expect(completionFor(copy, "/zzz")).toBeNull();
  });
});
