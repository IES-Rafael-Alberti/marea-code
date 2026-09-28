import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import type { DashboardAsset, DashboardAssetSource } from "./dashboard-asset-source.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

export async function loadFileSystemDashboardAssets(
  distributionRoot: string,
): Promise<DashboardAssetSource> {
  const canonicalRoot = await realpath(distributionRoot);
  const indexPath = join(canonicalRoot, "index.html");
  await requireRegularFile(indexPath);

  const assetsRoot = join(canonicalRoot, "assets");
  const assetPaths = await collectRegularFiles(assetsRoot);
  const entries = await Promise.all([
    createAssetEntry(canonicalRoot, indexPath, false),
    ...assetPaths.map(async (assetPath) => createAssetEntry(canonicalRoot, assetPath, true)),
  ]);
  const assets = new Map(entries);

  return Object.freeze({
    find: (assetPath: string): DashboardAsset | null => assets.get(assetPath) ?? null,
  });
}

async function collectRegularFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Dashboard assets cannot contain symbolic links: ${entry.name}`);
    }

    if (entry.isDirectory()) {
      files.push(...(await collectRegularFiles(entryPath)));
    } else {
      await requireRegularFile(entryPath);
      files.push(entryPath);
    }
  }
  return files;
}

async function requireRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) {
    throw new Error(`Dashboard asset is not a regular file: ${filePath}`);
  }
}

async function createAssetEntry(
  root: string,
  filePath: string,
  immutable: boolean,
): Promise<readonly [string, DashboardAsset]> {
  const canonicalFilePath = await realpath(filePath);
  const content = Uint8Array.from(await readFile(canonicalFilePath));
  const assetPath = resolveDashboardAssetPath(root, canonicalFilePath);
  const entityTag = `"${createHash("sha256").update(content).digest("base64url")}"`;

  return [
    assetPath,
    Object.freeze({
      body: new Blob([content]),
      contentType: CONTENT_TYPES[extname(assetPath).toLowerCase()] ?? "application/octet-stream",
      entityTag,
      immutable,
    }),
  ];
}

export function resolveDashboardAssetPath(root: string, assetPath: string): string {
  if (!assetPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Dashboard asset escapes its distribution root: ${assetPath}`);
  }
  return relative(root, assetPath).split(sep).join("/");
}
