import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sha256 } from "./manifest.js";

/** Preserve available dependency copyright/license notices, including bundled transitive code. */
export function collectDependencyNotices(workspace: string, output: string): void {
  const root = realpathSync(workspace);
  const visited = new Set<string>();
  const notices: { source: string; file: string }[] = [];
  const walk = (directory: string): void => {
    const canonical = realpathSync(directory);
    const location = relative(root, canonical);
    if (location.startsWith("..") || isAbsolute(location) || visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of readdirSync(canonical, { withFileTypes: true })) {
      const path = join(canonical, entry.name);
      const resolvedLocation = relative(root, realpathSync(path));
      if (resolvedLocation.startsWith("..") || isAbsolute(resolvedLocation)) continue;
      const status = statSync(path);
      if (status.isDirectory()) walk(path);
      else if (
        status.isFile() &&
        /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name)
      ) {
        if (status.size > 8_388_608) throw new Error("Dependency notice exceeds size limit");
        const bytes = readFileSync(path);
        const file = `notice-${sha256(bytes)}.txt`;
        writeFileSync(join(output, file), bytes);
        notices.push({ source: relative(root, path).replaceAll("\\", "/"), file });
      }
    }
  };
  mkdirSync(output, { recursive: true });
  walk(join(root, "node_modules"));
  writeFileSync(join(output, "notices.json"), JSON.stringify(notices, null, 2));
}
