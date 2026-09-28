import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { StoredTeachingConfiguration } from "./configuration-schema.js";

export interface SaveTeachingRevision {
  readonly classId: string;
  readonly teacherId: string;
  readonly createdAt: string;
  readonly expectedVersion: string | null;
  readonly configuration: StoredTeachingConfiguration;
}

/** Every write rechecks teacher/class membership inside its transaction. */
export interface TeachingConfigurationRepository {
  requireTeacherClass(teacherId: string, classId: string): void;
  loadForTeacher(teacherId: string, classId: string): StoredTeachingConfiguration | null;
  loadForStudent(identity: AuthenticatedIdentity): StoredTeachingConfiguration | null;
  saveRevision(input: SaveTeachingRevision): StoredTeachingConfiguration;
}
