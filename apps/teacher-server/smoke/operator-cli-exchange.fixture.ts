import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { installationFixture } from "../src/platform/operator-cli/installation.fixture.js";
import { skillMarkdown } from "../src/platform/operator-cli/installation.fixture.js";

const json = z.record(z.string(), z.json());
type Json = z.infer<typeof json>;
type Invoke = (name: string, payload: Json, options?: string[], status?: number) => Json;

export function verifyCompiledExchange(
  f: ReturnType<typeof installationFixture>,
  invoke: Invoke,
  fails: (name: string, payload: Json, options?: string[], status?: number) => void,
  read: (sql: string) => Json[],
  expectedTeachingVersion: string,
) {
  const target = { centerId: "center:a", classId: "class:ready" };
  const owner = { source: "teacher", id: "user:teacher" };
  const skills = z.array(json).parse(invoke("skill list", { owner, kind: "didactic" }).skills);
  const skill = json.parse(skills[0]);
  const id = z.string().parse(skill.id);
  const digest = z.string().parse(skill.digest);
  const exchange = {
    format: "marea-class-exchange:1",
    source: { displayName: "Personal source" },
    agentMode: "free",
    classInstructions: { tutoring: "Private tutor", free: "Private free" },
    selection: { didactic: [{ id, digest }], evaluation: [] },
  };
  const frozen = read("SELECT * FROM marea_run_snapshots");
  const runs = read("SELECT * FROM marea_runs");
  const revisions = read("SELECT * FROM marea_class_teaching_revisions");
  const preview = invoke("class import-preview", {
    ...target,
    expectedTeachingVersion,
    package: exchange,
  });
  const request = {
    kind: "didactic",
    slug: "example",
    files: [
      { path: "SKILL.md", content: skillMarkdown("example") + "\nChanged private source.\n" },
    ],
    expectedDigest: digest,
  };
  const changed = invoke("skill save", { owner, request });
  assert.notEqual(changed.digest, digest);
  fails(
    "class import-confirm",
    { ...target, previewId: z.string().parse(preview.previewId) },
    [],
    4,
  );
  fails("class import-preview", { ...target, expectedTeachingVersion, package: exchange }, [], 4);
  assert.deepEqual(read("SELECT * FROM marea_class_teaching_revisions"), revisions);
  const updatedExchange = {
    ...exchange,
    selection: { didactic: [{ id, digest: z.string().parse(changed.digest) }], evaluation: [] },
  };
  const policyPreview = invoke("class import-preview", {
    ...target,
    expectedTeachingVersion,
    package: updatedExchange,
  });
  const policyBytes = readFileSync(f.operatorPolicyPath);
  writeFileSync(
    f.operatorPolicyPath,
    JSON.stringify({
      ...f.document,
      classes: f.document.classes.map((entry) => ({
        ...entry,
        policy: { ...entry.policy, route: { ...entry.policy.route, version: "route:changed" } },
      })),
    }),
  );
  try {
    fails(
      "class import-confirm",
      { ...target, previewId: z.string().parse(policyPreview.previewId) },
      [],
      4,
    );
  } finally {
    writeFileSync(f.operatorPolicyPath, policyBytes);
  }
  const fresh = invoke("class import-preview", {
    ...target,
    expectedTeachingVersion,
    package: updatedExchange,
  });
  invoke("class import-confirm", { ...target, previewId: z.string().parse(fresh.previewId) });
  assert.deepEqual(read("SELECT * FROM marea_run_snapshots"), frozen);
  assert.deepEqual(read("SELECT * FROM marea_runs"), runs);
  for (const row of read(
    "SELECT authority, created_by, configuration_json FROM marea_class_teaching_revisions",
  )) {
    assert.equal(row.authority, "operator");
    assert.equal(row.created_by, null);
    const configuration = json.parse(JSON.parse(z.string().parse(row.configuration_json)));
    assert.equal(json.parse(configuration.content).automaticEvaluation, false);
  }
  fails("skill save", { owner: { source: "marea" }, request }, [], 2);
  fails("skill save", { owner: { source: "teacher", id: "user:foreign" }, request }, [], 3);
}
