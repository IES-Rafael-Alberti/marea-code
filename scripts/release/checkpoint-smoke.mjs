import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalCheckpoint,
  resolveCheckpoint,
  closeAgentCheckpoint,
} from "../../packages/deepagents-adapter/src/checkpoint.boundary.ts";

const scratch = mkdtempSync(join(tmpdir(), "marea-native-checkpoint-"));
try {
  const projectDirectory = join(scratch, "project");
  const storageDirectory = join(scratch, "state");
  mkdirSync(projectDirectory);
  const checkpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
  const record = { state: "in-progress", events: [] };
  await resolveCheckpoint(checkpoint).recordTurn("synthetic-session", "synthetic-turn", record);
  closeAgentCheckpoint(checkpoint);
  const reopened = createLocalCheckpoint({ projectDirectory, storageDirectory });
  assert.deepEqual(
    resolveCheckpoint(reopened).findTurn("synthetic-session", "synthetic-turn"),
    record,
  );
  const completed = { state: "completed", events: [{ type: "turn-completed" }] };
  await resolveCheckpoint(reopened).recordTurn("synthetic-session", "synthetic-turn", completed);
  closeAgentCheckpoint(reopened);
  const replaced = createLocalCheckpoint({ projectDirectory, storageDirectory });
  assert.deepEqual(
    resolveCheckpoint(replaced).findTurn("synthetic-session", "synthetic-turn"),
    completed,
  );
  closeAgentCheckpoint(replaced);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
