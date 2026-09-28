import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TemporaryDirectories {
  private readonly roots: string[] = [];

  async create(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `marea-${name}-`));
    this.roots.push(path);
    return path;
  }

  async removeAll(): Promise<void> {
    await Promise.all(
      this.roots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
  }
}
