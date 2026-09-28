import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots = new Set<string>();
export function temporaryInstallation(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-cli-test-")));
  roots.add(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "locks"), { mode: 0o700 });
  mkdirSync(join(root, "work"), { mode: 0o700 });
  return root;
}
export function cleanupInstallations(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
}

export class PasswordInput extends EventEmitter {
  readonly rawModes: boolean[] = [];
  pauses = 0;
  isRaw = false;
  constructor(readonly isTTY = false) {
    super();
  }
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
  pause(): this {
    this.pauses += 1;
    return this;
  }
  send(bytes: string | Buffer): void {
    this.emit("data", Buffer.from(bytes));
  }
  end(): void {
    this.emit("end");
  }
}
