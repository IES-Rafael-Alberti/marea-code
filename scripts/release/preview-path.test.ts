import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { configurePosixPath, removePosixPath } from "./preview-path.boundary.js";
it("adds a quoted PATH entry once, preserving existing shell configuration", () => {
  const append = vi.spyOn(filesystem, "appendFileSync").mockClear();
  const home = mkdtempSync(join(tmpdir(), "marea-path-"));
  try {
    for (const [shell, file] of [
      ["zsh", ".zshrc"],
      ["bash", ".bashrc"],
      ["sh", ".profile"],
    ] as const) {
      writeFileSync(join(home, file), "# Keep this\n");
      expect(configurePosixPath(home, `/bin/${shell}`, "/space dir/it's/$literal")).toBe(true);
      const saved = readFileSync(join(home, file), "utf8");
      expect(saved).toContain("# Keep this\n");
      expect(saved).toContain("export PATH='/space dir/it'\\''s/$literal':\"$PATH\"");
      expect(configurePosixPath(home, shell, "/space dir/it's/$literal")).toBe(true);
      expect(readFileSync(join(home, file), "utf8")).toBe(saved);
    }
    expect(configurePosixPath(home, "fish", "/bin")).toBe(false);
    const fresh = join(home, "new");
    mkdirSync(fresh);
    expect(configurePosixPath(fresh, "bash", "/bin")).toBe(true);
    expect(statSync(join(fresh, ".bashrc")).mode & 0o777).toBe(0o600);
    for (const call of append.mock.calls) expect(call[2]).toEqual({ mode: 0o600 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("does not follow linked profiles or write to a directory or oversized startup file", () => {
  const home = mkdtempSync(join(tmpdir(), "marea-path-"));
  try {
    const source = join(home, "original");
    writeFileSync(source, "keep");
    const path = join(home, ".zshrc");
    symlinkSync(source, path);
    expect(configurePosixPath(home, "zsh", "/bin")).toBe(false);
    rmSync(path);
    linkSync(source, path);
    expect(configurePosixPath(home, "zsh", "/bin")).toBe(false);
    rmSync(path);
    mkdirSync(path);
    expect(configurePosixPath(home, "zsh", "/bin")).toBe(false);
    rmSync(path, { recursive: true });
    writeFileSync(path, Buffer.alloc(1_000_000));
    expect(configurePosixPath(home, "zsh", "/bin")).toBe(true);
    writeFileSync(path, Buffer.alloc(1_000_001));
    expect(configurePosixPath(home, "zsh", "/bin")).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("keep");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("removes exact managed blocks in every shell while preserving other installations", () => {
  const home = mkdtempSync(join(tmpdir(), "marea-path-remove-"));
  try {
    for (const [shell, file] of [
      ["zsh", ".zshrc"],
      ["bash", ".bashrc"],
      ["sh", ".profile"],
    ] as const) {
      writeFileSync(join(home, file), "# Keep\n");
      configurePosixPath(home, shell, "/managed/bin");
      configurePosixPath(home, shell, "/other/bin");
    }
    removePosixPath(home, "/managed/bin");
    for (const file of [".zshrc", ".bashrc", ".profile"]) {
      expect(readFileSync(join(home, file), "utf8")).toBe(
        "# Keep\n\n# Marea preview\nexport PATH='/other/bin':\"$PATH\"\n",
      );
      rmSync(join(home, file));
    }
    removePosixPath(home, "/managed/bin");
    writeFileSync(join(home, ".zshrc"), "# custom\n");
    const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
    removePosixPath(home, "/managed/bin");
    expect(writes).not.toHaveBeenCalled();
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# custom\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("preserves linked or oversized profiles and reports the paths which need manual inspection", () => {
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const home = mkdtempSync(join(tmpdir(), "marea-path-remove-"));
  try {
    const original = join(home, "original");
    writeFileSync(original, "custom configuration");
    const target = join(home, ".bashrc");
    for (const setup of [
      () => {
        symlinkSync(original, target);
      },
      () => {
        linkSync(original, target);
      },
      () => {
        mkdirSync(target);
      },
      () => {
        writeFileSync(target, Buffer.alloc(1_000_001));
      },
    ]) {
      configurePosixPath(home, "zsh", "/managed/bin");
      warning.mockClear();
      setup();
      removePosixPath(home, "/managed/bin");
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("");
      expect(readFileSync(original, "utf8")).toBe("custom configuration");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenLastCalledWith(
        `Perfil protegido sin modificar: ${target}. Revisa manualmente las entradas PATH de Marea.\n`,
      );
      rmSync(target, { recursive: true });
    }
    warning.mockClear();
    writeFileSync(target, Buffer.alloc(1_000_000));
    removePosixPath(home, "/managed/bin");
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
