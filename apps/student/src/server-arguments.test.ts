import { expect, it } from "vitest";
import { parseServerArguments } from "./server-arguments.js";

it("extracts an explicit server without changing other arguments or the input", () => {
  expect(parseServerArguments([])).toEqual({ arguments: [], serverUrl: undefined });
  expect(parseServerArguments(["--server-other", "--help"])).toEqual({
    arguments: ["--server-other", "--help"],
    serverUrl: undefined,
  });
  for (const flag of [
    ["--server", " http://192.168.1.20:18787 "],
    ["--server=http://192.168.1.20:18787"],
  ]) {
    const argv = Object.freeze(["feedback", ...flag, "--no-mouse"]);
    expect(parseServerArguments(argv)).toEqual({
      arguments: ["feedback", "--no-mouse"],
      serverUrl: "http://192.168.1.20:18787",
    });
  }
});

it.each([
  ["--server"],
  ["--server", ""],
  ["--server", "  "],
  ["--server="],
  ["--server", "--help"],
  ["--server=--other"],
  ["--server", "https://one.test", "--server=https://two.test"],
])("refuses incomplete or ambiguous selection: %j", (...args) => {
  expect(parseServerArguments(args)).toBeUndefined();
});
