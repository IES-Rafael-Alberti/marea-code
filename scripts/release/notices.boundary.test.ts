import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { collectDependencyNotices } from "./notices.boundary.js";
it("collects dependency notices once across aliases, without following links outside the build workspace", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-notices-")));
  const root = join(scratch, "workspace");
  const modules = join(root, "node_modules");
  const output = join(scratch, "nested", "notices");
  try {
    mkdirSync(join(modules, "package"), { recursive: true });
    writeFileSync(join(modules, "package/LICENSE"), "MIT notice");
    writeFileSync(join(modules, "package/index.js"), "code");
    writeFileSync(join(scratch, "private.txt"), "private");
    writeFileSync(join(root, "LICENSE"), "project, not dependency");
    symlinkSync(join(modules, "package"), join(modules, "alias"));
    symlinkSync(scratch, join(modules, "outside"));
    symlinkSync(join(scratch, "private.txt"), join(modules, "NOTICE"));
    collectDependencyNotices(root, output);
    const index = JSON.parse(readFileSync(join(output, "notices.json"), "utf8")) as {
      source: string;
      file: string;
    }[];
    expect(index).toHaveLength(1);
    expect(index[0]?.source).toBe("node_modules/package/LICENSE");
    expect(readFileSync(join(output, String(index[0]?.file)), "utf8")).toBe("MIT notice");
    for (const name of ["LICENSE.md", "COPYING-THIRD-PARTY", "NOTICE_extra", "licence"])
      writeFileSync(join(modules, name), name);
    for (const name of ["notLICENSE", "LICENSEjunk", "notNOTICE.md", "NOTICE-more/ignored"]) {
      if (name.includes("/")) continue;
      writeFileSync(join(modules, name), "not a notice");
    }
    writeFileSync(join(modules, "NOTICE_\\extra"), "separator notice");
    collectDependencyNotices(root, output);
    const expandedIndex = JSON.parse(readFileSync(join(output, "notices.json"), "utf8")) as {
      source: string;
    }[];
    expect(expandedIndex).toHaveLength(6);
    expect(expandedIndex.some((entry) => entry.source === "node_modules/NOTICE_/extra")).toBe(true);
    writeFileSync(join(modules, "COPYING"), Buffer.alloc(8_388_608));
    expect(() => {
      collectDependencyNotices(root, output);
    }).not.toThrow();
    writeFileSync(join(modules, "COPYING"), Buffer.alloc(8_388_609));
    expect(() => {
      collectDependencyNotices(root, output);
    }).toThrow("size limit");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("does not collect notices from an external node_modules symlink", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-notices-link-")));
  try {
    const root = join(scratch, "workspace");
    const external = join(scratch, "outside");
    mkdirSync(root);
    mkdirSync(external);
    writeFileSync(join(external, "LICENSE"), "outside notice");
    symlinkSync(external, join(root, "node_modules"));
    const output = join(scratch, "output");
    const reads = vi.spyOn(filesystem, "readdirSync").mockClear();
    collectDependencyNotices(root, output);
    expect(reads).not.toHaveBeenCalledWith(external, expect.anything());
    expect(JSON.parse(readFileSync(join(output, "notices.json"), "utf8"))).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
