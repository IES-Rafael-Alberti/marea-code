import { expect, it } from "vitest";
import {
  manifestSchema,
  releaseVersion,
  selectRelease,
  sha256,
  signingIdentity,
  target,
} from "./manifest.js";

function manifest(paths = ["marea"]) {
  return {
    format: 1,
    version: "12.23.34-preview.15",
    component: "student",
    target: "darwin-arm64",
    bun: "1.4.0",
    opentui: "0.5.10",
    commit: "a".repeat(40),
    files: paths.map((path) => ({ path, sha256: "b".repeat(64), executable: true })),
  };
}
it("accepts multi-digit versions and only complete bounded version strings", () => {
  for (const value of ["0.0.0", "12.23.34", "12.23.34-preview.15", "1.2.3-RC-4"]) {
    expect(releaseVersion.parse(value)).toBe(value);
  }
  for (const value of ["v1.2.3", "1.2.3/evil", "1.2", "1.2.3-", "1.2.3-!", " 1.2.3", "1.2.3 "]) {
    expect(releaseVersion.safeParse(value).success).toBe(false);
  }
});
it("permits exactly the agreed client/server target matrix", () => {
  const targets = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
  expect(target.options).toEqual(targets);
  for (const selected of targets) {
    expect(manifestSchema.parse({ ...manifest(), target: selected }).target).toBe(selected);
    const server = manifestSchema.safeParse({
      ...manifest(),
      target: selected,
      component: "server",
    });
    if (selected === "linux-arm64" || selected === "win32-arm64") {
      expect(server.success).toBe(false);
      if (!server.success)
        expect(server.error.issues).toEqual([
          { code: "custom", message: "Unsupported server target", path: [] },
        ]);
    } else {
      expect(server.success).toBe(true);
    }
  }
  for (const selected of ["darwin-x64", "linux-arm", "linux-x64-musl", "win32-ia32", ""]) {
    expect(manifestSchema.safeParse({ ...manifest(), target: selected }).success).toBe(false);
  }
});
it("rejects cross-platform path aliases while retaining legitimate similar names", () => {
  for (const path of [
    ".",
    "..",
    "a/../b",
    "a/./b",
    "CON",
    "con.txt",
    "prn",
    "aux",
    "nul",
    "com1",
    "com9.txt",
    "lpt1",
    "lpt9.txt",
    "a.",
    "a//b",
    "a/",
    "\\server",
    "x:y",
  ]) {
    expect(manifestSchema.safeParse(manifest([path])).success, path).toBe(false);
  }
  for (const path of [
    "falcon",
    "xcon.txt",
    "compile",
    "com0",
    "com10",
    "lpt0",
    "lpt10",
    "auxiliary",
    "..data",
    "assets/index-AZ19.js",
  ]) {
    expect(manifestSchema.parse(manifest([path])).files[0]?.path).toBe(path);
  }
});
it("rejects case collisions and file-directory conflicts with the actionable issue", () => {
  for (const { paths, conflict } of [
    { paths: ["Alpha", "alpha"], conflict: "alpha" },
    { paths: ["a", "A/child"], conflict: "a" },
    { paths: ["A/child", "a"], conflict: "a" },
    { paths: ["same", "same"], conflict: "same" },
  ]) {
    const parsed = manifestSchema.safeParse(manifest(paths));
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toEqual([
        { code: "custom", message: `Duplicate or conflicting paths: ${conflict}`, path: [] },
      ]);
  }
  expect(
    manifestSchema.parse(manifest(["a", "ab", "a-b", "ac/child", "deep/a/leaf"])).files,
  ).toHaveLength(5);
  expect(manifestSchema.safeParse(manifest(["deep/a", "deep/a/leaf"])).success).toBe(false);
  expect(manifestSchema.safeParse(manifest(["a-b", "a", "a/leaf"])).success).toBe(false);
});
it("requires exact commit/digest lengths and strict manifest/file objects", () => {
  for (const commit of [
    `x${"a".repeat(40)}`,
    `${"a".repeat(40)}x`,
    "a".repeat(39),
    "a".repeat(41),
    "G".repeat(40),
  ]) {
    expect(manifestSchema.safeParse({ ...manifest(), commit }).success).toBe(false);
  }
  for (const digest of [
    `x${"a".repeat(64)}`,
    `${"a".repeat(64)}x`,
    "a".repeat(63),
    "a".repeat(65),
    "G".repeat(64),
  ]) {
    expect(
      manifestSchema.safeParse({
        ...manifest(),
        files: [{ path: "marea", executable: true, sha256: digest }],
      }).success,
    ).toBe(false);
  }
  expect(manifestSchema.safeParse({ ...manifest(), extra: true }).success).toBe(false);
  expect(
    manifestSchema.safeParse({
      ...manifest(),
      files: [{ path: "marea", executable: true, sha256: "a".repeat(64), extra: true }],
    }).success,
  ).toBe(false);
  expect(manifestSchema.safeParse(manifest([])).success).toBe(false);
  expect(
    manifestSchema.safeParse(
      manifest(Array.from({ length: 10001 }, (_, index) => `file-${String(index)}`)),
    ).success,
  ).toBe(false);
  expect(sha256(Buffer.from("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
it("pins the exact trusted repository/ref rather than accepting matching substrings", () => {
  for (const repository of ["!owner/repo", "owner/repo!", "owner/repo/extra", "owner", ""]) {
    expect(() => signingIdentity(repository, "refs/tags/v1.2.3")).toThrow(
      "Explicit trusted repository and ref required",
    );
  }
  for (const ref of ["xrefs/heads/main", "refs/heads/main!", "refs/pull/12", "main", ""]) {
    expect(() => signingIdentity("owner/repo", ref)).toThrow(
      "Explicit trusted repository and ref required",
    );
  }
  expect(signingIdentity("owner/repo", "refs/heads/topic/x")).toBe(
    "https://github.com/owner/repo/.github/workflows/native-release-candidate.yml@refs/heads/topic/x",
  );
  expect(signingIdentity("owner/repo", "refs/tags/v12.23.34")).toBe(
    "https://github.com/owner/repo/.github/workflows/native-release-candidate.yml@refs/tags/v12.23.34",
  );
});
it("checks every explicit selection field and preserves the accepted manifest", () => {
  const value = manifest();
  expect(selectRelease(value, value.version, value.component, value.target)).toEqual(value);
  for (const [version, selected, platform] of [
    ["0.0.0", value.component, value.target],
    [value.version, "server", value.target],
    [value.version, value.component, "linux-x64"],
  ]) {
    expect(() => selectRelease(value, version ?? "", selected ?? "", platform ?? "")).toThrow(
      "Release selection mismatch",
    );
  }
});
