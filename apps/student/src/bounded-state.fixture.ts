import type { StudentState } from "./contracts.js";
import { parseStudentState } from "./filesystem.boundary.js";
import { MemoryStateStore } from "./student.fixture.js";

/** A state store that enforces the same bounds as the file on disk. */
export class BoundedStateStore extends MemoryStateStore {
  override async save(state: StudentState): Promise<void> {
    await super.save(parseStudentState(JSON.parse(JSON.stringify(state))));
  }
}
