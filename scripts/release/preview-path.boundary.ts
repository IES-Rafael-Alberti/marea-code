import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { shellLiteral } from "./preview-launchers.js";

/** Append one literal PATH entry to the selected user's shell, without following dotfile links. */
export function configurePosixPath(home: string, shell: string, bin: string): boolean {
  const name = basename(shell);
  const profile =
    name === "zsh"
      ? ".zshrc"
      : name === "bash"
        ? ".bashrc"
        : name === "sh"
          ? ".profile"
          : undefined;
  if (profile === undefined) return false;
  const path = join(home, profile);
  const line = `export PATH=${shellLiteral(bin)}:"$PATH"`;
  if (existsSync(path)) {
    const status = lstatSync(path);
    if (!status.isFile() || status.nlink !== 1 || status.size > 1_000_000) return false;
    if (readFileSync(path, "utf8").split("\n").includes(line)) return true;
  }
  appendFileSync(path, `\n# Marea preview\n${line}\n`, { mode: 0o600 });
  return true;
}
