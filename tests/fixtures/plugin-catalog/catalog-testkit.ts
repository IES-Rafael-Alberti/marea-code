import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect } from "vitest";

import {
  PluginCatalogError,
  type PluginCatalogErrorCode,
} from "../../../scripts/generate-plugin-catalog.js";

const fixturePlugins = join(import.meta.dirname, "plugins");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

export async function temporaryRoot(prefix = "marea-plugin-catalog-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

export async function copiedPluginFixture(): Promise<{
  readonly root: string;
  readonly plugins: string;
}> {
  const root = await temporaryRoot();
  const plugins = join(root, "plugins");
  await cp(fixturePlugins, plugins, { recursive: true });
  return { root, plugins };
}

export async function replaceFixtureText(
  path: string,
  search: string,
  replacement: string,
): Promise<void> {
  const original = await readFile(path, "utf8");
  if (!original.includes(search)) {
    throw new TypeError(`Fixture text not found: ${search}`);
  }
  await writeFile(path, original.replace(search, replacement), "utf8");
}

export async function expectCatalogError(
  promise: Promise<string>,
  code: PluginCatalogErrorCode,
  message?: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PluginCatalogError);
  await expect(promise).rejects.toMatchObject({ code });
  if (message !== undefined) {
    await expect(promise).rejects.toThrow(message);
  }
}
