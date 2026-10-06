import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bootstrapScript,
  findCandidates,
  includeSignatureTool,
  preparePreviewPublication,
} from "./preview-publish.js";
import { manifestSchema, sha256 } from "./manifest.js";
let scratch: string;
const version = "0.1.0-preview.1";
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-publication-")));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function candidate(component: string, target: string, tool = true) {
  const root = join(scratch, `${component}-${target}`);
  mkdirSync(root);
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  const files = [`marea-install${suffix}`, ...(tool ? [`cosign${suffix}`] : []), "LICENSE"].map(
    (path) => ({
      path,
      executable: path !== "LICENSE",
      sha256: sha256(Buffer.from(path)),
    }),
  );
  for (const file of files) writeFileSync(join(root, file.path), file.path);
  const manifest = manifestSchema.parse({
    format: 1,
    version,
    component,
    target,
    bun: "1.4.2",
    opentui: "0.5.10",
    commit: "a".repeat(40),
    files,
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "manifest.sigstore.json"), "synthetic signature");
  return { root, manifest };
}

it("packages the native verifier, license and extra inventory before signing", () => {
  for (const target of ["linux-x64", "win32-x64"]) {
    const f = candidate("student", target, false);
    const binary = join(scratch, "tool");
    const license = join(scratch, "tool-license");
    writeFileSync(binary, "verifier");
    writeFileSync(license, "Apache-2.0 license");
    writeFileSync(join(f.root, "cosign.sbom.cdx.json"), "inventory");
    const reads = vi.spyOn(filesystem, "readFileSync").mockClear();
    const directories = vi.spyOn(filesystem, "mkdirSync").mockClear();
    includeSignatureTool(f.root, binary, license);
    expect(reads).toHaveBeenCalledWith(join(f.root, "manifest.json"), "utf8");
    expect(directories).toHaveBeenCalledWith(join(f.root, "licenses"), { recursive: true });
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(f.root, "manifest.json"), "utf8")),
    );
    expect(manifest).toMatchSnapshot(`packaged verifier ${target}`);
    expect(manifest.files).toContainEqual({
      path: target === "win32-x64" ? "cosign.exe" : "cosign",
      executable: true,
      sha256: sha256(Buffer.from("verifier")),
    });
    expect(manifest.files).toContainEqual({
      path: "licenses/cosign-LICENSE",
      executable: false,
      sha256: sha256(Buffer.from("Apache-2.0 license")),
    });
    expect(manifest.files).toContainEqual({
      path: "cosign.sbom.cdx.json",
      executable: false,
      sha256: sha256(Buffer.from("inventory")),
    });
    expect(manifest.files.some((entry) => entry.path === "manifest.sigstore.json")).toBe(false);
    expect(manifest.files.find((file) => file.path === "LICENSE")?.executable).toBe(false);
    expect(
      manifest.files.find(
        (file) => file.path === `marea-install${target.startsWith("win32") ? ".exe" : ""}`,
      )?.executable,
    ).toBe(true);
    expect(() => {
      includeSignatureTool(f.root, binary, license);
    }).toThrow();
  }
});

it("requires a complete matching matrix and produces content-addressed files and both bootstrap scripts", () => {
  const candidates = ["darwin-arm64", "linux-x64", "win32-x64"].flatMap((target) => [
    candidate("student", target),
    candidate("server", target),
  ]);
  candidates.push(candidate("student", "linux-arm64"), candidate("student", "win32-arm64"));
  const roots = candidates.map((entry) => entry.root);
  writeFileSync(join(scratch, "unrelated.txt"), "unrelated");
  expect(findCandidates(scratch).sort()).toEqual([...roots].sort());
  for (let index = 0; index < roots.length; index++)
    expect(() => {
      preparePreviewPublication(
        roots.filter((_, i) => i !== index),
        join(scratch, `missing-${String(index)}`),
        "school/marea",
        version,
      );
    }).toThrow("complete matching");
  expect(() => {
    preparePreviewPublication(roots, join(scratch, "bad-repo"), "!school/marea", version);
  }).toThrow("Invalid");
  expect(existsSync(join(scratch, "bad-repo"))).toBe(false);
  expect(() => {
    preparePreviewPublication(roots, join(scratch, "bad-version"), "school/marea", "invalid");
  }).toThrow("Invalid");
  expect(() => {
    preparePreviewPublication(roots.slice(1), join(scratch, "missing"), "school/marea", version);
  }).toThrow("complete matching");
  expect(() => {
    preparePreviewPublication(roots, join(scratch, "wrong"), "school/marea", "0.1.0-preview.2");
  }).toThrow("complete matching");
  const first = candidates[0];
  if (!first) throw new Error("fixture missing");
  const saved = readFileSync(join(first.root, "manifest.json"));
  writeFileSync(
    join(first.root, "manifest.json"),
    JSON.stringify({ ...first.manifest, version: "0.1.0-preview.2" }),
  );
  expect(() => {
    preparePreviewPublication(roots, join(scratch, "mixed"), "school/marea", version);
  }).toThrow("complete matching");
  writeFileSync(join(first.root, "manifest.json"), saved);
  writeFileSync(join(first.root, "LICENSE"), "tampered");
  expect(() => {
    preparePreviewPublication(roots, join(scratch, "tampered"), "school/marea", version);
  }).toThrow();
  writeFileSync(join(first.root, "LICENSE"), "LICENSE");
  const reads = vi.spyOn(filesystem, "readFileSync").mockClear();
  const copies = vi.spyOn(filesystem, "cpSync").mockClear();
  const output = join(scratch, "publication");
  preparePreviewPublication(roots, output, "school/marea", version);
  for (const script of ["install.sh", "install.ps1"])
    expect(readFileSync(join(output, script), "utf8")).toMatchSnapshot(script);
  const names = readdirSync(output);
  expect(copies.mock.calls).toHaveLength(21);
  for (const root of roots) expect(reads).toHaveBeenCalledWith(join(root, "manifest.json"), "utf8");
  expect(names.filter((name) => name.endsWith(".manifest.json"))).toHaveLength(8);
  expect(() => {
    preparePreviewPublication(roots, output, "school/marea", version);
  }).toThrow();
  expect(statSync(output).isDirectory()).toBe(true);
  expect(names.filter((name) => name.startsWith("sha256-"))).toHaveLength(5);
  expect(readFileSync(join(output, "install.sh"), "utf8")).toContain("--repository 'school/marea'");
  expect(readFileSync(join(output, "install.ps1"), "utf8")).toContain("Get-FileHash");
  expect(spawnSync("sh", ["-n", join(output, "install.sh")]).status).toBe(0);
  const denied = spawnSync("sh", [join(output, "install.sh"), "invalid"], { encoding: "utf8" });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("Unsupported native platform");
});

it("does not generate bootstrap scripts without both trusted programs", () => {
  const f = candidate("student", "linux-x64", false);
  expect(() => bootstrapScript("school/marea", version, [f.manifest], false)).toThrow(
    "Bootstrap programs missing",
  );
  expect(() =>
    bootstrapScript(
      "school/marea",
      version,
      [{ ...f.manifest, files: [{ path: "cosign", executable: true, sha256: "a".repeat(64) }] }],
      false,
    ),
  ).toThrow("Bootstrap programs missing");
  expect(bootstrapScript("school/marea", version, [], false)).toContain(
    "Unsupported native platform",
  );
});
