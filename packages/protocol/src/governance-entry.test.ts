import { expect, it } from "vitest";

it("initializes governance schemas through the public entry before serving any request", async () => {
  // Import inside the test so initialization failures are test failures, not just
  // an empty collection of suites when a schema factory fails during module load.
  const protocol = await import("./index.js");
  const request = {
    protocolVersion: "0.1",
    requestId: "request:1",
    kind: "governance-access-query",
  };
  expect(protocol.GovernanceAccessQuerySchema.parse(request)).toEqual(request);
  expect(
    protocol.GovernanceAccessResponseSchema.parse({
      ...request,
      kind: "governance-access-response",
      access: { administrator: true },
    }),
  ).toEqual({ ...request, kind: "governance-access-response", access: { administrator: true } });
});
