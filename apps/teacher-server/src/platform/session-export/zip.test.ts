import { expect, it } from "vitest";
import { sessionZip } from "./zip.js";
it("preserves the interoperable ZIP headers, checksums, offsets and UTF-8 flag", () => {
  // Independently opened and CRC-checked using Python zipfile in browser acceptance.
  const files = [
    { name: "README.txt", content: "synthetic only" },
    { name: "conversations/session-1.md", content: "# Conversación\n\n    print(á)\n" },
  ];
  expect(Buffer.from(sessionZip(files)).toString("hex")).toMatchSnapshot();
  expect(Buffer.from(sessionZip([])).toString("hex")).toBe(
    "504b0506000000000000000000000000000000000000",
  );
});
