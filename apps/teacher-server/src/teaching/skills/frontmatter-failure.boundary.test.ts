import type * as YamlModule from "yaml";

import { beforeEach, describe, expect, it, vi } from "vitest";

type ParseDocument = typeof YamlModule.parseDocument;

const yamlMocks = vi.hoisted(() => ({
  parseDocument: vi.fn<ParseDocument>(),
}));

vi.mock("yaml", async () => {
  const actual = await vi.importActual<typeof YamlModule>("yaml");
  return { ...actual, parseDocument: yamlMocks.parseDocument };
});

import { BundledSkillError } from "./errors.js";
import { parseSkillFrontmatter } from "./frontmatter.boundary.js";

beforeEach(async () => {
  const actual = await vi.importActual<typeof YamlModule>("yaml");
  yamlMocks.parseDocument.mockImplementation(actual.parseDocument);
});

describe("frontmatter parser failures", () => {
  it("wraps an unexpected YAML parser failure with private boundary context", () => {
    yamlMocks.parseDocument.mockImplementationOnce(() => {
      throw new Error("parser unavailable");
    });

    let error: BundledSkillError | undefined;
    try {
      parseSkillFrontmatter(
        "---\nname: testing\ndescription: Testing\n---\n",
        "testing",
        "didactic",
        "didactic/testing/SKILL.md",
      );
    } catch (caught) {
      if (caught instanceof BundledSkillError) {
        error = caught;
      }
    }

    expect(error).toMatchObject({
      name: "BundledSkillError",
      code: "INVALID_FRONTMATTER",
      location: "didactic/testing/SKILL.md",
    });
    expect(error?.message).toContain("Fix the YAML syntax: Error: parser unavailable");
  });
});
