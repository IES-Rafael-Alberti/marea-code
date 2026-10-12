import * as z from "zod";
import { expect, it, vi } from "vitest";
import { SkillGenerator, SkillGenerationError, SKILL_GENERATION_PROMPT } from "./generate-skill.js";
import { EducationalInference } from "../../educational-insights/inference.js";
import { skillAssignmentFixture } from "../../platform/persistence/skill-assignments.fixture.js";
import {
  syntheticOperatorPolicy,
  MemorySkillSource,
} from "../configuration/dashboard-module.fixture.js";
import { BundledSkillSource } from "./bundled-skill-source.boundary.js";
import { findRepositorySkillRoot } from "./repository-catalog.fixture.js";
import { SkillWorkspaceRequestSchema } from "@marea/protocol";
import type { InferenceProviderRequest } from "@marea/plugin-api";

import { SYNTHETIC_ROUTE_BUDGET } from "../../../test-support/usage-fixture.js";
const policy = {
  ...syntheticOperatorPolicy,
  route: {
    ...syntheticOperatorPolicy.route,
    providerRoute: {
      ...syntheticOperatorPolicy.route.providerRoute,
      budget: SYNTHETIC_ROUTE_BUDGET,
    },
  },
};
const content =
  "---\nname: testing\ndescription: Practice one test\n---\n# Practice\nAsk for a boundary case.";
function fixture() {
  const f = skillAssignmentFixture();
  const captured: InferenceProviderRequest[] = [];
  const current = { content };
  const inference = new EducationalInference(
    f.database,
    {
      resolve: () => ({
        async *stream(request) {
          captured.push(request);
          await Promise.resolve();
          yield { type: "text-delta", text: JSON.stringify(current) };
          yield { type: "usage", inputTokens: 20, outputTokens: 30 };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
    },
    { now: () => "2026-10-11T15:00:00.000Z" },
  );
  const operator = { forClass: vi.fn(() => policy) };
  const examples = new BundledSkillSource(findRepositorySkillRoot(process.cwd()));
  const generator = new SkillGenerator(inference, operator, examples);
  const input = SkillWorkspaceRequestSchema.parse({
    kind: "generate",
    protocolVersion: "0.1",
    requestId: "request:draft",
    classId: "class:one",
    slug: "testing",
    skillKind: "didactic",
    instructions: "Bucles y pruebas. Criterio local-bucle. Pregunta por los límites.",
    locale: "es",
  });
  if (input.kind !== "generate") throw new Error("request");
  return { ...f, generator, input, current, captured, operator, examples, inference };
}
it("uses the configured modular model, full Testing example and teacher notes, without student usage or publication", async () => {
  const f = fixture();
  expect(await f.generator.generate("t1", f.input, new AbortController().signal)).toBe(content);
  expect(f.operator.forClass).toHaveBeenCalledWith("class:one");
  const request = f.captured[0];
  expect(request?.upstreamModel).toBe(policy.route.providerRoute.model);
  expect(request?.tools).toEqual([]);
  expect(request?.messages[0]?.content).toContain(SKILL_GENERATION_PROMPT);
  const material = z
    .object({
      slug: z.string(),
      kind: z.string(),
      language: z.string(),
      teacherNotes: z.string(),
      examples: z.array(z.string()),
    })
    .parse(JSON.parse(request?.messages[1]?.content ?? "{}"));
  expect(material).toMatchObject({
    slug: "testing",
    kind: "didactic",
    language: "es",
    teacherNotes: f.input.instructions,
  });
  expect(material.examples).toHaveLength(1);
  expect(material.examples[0]).toContain("testing-casos");
  expect(material.examples[0]).toContain("## Vocabulario, si pregunta");
  expect(f.database.readAll("SELECT * FROM marea_usage_accounts")).toEqual([]);
  expect(
    f.inference.ledger.totals({ runId: "skill-authoring:t1", purpose: "evaluation" }).requests,
  ).toBe(1);
  expect(f.database.readAll("SELECT * FROM marea_student_skill_assignments")).toEqual([]);
  await f.generator.generate(
    "t1",
    { ...f.input, skillKind: "evaluation" },
    new AbortController().signal,
  );
  expect(f.captured[1]?.messages[1]?.content).toContain("Cómo evaluar una sesión");
});
it("rejects invalid Markdown, empty bodies, invalid criteria, missing examples and absent routes", async () => {
  const f = fixture();
  for (const invalid of [
    "not markdown",
    content.replace("name: testing", "name: wrong"),
    `${content.split("# Practice")[0] ?? ""} \n`,
    content + "\0",
    content.replace("---\n#", "criterios: [{codigo: x, niveles: [a, b]}]\n---\n#"),
  ]) {
    f.current.content = invalid;
    await expect(
      f.generator.generate("t1", f.input, new AbortController().signal),
    ).rejects.toBeInstanceOf(SkillGenerationError);
  }
  const load = vi.spyOn(f.examples, "load");
  vi.spyOn(f.operator, "forClass").mockReturnValue(null as never);
  await expect(f.generator.generate("t1", f.input, new AbortController().signal)).rejects.toThrow(
    "skill-generation-unavailable",
  );
  expect(load).not.toHaveBeenCalled();
  const absent = new SkillGenerator(
    f.inference,
    { forClass: () => policy },
    new MemorySkillSource([]),
  );
  await expect(absent.generate("t1", f.input, new AbortController().signal)).rejects.toBeInstanceOf(
    SkillGenerationError,
  );
});
it("propagates cancellation, limits simultaneous generation per teacher and releases the slot after failure", async () => {
  const f = fixture();
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  const run = vi.spyOn(f.inference, "generate").mockImplementation(
    (_route, _account, _prompt, _material, _schema, cancellation) =>
      new Promise((_resolve, reject) => {
        signal = cancellation;
        cancellation.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled private provider"));
          },
          { once: true },
        );
      }),
  );
  const pending = f.generator.generate("t1", f.input, abort.signal);
  await vi.waitFor(() => {
    expect(signal).toBeDefined();
  });
  await expect(f.generator.generate("t1", f.input, abort.signal)).rejects.toBeInstanceOf(
    SkillGenerationError,
  );
  expect(run).toHaveBeenCalledOnce();
  abort.abort();
  await expect(pending).rejects.toThrow("skill-generation-unavailable");
  expect(signal?.aborted).toBe(true);
  run.mockRestore();
  expect(await f.generator.generate("t1", f.input, new AbortController().signal)).toBe(content);
});
it("selects the actual SKILL.md after resources and preserves all text including CRLF", async () => {
  const f = fixture();
  const load = f.examples.load.bind(f.examples);
  vi.spyOn(f.examples, "load").mockImplementation(async (id) => {
    const bundle = await load(id);
    if (!bundle) throw new Error("example");
    return {
      ...bundle,
      files: [
        { path: "resources/first.txt", content: "not an example", sizeBytes: 14 },
        ...bundle.files,
      ],
    };
  });
  f.current.content = content.replaceAll("\n", "\r\n");
  expect(await f.generator.generate("t1", f.input, new AbortController().signal)).toBe(
    f.current.content,
  );
  expect(f.captured[0]?.messages[1]?.content).toContain("testing-casos");
  expect(f.captured[0]?.messages[1]?.content).not.toContain("not an example");
});
