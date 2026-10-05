/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";

import { SelectingServer } from "./class-selection.fixture.js";
import type { ClassPreferenceStore } from "./contracts.js";
import { SESSION_TOKEN, createFixtureController } from "./student.fixture.js";

const CLASSES = [
  { classId: "class:one", displayName: "Databases" },
  { classId: "class:two", displayName: "Programming" },
] as const;

class MemoryClassPreference implements ClassPreferenceStore {
  readonly saved: string[] = [];
  constructor(private remembered: string | null = null) {}

  async load(): Promise<string | null> {
    return this.remembered;
  }

  async save(classId: string): Promise<void> {
    this.saved.push(classId);
    this.remembered = classId;
  }
}

function fixture(
  classPreference?: ClassPreferenceStore,
  classes: typeof CLASSES | readonly [(typeof CLASSES)[0]] = CLASSES,
) {
  const server = new SelectingServer(classes);
  return {
    ...createFixtureController({
      server,
      ...(classPreference === undefined ? {} : { classPreference }),
    }),
    server,
  };
}

/** Starts without asking the student and binds the session to the Databases class. */
async function expectSilentDatabasesChoice(test: ReturnType<typeof fixture>) {
  await expect(test.controller.start("Project One")).resolves.toMatchObject({
    classroomDisplayName: "Databases",
  });
  expect(test.studentInterface.classChoices).toEqual([]);
  expect(test.server.selections.map((request) => request.classId)).toEqual(["class:one"]);
}

describe("student sessions in several classes", () => {
  it("asks which class to work in and binds the session to the answer", async () => {
    const preference = new MemoryClassPreference();
    const test = fixture(preference);
    await expect(test.controller.start("Project One")).resolves.toMatchObject({
      classroomDisplayName: "Programming",
    });
    expect(test.studentInterface.classChoices).toEqual([CLASSES]);
    expect(test.server.selections).toEqual([
      expect.objectContaining({
        kind: "class-select",
        classId: "class:two",
        protocolVersion: "0.1",
      }),
    ]);
    expect(preference.saved).toEqual(["class:two"]);
  });

  it("reuses this folder's remembered class while the student still belongs to it", async () => {
    await expectSilentDatabasesChoice(fixture(new MemoryClassPreference("class:one")));
  });

  it("asks again when the remembered class is no longer available", async () => {
    const test = fixture(new MemoryClassPreference("class:gone"));
    await test.controller.start("Project One");
    expect(test.studentInterface.classChoices).toHaveLength(1);
  });

  it("chooses a single available class without asking or remembering preferences", async () => {
    await expectSilentDatabasesChoice(fixture(undefined, [CLASSES[0]]));
  });

  it("signs in again when a stored session can no longer choose its class", async () => {
    const preference = new MemoryClassPreference();
    const test = fixture(preference);
    test.credentials.token = SESSION_TOKEN;
    test.server.rejectSelection = true;
    await test.controller.start("Project One");
    expect(test.credentials.clears).toBe(1);
    expect(test.studentInterface.authenticationReasons).toEqual(["rejected"]);
    expect(test.server.selections).toHaveLength(2);
    expect(preference.saved).toEqual(["class:two"]);
  });

  it("rejects a new session whose class selection is refused", async () => {
    const test = fixture();
    test.server.rejectSelection = true;
    await expect(test.controller.start("Project One")).rejects.toThrow(
      "The new student session was rejected.",
    );
  });
});
