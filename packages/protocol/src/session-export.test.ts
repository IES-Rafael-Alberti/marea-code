import { expect, it } from "vitest";
import { SessionExportQuerySchema } from "./session-export.js";
it("normalizes export date bounds before comparing them and closes the filter contract", () => {
  expect(
    SessionExportQuerySchema.parse({
      identities: "names",
      from: "2026-10-08T00:00:00Z",
      until: "2026-10-08T00:00:00.001Z",
    }),
  ).toEqual({
    identities: "names",
    from: "2026-10-08T00:00:00.000Z",
    until: "2026-10-08T00:00:00.001Z",
  });
  expect(SessionExportQuerySchema.parse({ identities: "pseudonyms" })).toEqual({
    identities: "pseudonyms",
  });
  expect(() =>
    SessionExportQuerySchema.parse({
      identities: "names",
      from: "2026-10-09T00:00:00Z",
      until: "2026-10-08T00:00:00Z",
    }),
  ).toThrow("The exclusive end must follow the start.");
  for (const extra of [
    { from: "2026-10-08T00:00:00Z", until: "2026-10-08T00:00:00.000Z" },
    { from: "2026-10-09T00:00:00Z", until: "2026-10-08T00:00:00Z" },
    { from: "invalid" },
    { untrusted: true },
  ])
    expect(SessionExportQuerySchema.safeParse({ identities: "pseudonyms", ...extra }).success).toBe(
      false,
    );
  for (const extra of [{}, { from: "2026-10-08T00:00:00Z" }, { until: "2026-10-08T00:00:00Z" }])
    expect(SessionExportQuerySchema.safeParse({ identities: "names", ...extra }).success).toBe(
      true,
    );
});
