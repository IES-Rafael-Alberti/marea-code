import { describe, expect, it } from "vitest";

import {
  createSessionContext,
  redactRemoteUserinfo,
  sanitizeContextField,
  sessionModelAlias,
} from "./session-context.js";

describe("session context", () => {
  it.each([
    { maxLength: 8, value: "trunk", expected: "trunk" },
    { maxLength: 8, value: "  spaced  ", expected: "  spaced" },
    { maxLength: 4, value: "abcdef", expected: "abcd" },
    { maxLength: 4, value: "abcd", expected: "abcd" },
    { maxLength: 8, value: "a\u001Bb\u001Fc", expected: "abc" },
    { maxLength: 8, value: "a\u007Fb", expected: "ab" },
    { maxLength: 8, value: "", expected: "" },
  ])("sanitizes $value to $expected", ({ maxLength, value, expected }) => {
    expect(sanitizeContextField(value, maxLength)).toBe(expected);
  });

  it.each([
    {
      url: "https://student:secret@example.invalid/class/repo.git",
      expected: "https://example.invalid/class/repo.git",
    },
    {
      url: "https://student:secret@example.invalid",
      expected: "https://example.invalid",
    },
    {
      url: "https://example.invalid/class/repo.git",
      expected: "https://example.invalid/class/repo.git",
    },
    {
      url: "git@example.invalid:class/repo.git",
      expected: "git@example.invalid:class/repo.git",
    },
    {
      url: "https://example.invalid/team@home/repo.git",
      expected: "https://example.invalid/team@home/repo.git",
    },
  ])("redacts remote userinfo: $url", ({ url, expected }) => {
    expect(redactRemoteUserinfo(url)).toBe(expected);
  });

  it.each([
    { started: null, expected: "" },
    { started: [], expected: "" },
    { started: {}, expected: "" },
    { started: { snapshot: {} }, expected: "" },
    { started: { snapshot: { modelAlias: "marea" } }, expected: "marea" },
    {
      started: { snapshot: { modelAlias: "marea", extra: "kept" }, other: 1 },
      expected: "marea",
    },
  ])("reads the model alias: $started", ({ started, expected }) => {
    expect(sessionModelAlias(started)).toBe(expected);
  });

  it("assembles the banner context from the session values", () => {
    expect(
      createSessionContext({
        cwd: "/courses/physics/project-one",
        git: {
          branch: "trunk",
          repositoryUrl: "https://student:secret@example.invalid/class/repo.git",
        },
        model: "marea",
      }),
    ).toEqual({
      branch: "trunk",
      cwd: "/courses/physics/project-one",
      model: "marea",
      repositoryUrl: "https://example.invalid/class/repo.git",
    });
  });

  it("omits empty rows and truncates overlong values", () => {
    expect(
      createSessionContext({
        cwd: "x".repeat(600),
        git: { branch: "", repositoryUrl: "" },
        model: "",
      }),
    ).toEqual({ branch: "", cwd: "x".repeat(512), model: "", repositoryUrl: "" });
  });
});
