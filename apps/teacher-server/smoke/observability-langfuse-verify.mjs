// Compare the synthetic receipt with a modern `langfuse-cli api observations list --json` export.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const [receiptPath, responsePath, projectId] = process.argv.slice(2);
assert(receiptPath && responsePath && projectId, "Supply receipt, CLI response and project ID.");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const response = JSON.parse(readFileSync(responsePath, "utf8"));
assert.equal(response.status, 200);
assert(!response.body.meta.cursor, "Read every observation before comparing the receipt.");
const observations = response.body.data;
assert.equal(observations.length, receipt.spans.length);
assert.equal(new Set(observations.map((span) => span.id)).size, receipt.spans.length);
assert.equal(observations.filter((span) => span.isRootObservation).length, 1);
for (const expected of receipt.spans) {
  const actual = observations.find((span) => span.id === expected.id);
  assert(actual, `Missing observation ${expected.id}`);
  assert.equal(actual.projectId, projectId);
  assert.equal(actual.traceId, receipt.traceId);
  assert.equal(actual.sessionId, receipt.sessionId);
  assert.equal(actual.userId, receipt.userId);
  assert.equal(actual.release, receipt.release);
  assert.equal(actual.traceName, "Marea tutoring turn");
  assert.equal(actual.metadata.classId, receipt.classId);
  assert.equal(actual.parentObservationId, expected.parentId ?? null);
  assert.equal(actual.isRootObservation, expected.parentId === undefined);
  assert.equal(actual.type, expected.type.toUpperCase());
  assert.equal(actual.name, expected.name);
  assert.equal(actual.level, expected.failed ? "ERROR" : "DEFAULT");
  assert.equal(actual.startTime, expected.startedAt);
  assert.equal(actual.endTime, expected.endedAt ?? expected.startedAt);
  // Langfuse normalizes empty input/output attributes to null.
  assert.equal(actual.input, expected.input || null);
  assert.equal(actual.output, expected.output || null);
  assert.equal(actual.model, expected.model ?? "");
  for (const [key, value] of Object.entries(expected.metadata))
    assert.deepEqual(actual.metadata[key], value, `Metadata ${expected.name}.${key}`);
  assert.equal(actual.inputUsage, expected.usage?.input ?? 0);
  assert.equal(actual.outputUsage, expected.usage?.output ?? 0);
  assert.equal(actual.totalUsage, (expected.usage?.input ?? 0) + (expected.usage?.output ?? 0));
  if (expected.usage) {
    assert.equal(actual.usageDetails.input, expected.usage.input);
    assert.equal(actual.usageDetails.output, expected.usage.output);
  }
  // The fixture uses a synthetic model and policy units, never a real model or USD prices.
  assert.equal(actual.totalCost, null);
  assert.deepEqual(actual.costDetails, {});
}
process.stdout.write(
  `Verified ${observations.length} stored observations: hierarchy, identity, content, metadata, model, usage and policy costs.\n`,
);
