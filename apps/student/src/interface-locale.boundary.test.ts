import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createStudentLanguagePreferenceStore,
  parseLanguageArguments,
  resolveStudentLocale,
  systemLocaleCandidates,
} from "./interface-locale.boundary.js";

describe("student interface locale boundary", () => {
  it("removes --lang without changing stable commands or paths", () => {
    expect(parseLanguageArguments(["--lang", "eu", "--no-mouse"]).arguments).toEqual([
      "--no-mouse",
    ]);
    expect(
      parseLanguageArguments(["--lang=en", "feedback", "--ack", "notice:one"]).preference,
    ).toBe("en");
    expect(parseLanguageArguments(["--lang", "fr"]).invalid).toBe("fr");
    expect(parseLanguageArguments(["--lang=eu"]).preference).toBe("eu");
    expect(parseLanguageArguments(["--lang=fr"]).invalid).toBe("fr");
    expect(parseLanguageArguments(new Array<string>(1)).arguments).toEqual([]);
  });

  it("rejects missing and repeated language overrides at the argument boundary", () => {
    expect(parseLanguageArguments(["--lang"]).invalid).toBe("");
    expect(parseLanguageArguments(["--lang", "en", "--lang=eu"]).invalid).toBe("eu");
    expect(parseLanguageArguments(["--lang", "en", "--lang", "eu"]).invalid).toBe("eu");
    expect(parseLanguageArguments([undefined, "--lang", "en", "feedback"])).toEqual({
      arguments: ["feedback"],
      preference: "en",
      invalid: undefined,
    });
  });

  it("uses system variables in the documented order and normalizes them", () => {
    expect(
      systemLocaleCandidates({
        LC_ALL: " \t ",
        LC_MESSAGES: "eu_ES.UTF-8@modern",
        LANG: "en_US.UTF-8",
      }),
    ).toEqual(["eu_ES.UTF-8@modern", "en_US.UTF-8"]);
    expect(
      resolveStudentLocale({
        commandLine: "automatic",
        environment: "en",
        saved: "eu",
        system: ["C", "eu_ES.UTF-8"],
      }),
    ).toMatchObject({
      locale: "eu",
      preference: "automatic",
    });
    expect(
      resolveStudentLocale({
        commandLine: undefined,
        environment: undefined,
        saved: "eu",
        system: ["es_ES"],
      }).locale,
    ).toBe("eu");
    expect(
      resolveStudentLocale({
        commandLine: undefined,
        environment: undefined,
        saved: "broken",
        system: ["C", "POSIX"],
      }).locale,
    ).toBe("es");
  });

  it("preserves unrelated personal settings and recovers corrupt language values", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ theme: "dark", "marea.interface-language.v1": "broken" }),
    );
    const store = createStudentLanguagePreferenceStore(root);
    await expect(store.load()).resolves.toBeNull();
    await store.save("eu");
    await expect(store.load()).resolves.toBe("eu");
    const settingsText = await readFile(join(root, "settings.json"), "utf8");
    expect(JSON.parse(settingsText)).toEqual({
      theme: "dark",
      "marea.interface-language.v1": "eu",
    });
  });

  it("keeps a corrupt settings document recoverable without throwing on read", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-corrupt-"));
    await writeFile(join(root, "settings.json"), "not-json");
    await expect(createStudentLanguagePreferenceStore(root).load()).resolves.toBeNull();
  });

  it("uses a fresh settings file when no personal settings exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-fresh-"));
    const store = createStudentLanguagePreferenceStore(root);
    await expect(store.load()).resolves.toBeNull();
    await store.save("en");
    await expect(store.load()).resolves.toBe("en");
  });

  it("preserves JSON keys that overlap object prototype names", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-keys-"));
    const path = join(root, "settings.json");
    await writeFile(path, '{"__proto__":{"retained":true},"constructor":"personal"}');
    const store = createStudentLanguagePreferenceStore(root);
    await expect(store.load()).resolves.toBeNull();
    await store.save("eu");
    const content = await readFile(path, "utf8");
    expect(content).toContain('"__proto__":{"retained":true}');
    expect(content).toContain('"constructor":"personal"');
    await expect(store.load()).resolves.toBe("eu");
  });

  it("ignores a non-string persisted preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-number-"));
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ "marea.interface-language.v1": 42 }),
    );
    await expect(createStudentLanguagePreferenceStore(root).load()).resolves.toBeNull();
  });

  it.each(["[]", "null", "42", '"settings"', "true"])(
    "rejects non-object settings %s without overwriting them",
    async (content) => {
      const root = await mkdtemp(join(tmpdir(), "marea-language-array-"));
      await writeFile(join(root, "settings.json"), content);
      const store = createStudentLanguagePreferenceStore(root);
      await expect(store.load()).resolves.toBeNull();
      await expect(store.save("en")).rejects.toThrow("not a JSON object");
      await expect(readFile(join(root, "settings.json"), "utf8")).resolves.toBe(content);
    },
  );

  it("reports a persistence failure without changing the in-memory contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-language-write-failure-"));
    const file = join(root, "not-a-directory");
    await writeFile(file, "reserved");
    await expect(createStudentLanguagePreferenceStore(file).save("en")).rejects.toBeInstanceOf(
      Error,
    );
  });
});
