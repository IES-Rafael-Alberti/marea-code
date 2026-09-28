import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadFileSystemDashboardAssets,
  resolveDashboardAssetPath,
} from "./filesystem-dashboard-assets.boundary.js";

const temporaryDirectories: string[] = [];

async function createDistribution(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-dashboard-assets-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  await writeFile(join(root, "index.html"), "<html>Marea</html>", "utf8");
  await writeFile(join(root, "assets", "app-123.js"), "export{}", "utf8");
  await writeFile(join(root, "assets", "nested", "theme.css"), ":root{}", "utf8");
  await writeFile(join(root, "assets", "payload.bin"), Uint8Array.of(0, 1, 2));
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("filesystem dashboard assets", () => {
  it("loads only the release document and its immutable asset tree", async () => {
    const root = await createDistribution();
    const source = await loadFileSystemDashboardAssets(root);

    const document = source.find("index.html");
    const script = source.find("assets/app-123.js");
    const stylesheet = source.find("assets/nested/theme.css");
    const binary = source.find("assets/payload.bin");

    expect(document?.immutable).toBe(false);
    expect(document?.contentType).toBe("text/html; charset=utf-8");
    expect(await document?.body.text()).toBe("<html>Marea</html>");
    expect(document?.entityTag).toMatch(/^"[A-Za-z0-9_-]{43}"$/u);
    expect(script?.immutable).toBe(true);
    expect(script?.contentType).toBe("text/javascript; charset=utf-8");
    expect(stylesheet?.contentType).toBe("text/css; charset=utf-8");
    expect(binary?.contentType).toBe("application/octet-stream");
    expect(source.find(".vite/manifest.json")).toBeNull();
    expect(source.find("../secret")).toBeNull();
  });

  it("rejects symbolic links inside the published asset tree", async () => {
    const root = await createDistribution();
    await symlink(join(root, "index.html"), join(root, "assets", "linked.html"));

    await expect(loadFileSystemDashboardAssets(root)).rejects.toThrow(
      "Dashboard assets cannot contain symbolic links: linked.html",
    );
  });

  it("requires the entry document to be a regular file", async () => {
    const root = await createDistribution();
    await rm(join(root, "index.html"));
    await mkdir(join(root, "index.html"));

    await expect(loadFileSystemDashboardAssets(root)).rejects.toThrow(
      "Dashboard asset is not a regular file",
    );
  });
});

describe("dashboard distribution root guard", () => {
  it("accepts a nested asset", () => {
    expect(resolveDashboardAssetPath(resolve("release"), resolve("release/assets/app.js"))).toBe(
      "assets/app.js",
    );
  });

  it("rejects sibling prefixes and parent paths", () => {
    const root = resolve("release");

    expect(() => {
      resolveDashboardAssetPath(root, resolve("release-copy/app.js"));
    }).toThrow("Dashboard asset escapes its distribution root");
    expect(() => {
      resolveDashboardAssetPath(root, resolve("secret"));
    }).toThrow("Dashboard asset escapes its distribution root");
  });
});
