import { expect, it } from "vitest";

import { parseSavedServer, SAVED_SERVER_FILE, serializeSavedServer } from "./saved-server.js";

it("round-trips the saved server and keeps it out of settings.json", () => {
  expect(SAVED_SERVER_FILE).toBe("server.json");
  expect(JSON.parse(serializeSavedServer("http://192.168.1.20:18787"))).toEqual({
    version: 1,
    server: "http://192.168.1.20:18787",
  });
  expect(parseSavedServer(serializeSavedServer("https://aula.example"))).toBe(
    "https://aula.example",
  );
  expect(parseSavedServer('{"version":1,"server":"  https://aula.example  "}')).toBe(
    "https://aula.example",
  );
});

it.each([
  ["not json"],
  ["null"],
  ['"https://aula.example"'],
  ["{}"],
  ['{"version":2,"server":"https://aula.example"}'],
  ['{"server":"https://aula.example"}'],
  ['{"version":1,"server":7}'],
  ['{"version":1,"server":"aula"}'],
  ['{"version":1,"server":"ftp://aula.example"}'],
  ['{"version":1,"server":"https://user:secret@aula.example"}'],
  ['{"version":1,"server":"https://user@aula.example"}'],
  ['{"version":1,"server":"https://:secret@aula.example"}'],
])("ignores a saved server that is not usable: %s", (text) => {
  expect(parseSavedServer(text)).toBeUndefined();
});
