import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "./adapter.fixture.js";
import { AgentAdapterError } from "./contracts.js";
import { DurableFileSaver } from "./durable-checkpoint.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-checkpoint-load-");

function catchFailure(action: () => void): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("The checkpoint load failed with a non-error value.", { cause: error });
  }
  throw new Error("The checkpoint load was expected to fail.");
}

describe("durable checkpoint load failures", () => {
  it("keeps an unreadable checkpoint distinguishable from a damaged one", () => {
    const statePath = join(temporaryRoot(), "checkpoints.bin");
    mkdirSync(statePath);

    const failure = catchFailure(() => new DurableFileSaver(statePath));

    // A filesystem failure must not be reported as damaged content: the student
    // client quarantines damaged state, and quarantining an unreadable file
    // would hide a permissions incident.
    expect(failure).not.toBeInstanceOf(AgentAdapterError);
    expect(failure).toMatchObject({ code: "EISDIR" });
  });

  it("reports undecodable checkpoint content as invalid state", () => {
    const statePath = join(temporaryRoot(), "checkpoints.bin");
    writeFileSync(statePath, new Uint8Array([1, 2, 3]));

    const failure = catchFailure(() => new DurableFileSaver(statePath));

    expect(failure).toBeInstanceOf(AgentAdapterError);
    expect(failure).toMatchObject({ code: "invalid-checkpoint-state" });
  });

  it("reports an unsupported checkpoint version as invalid state", () => {
    const statePath = join(temporaryRoot(), "checkpoints.bin");
    writeFileSync(statePath, serialize({ version: 2, storage: {}, writes: {} }));

    const failure = catchFailure(() => new DurableFileSaver(statePath));

    expect(failure).toBeInstanceOf(AgentAdapterError);
    expect(failure).toMatchObject({ code: "invalid-checkpoint-state" });
  });
});
