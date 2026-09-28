import { expect, it } from "vitest";

import type {
  TeachingActions,
  TeachingClientFailure,
  TeachingProblem,
} from "./teaching-contracts.js";
import {
  teachingClientFixture,
  teachingClassesFixture,
  teachingCatalogFixture,
  teachingPropertiesFixture,
  teachingReadFixture,
  teachingSettingsFixture,
  teachingStateFixture,
} from "./teaching.fixture.js";

it("shares typed client, controller and view fixtures without requiring sibling implementations", async () => {
  const client = teachingClientFixture();
  const signal = new AbortController().signal;
  expect(await client.classes(null, signal)).toEqual(teachingClassesFixture);
  expect(await client.read("class:one", signal)).toEqual(teachingReadFixture);
  expect(await client.catalog("class:one", null, signal)).toEqual(teachingCatalogFixture);
  expect(
    (await client.save("class:one", "revision:one", teachingSettingsFixture, signal)).configuration,
  ).toEqual(teachingReadFixture.configuration);
  const actions: TeachingActions = {
    loadClasses: () => Promise.resolve(),
    selectClass: () => Promise.resolve(),
    confirmClassSwitch: () => Promise.resolve(),
    edit: () => undefined,
    save: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    acceptReload: () => undefined,
  };
  const properties = teachingPropertiesFixture(actions);
  expect(properties.controller).toBe(actions);
  expect(properties.locale).toBe("en");
  expect(properties.state).toEqual(teachingStateFixture());
  const code: TeachingProblem = "uncertain";
  const failure: TeachingClientFailure = Object.assign(new Error("Save outcome unknown"), { code });
  expect(teachingStateFixture({ problem: failure.code }).problem).toBe("uncertain");
});
