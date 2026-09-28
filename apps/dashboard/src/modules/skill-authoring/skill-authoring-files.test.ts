import { describe, expect, it, vi } from "vitest";

import { MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_FILE_BYTES } from "@marea/protocol";

import {
  createSkillAuthoringFileExchange,
  readSkillAuthoringDirectory,
  readSkillAuthoringFiles,
  type SkillAuthoringDirectoryEntry,
  type SkillAuthoringDirectorySource,
  type SkillAuthoringFileSource,
  type SkillAuthoringImportFile,
} from "./skill-authoring-files.js";

function source(bytes: Uint8Array, declaredSize = bytes.byteLength): SkillAuthoringFileSource {
  return {
    size: declaredSize,
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ),
  };
}

function text(content: string, declaredSize?: number): SkillAuthoringFileSource {
  const bytes = new TextEncoder().encode(content);
  return source(bytes, declaredSize);
}

function files(
  ...entries: readonly (readonly [string, SkillAuthoringFileSource])[]
): SkillAuthoringImportFile[] {
  return entries.map(([path, file]) => ({ path, file }));
}

function directory(
  entries: readonly SkillAuthoringDirectoryEntry[],
): SkillAuthoringDirectorySource {
  return {
    async *values() {
      await Promise.resolve();
      yield* entries;
    },
  };
}

function entry(name: string, content: string): SkillAuthoringDirectoryEntry {
  return { kind: "file", name, getFile: () => Promise.resolve(text(content)) };
}

