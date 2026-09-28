import { spawn } from "node:child_process";

/** Clipboard contents are stdin, never shell source or command arguments. */
export function copyNativeClipboard(text: string, platform = process.platform): Promise<boolean> {
  const commands: [string, ...string[]][] =
    platform === "darwin"
      ? [["/usr/bin/pbcopy"]]
      : platform === "win32"
        ? [["clip.exe"]]
        : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  return (async () => {
    for (const [command, ...args] of commands) {
      if (await copy(command, args, text)) return true;
    }
    return false;
  })();
}

function copy(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    child.once("error", () => {
      resolve(false);
    });
    child.once("close", (code) => {
      resolve(code === 0);
    });
    child.stdin.on("error", () => {
      resolve(false);
    });
    child.stdin.end(text);
  });
}
