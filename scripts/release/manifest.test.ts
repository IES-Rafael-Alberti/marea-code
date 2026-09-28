import { expect, it } from "vitest";
import { manifestSchema, selectRelease, sha256, signingIdentity } from "./manifest.js";
const valid = {
  format: 1,
  version: "1.2.3",
  component: "student",
  target: "win32-arm64",
  bun: "1.4.0",
  opentui: "0.5.10",
  commit: "a".repeat(40),
  files: [{ path: "marea.exe", sha256: "b".repeat(64), executable: true }],
};
it("validates portable closed manifests and explicit trusted identity", () => {
  expect(selectRelease(valid, "1.2.3", "student", "win32-arm64")).toEqual(valid);
  for (const path of [
    "..",
    ".",
    "../bad",
    "x/../bad",
    "C:/file",
    "nul.txt",
    "lpt9",
    "trailing.",
    "a\\b",
    "a:b",
  ])
    expect(
      manifestSchema.safeParse({ ...valid, files: [{ ...valid.files[0], path }] }).success,
    ).toBe(false);
  expect(manifestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...valid, component: "server" }).success).toBe(false);
  expect(signingIdentity("owner/repository", "refs/tags/v1.2.3")).toBe(
    "https://github.com/owner/repository/.github/workflows/native-release-candidate.yml@refs/tags/v1.2.3",
  );
  expect(sha256(Buffer.from("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
