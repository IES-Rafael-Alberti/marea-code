import { expect, it, vi } from "vitest";
import { StudentHttpError } from "./http-error.js";
import {
  studentHttpTransportDiagnostics,
  transportFailure,
} from "./http-transport-diagnostics.boundary.js";

it.each([
  {},
  null,
  { name: 1 },
  { code: "CERT_" + "A".repeat(60) },
  Object.defineProperty({}, "name", {
    get() {
      throw new Error("secret");
    },
  }),
])("sanitizes unusual transport causes %#", (cause) => {
  expect(transportFailure(new Request("https://teacher.test/"), cause, 0, false).cause).toEqual({
    name: "other",
    code: "other",
  });
});

it("stops at cycles and at the fifth cause", () => {
  const cyclic = { cause: {} };
  cyclic.cause = cyclic;
  const request = new Request("https://teacher.test/");
  expect(transportFailure(request, cyclic, 0, false).cause).toEqual({
    name: "other",
    code: "other",
  });
  let cause: object = { code: "ECONNRESET" };
  for (let index = 0; index < 4; index += 1) cause = { cause };
  expect(transportFailure(request, cause, 0, false).cause.code).toBe("ECONNRESET");
  expect(transportFailure(request, { cause }, 0, false).cause.code).toBe("other");
});

it.each(["CERT_", "ERR_TLS_", "TLS_"])("bounds dynamic code length for %s", (prefix) => {
  const code = prefix.padEnd(64, "A");
  const request = new Request("https://teacher.test/");
  expect(transportFailure(request, { code }, 0, false).cause.code).toBe(code);
  expect(transportFailure(request, { code: code + "A" }, 0, false).cause.code).toBe("other");
});

it("clamps and rounds transport duration", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(10.6);
  try {
    const request = new Request("https://teacher.test/");
    expect(transportFailure(request, null, 10, false).elapsedMs).toBe(1);
    expect(transportFailure(request, null, 11, false).elapsedMs).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

it.each([
  { endpoint: 1 },
  { endpoint: "relative" },
  { endpoint: "//host" },
  { endpoint: "/".padEnd(257, "a") },
  { endpoint: "/?secret" },
  { endpoint: "/#secret" },
  { endpoint: "/\\secret" },
  { elapsedMs: "1" },
  { elapsedMs: NaN },
  { elapsedMs: Infinity },
  { elapsedMs: -1 },
  { serverOrigin: null },
])("rejects unsafe diagnostic fields %#", (fields) => {
  const error = Object.assign(new StudentHttpError(0, "transport.unavailable", true), {
    endpoint: "/v1/capabilities",
    elapsedMs: 0,
    serverOrigin: "https://teacher.test",
    ...fields,
  });
  expect(studentHttpTransportDiagnostics(error)).toBeNull();
});

it("accepts endpoint and duration boundary values", () => {
  const fields = {
    endpoint: "/".padEnd(256, "a"),
    elapsedMs: 0,
    serverOrigin: "https://teacher.test",
    cause: { name: "Error", code: "other" },
  };
  expect(
    studentHttpTransportDiagnostics(
      Object.assign(new StudentHttpError(0, "transport.unavailable", true), fields),
    ),
  ).toEqual(fields);
});