describe("skill authoring file exchange", () => {
  it.each(["", "draft__"])("restores individual download names with prefix %s", async (prefix) => {
    const paths = ["SKILL.md", "resources/nested/lección%20.txt"] as const;
    await expect(
      readSkillAuthoringFiles(
        files(
          ...paths.map((path) => [`${prefix}${encodeURIComponent(path)}`, text(path)] as const),
        ),
      ),
    ).resolves.toEqual(paths.map((path) => ({ path, content: path })));
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", text("root")], [paths[1], text("literal")])),
    ).resolves.toEqual([
      { path: "SKILL.md", content: "root" },
      { path: paths[1], content: "literal" },
    ]);
  });

  it.each([
    "resources%2F..%2FSKILL.md",
    "%2FSKILL.md",
    "resources%5Cbad.txt",
    "resources%2Fbad%ZZ.txt",
  ])("rejects unsafe encoded download %s", async (path) => {
    await expect(readSkillAuthoringFiles(files([path, text("bad")]))).rejects.toMatchObject({
      code: "invalid-path",
      message: "Use a contained canonical skill text-file path.",
    });
  });

  it.each([true, false])("roundtrips native exported files, saved=%s", async (saved) => {
    const { createBrowserSkillAuthoringFileExchange } = await import("./skill-authoring-files.js");
    const exchange = createBrowserSkillAuthoringFileExchange();
    const downloads: SkillAuthoringImportFile[] = [];
    let blob = new Blob();
    const anchor = {
      href: "",
      download: "",
      click() {
        downloads.push({ path: anchor.download, file: blob });
      },
    };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", {
      createObjectURL(value: Blob) {
        blob = value;
        return "blob:roundtrip";
      },
      revokeObjectURL: vi.fn(),
    });
    const bundle = [
      { path: "SKILL.md", content: "# Root" },
      { path: "resources/nested/lección%20.txt", content: "á\nresource" },
    ];
    try {
      for (const file of bundle) await exchange.exportFile(file.path, file.content, saved);
      await expect(exchange.importExplicit(downloads)).resolves.toEqual(bundle);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects aliases of the same imported path", async () => {
    await expect(
      readSkillAuthoringFiles(
        files(
          ["SKILL.md", text("root")],
          ["resources/lesson.txt", text("one")],
          ["resources%2Flesson.txt", text("two")],
        ),
      ),
    ).rejects.toMatchObject({ code: "duplicate-path" });
  });

  it("bounds canonical path length before reading content", async () => {
    const path = `resources/${"a".repeat(1010)}.txt`;
    expect(path).toHaveLength(1024);
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", text("root")], [path, text("ok")])),
    ).resolves.toHaveLength(2);
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    await expect(
      readSkillAuthoringFiles(files([`resources/a${path.slice(10)}`, { size: 0, arrayBuffer }])),
    ).rejects.toMatchObject({ code: "invalid-path" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("reads a complete UTF-8 bundle and preserves relative resource paths", async () => {
    await expect(
      readSkillAuthoringFiles(
        files(
          ["SKILL.md", text("# Guide")],
          ["resources/lesson.txt", text("á\nlesson")],
          ["resources/data.json", text('{"ok":true}')],
        ),
      ),
    ).resolves.toEqual([
      { path: "SKILL.md", content: "# Guide" },
      { path: "resources/lesson.txt", content: "á\nlesson" },
      { path: "resources/data.json", content: '{"ok":true}' },
    ]);
    await expect(
      readSkillAuthoringFiles(files(["folder/SKILL.md", text("# Root")])),
    ).resolves.toEqual([{ path: "SKILL.md", content: "# Root" }]);
    await expect(
      readSkillAuthoringFiles(
        files(["folder/SKILL.md", text("# Root")], ["folder/resources/lesson.txt", text("lesson")]),
      ),
    ).resolves.toEqual([
      { path: "SKILL.md", content: "# Root" },
      { path: "resources/lesson.txt", content: "lesson" },
    ]);
    await expect(
      readSkillAuthoringFiles(
        files(
          ["folder/SKILL.md", text("# Root")],
          ["folder./resources/other.txt", text("other")],
          ["folderC:/resources/drive.txt", text("drive")],
        ),
      ),
    ).resolves.toEqual([
      { path: "SKILL.md", content: "# Root" },
      { path: "resources/other.txt", content: "other" },
      { path: "resources/drive.txt", content: "drive" },
    ]);
  });

  it.each([
    ["", "invalid-path"],
    ["./SKILL.md", "invalid-path"],
    ["../SKILL.md", "invalid-path"],
    ["resources/../SKILL.md", "invalid-path"],
    ["resources\\lesson.txt", "invalid-path"],
    ["folder\\resources/SKILL.md", "invalid-path"],
    ["folder\0/SKILL.md", "invalid-path"],
    ["/SKILL.md", "invalid-path"],
    ["C:/SKILL.md", "invalid-path"],
    ["resources/.hidden.txt", "invalid-path"],
    ["resources/lesson.exe", "invalid-path"],
  ] as const)("rejects unsafe path %s", async (path, code) => {
    await expect(readSkillAuthoringFiles(files([path, text("text")]))).rejects.toMatchObject({
      code,
      message: "Use a contained canonical skill text-file path.",
      name: "SkillAuthoringFileError",
    });
  });

  it("rejects duplicate, missing-main-file, empty and oversized bundles", async () => {
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", text("one")], ["folder/SKILL.md", text("two")])),
    ).rejects.toMatchObject({
      code: "duplicate-path",
      message: "Skill file paths must be unique.",
    });
    await expect(
      readSkillAuthoringFiles(files(["resources/lesson.txt", text("lesson")])),
    ).rejects.toMatchObject({
      code: "invalid-path",
      message: "A complete skill must contain SKILL.md.",
    });
    await expect(readSkillAuthoringFiles([])).rejects.toMatchObject({
      code: "too-many-files",
      message: "A skill must contain between one and 256 files.",
    });
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", text("small", MAX_SKILL_FILE_BYTES + 1)])),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "A skill file exceeds the 512 KiB limit.",
    });
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", source(new Uint8Array([1]), Number.NaN)])),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "A skill file exceeds the 512 KiB limit.",
    });
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", source(new Uint8Array([1]), -1)])),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "A skill file exceeds the 512 KiB limit.",
    });
    await expect(
      readSkillAuthoringFiles(
        files(
          ["SKILL.md", text("# Guide")],
          ["resources/actual.txt", source(new Uint8Array(MAX_SKILL_FILE_BYTES + 1), 1)],
        ),
      ),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "A skill file exceeds the 512 KiB limit.",
    });
  });

  it("rejects malformed UTF-8 and NUL text", async () => {
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", source(new Uint8Array([0xc3, 0x28]))])),
    ).rejects.toMatchObject({
      code: "invalid-text",
      message: "Skill files must contain valid UTF-8 text.",
    });
    await expect(readSkillAuthoringFiles(files(["SKILL.md", text("a\0b")]))).rejects.toMatchObject({
      code: "invalid-text",
      message: "Skill files must be well-formed text without NUL bytes.",
    });
    await expect(
      readSkillAuthoringFiles([
        {
          path: "SKILL.md",
          file: { size: 3, arrayBuffer: () => Promise.reject(new Error("read")) },
        },
      ]),
    ).rejects.toMatchObject({
      code: "invalid-text",
      message: "A selected file could not be read.",
    });
  });

  it("enforces the complete file count and bundle byte bounds", async () => {
    const many = Array.from(
      { length: 257 },
      (_, index) =>
        [index === 0 ? "SKILL.md" : `resources/file-${String(index)}.txt`, text("x")] as const,
    );
    await expect(
      readSkillAuthoringFiles(many.map(([path, file]) => ({ path, file }))),
    ).rejects.toMatchObject({
      code: "too-many-files",
      message: "A skill must contain between one and 256 files.",
    });

    const fullFile = "x".repeat(MAX_SKILL_FILE_BYTES);
    await expect(
      readSkillAuthoringFiles(
        files(["SKILL.md", text("", 0)], ["resources/max.txt", text(fullFile)]),
      ),
    ).resolves.toHaveLength(2);
    await expect(
      readSkillAuthoringFiles(files(["SKILL.md", text(fullFile)])),
    ).resolves.toHaveLength(1);
    const exactBundle = Array.from(
      { length: 16 },
      (_, index) =>
        [
          index === 0 ? "SKILL.md" : `resources/exact-${String(index)}.txt`,
          text(fullFile),
        ] as const,
    );
    await expect(
      readSkillAuthoringFiles(exactBundle.map(([path, file]) => ({ path, file }))),
    ).resolves.toHaveLength(16);
    const overBundle = Array.from(
      { length: 17 },
      (_, index) =>
        [index === 0 ? "SKILL.md" : `resources/full-${String(index)}.txt`, text(fullFile)] as const,
    );
    await expect(
      readSkillAuthoringFiles(overBundle.map(([path, file]) => ({ path, file }))),
    ).rejects.toMatchObject({
      code: "too-large",
      message: "The complete skill exceeds the 8 MiB limit.",
    });
    expect(MAX_SKILL_BUNDLE_BYTES).toBeLessThan(17 * MAX_SKILL_FILE_BYTES);
  });

  it("walks nested directory sources and handles unavailable entries", async () => {
    const nested = directory([entry("lesson.txt", "lesson")]);
    const root = directory([
      entry("SKILL.md", "# Guide"),
      {
        kind: "directory",
        name: "resources",
        values: () => nested.values(),
      },
    ]);
    await expect(readSkillAuthoringDirectory(root)).resolves.toEqual([
      { path: "SKILL.md", content: "# Guide" },
      { path: "resources/lesson.txt", content: "lesson" },
    ]);
    const wrappedRoot = directory([
      {
        kind: "directory",
        name: "folder",
        values: () => directory([entry("SKILL.md", "# Wrapped")]).values(),
      },
    ]);
    await expect(readSkillAuthoringDirectory(wrappedRoot)).resolves.toEqual([
      { path: "SKILL.md", content: "# Wrapped" },
    ]);
    await expect(
      readSkillAuthoringDirectory(directory([{ kind: "file", name: "SKILL.md" }])),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "A selected file could not be opened.",
    });
    await expect(
      readSkillAuthoringDirectory(directory([{ kind: "directory", name: "resources" }])),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "A selected directory could not be opened.",
    });
    await expect(readSkillAuthoringDirectory(directory([]))).rejects.toMatchObject({
      code: "too-many-files",
      message: "A skill must contain between one and 256 files.",
    });
    await expect(
      readSkillAuthoringDirectory({
        values: async function* () {
          await Promise.resolve();
          yield* [] as SkillAuthoringDirectoryEntry[];
          throw new Error("directory read");
        },
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The selected directory could not be read.",
    });
    const exactEntries = Array.from({ length: 256 }, (_, index) =>
      entry(index === 0 ? "SKILL.md" : `resources/file-${String(index)}.txt`, "x"),
    );
    await expect(readSkillAuthoringDirectory(directory(exactEntries))).resolves.toHaveLength(256);
    const manyEntries = Array.from({ length: 257 }, (_, index) =>
      entry(`file-${String(index)}.txt`, "x"),
    );
    await expect(readSkillAuthoringDirectory(directory(manyEntries))).rejects.toMatchObject({
      code: "too-many-files",
      message: "A skill cannot contain more than 256 files.",
    });
  });

  it("supports cancellation and injected export without browser globals", async () => {
    const chooseDirectory = vi
      .fn<() => Promise<SkillAuthoringDirectorySource | null>>()
      .mockResolvedValue(null);
    const downloadFile = vi
      .fn<(fileName: string, content: string, saved: boolean) => Promise<void>>()
      .mockResolvedValue(undefined);
    const exchange = createSkillAuthoringFileExchange({ chooseDirectory, downloadFile });
    await expect(exchange.importDirectory()).resolves.toBeNull();
    await expect(exchange.importExplicit(files(["SKILL.md", text("# Guide")]))).resolves.toEqual([
      { path: "SKILL.md", content: "# Guide" },
    ]);
    await exchange.exportFile("resources/lesson.txt", "lesson", false);
    expect(chooseDirectory).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith("resources/lesson.txt", "lesson", false);
  });

  it("walks native-shaped nested directory handles through values", async () => {
    const nativeNested = directory([entry("lesson.txt", "lesson")]);
    const nativeRoot = directory([
      entry("SKILL.md", "# Native"),
      {
        kind: "directory",
        name: "resources",
        values: () => nativeNested.values(),
      },
    ]);
    await expect(readSkillAuthoringDirectory(nativeRoot)).resolves.toEqual([
      { path: "SKILL.md", content: "# Native" },
      { path: "resources/lesson.txt", content: "lesson" },
    ]);
  });

  it("rejects native entries with an unknown kind", async () => {
    await expect(
      readSkillAuthoringDirectory(directory([{ kind: "other", name: "unknown" }])),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "A selected directory entry has an invalid kind.",
    });
  });

  it("uses the native browser adapter only when invoked and handles browser failures", async () => {
    const nativeExchange = await import("./skill-authoring-files.js").then(
      ({ createBrowserSkillAuthoringFileExchange }) => createBrowserSkillAuthoringFileExchange(),
    );
    await expect(nativeExchange.importDirectory()).rejects.toMatchObject({
      code: "unavailable",
      message: "Directory selection is unavailable in this browser.",
    });
    await expect(nativeExchange.exportFile("SKILL.md", "text", true)).rejects.toMatchObject({
      code: "unavailable",
      message: "File export is unavailable in this browser.",
    });

    const nativeNested = directory([entry("lesson.txt", "lesson")]);
    const root = directory([
      entry("SKILL.md", "# Native"),
      {
        kind: "directory",
        name: "resources",
        values: () => nativeNested.values(),
      },
    ]);
    vi.stubGlobal("showDirectoryPicker", vi.fn().mockResolvedValue(root));
    await expect(nativeExchange.importDirectory()).resolves.toEqual([
      { path: "SKILL.md", content: "# Native" },
      { path: "resources/lesson.txt", content: "lesson" },
    ]);
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError")),
    );
    await expect(nativeExchange.importDirectory()).resolves.toBeNull();
    vi.stubGlobal("showDirectoryPicker", vi.fn().mockRejectedValue(new Error("denied")));
    await expect(nativeExchange.importDirectory()).rejects.toMatchObject({
      code: "unavailable",
      message: "The selected directory could not be read.",
    });

    const anchor = { click: vi.fn(), download: "", href: "" };
    const createElement = vi.fn(() => anchor);
    const document = { createElement } as never as Document;
    vi.stubGlobal("document", document);
    vi.stubGlobal("URL", undefined);
    await expect(nativeExchange.exportFile("SKILL.md", "missing-url", true)).rejects.toMatchObject({
      code: "unavailable",
      message: "File export is unavailable in this browser.",
    });
    vi.unstubAllGlobals();
    let blob: Blob | undefined;
    const createObjectURL = vi.fn((value: Blob) => {
      blob = value;
      return "blob:test";
    });
    const revokeObjectURL = vi.fn();
    const urlApi = { createObjectURL, revokeObjectURL } as never as typeof URL;
    vi.stubGlobal("document", document);
    vi.stubGlobal("URL", urlApi);
    await nativeExchange.exportFile("resources/lesson.txt", "lesson", false);
    expect(anchor.download).toBe("draft__resources%2Flesson.txt");
    expect(decodeURIComponent(anchor.download.slice("draft__".length))).toBe(
      "resources/lesson.txt",
    );
    await nativeExchange.exportFile("SKILL.md", "saved", true);
    expect(anchor.download).toBe("SKILL.md");
    expect(anchor.click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(createElement).toHaveBeenNthCalledWith(1, "a");
    expect(blob?.type).toBe("text/plain;charset=utf-8");
    await expect(blob?.text()).resolves.toBe("saved");
    vi.unstubAllGlobals();
  });
});
