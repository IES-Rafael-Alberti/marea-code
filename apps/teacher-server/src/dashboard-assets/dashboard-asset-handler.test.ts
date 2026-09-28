import { describe, expect, it, vi } from "vitest";

import { createDashboardAssetHandler } from "./dashboard-asset-handler.js";
import type { DashboardAsset, DashboardAssetSource } from "./dashboard-asset-source.js";

const INDEX_ASSET: DashboardAsset = Object.freeze({
  body: new Blob(["<html>Marea</html>"]),
  contentType: "text/html; charset=utf-8",
  entityTag: '"index-tag"',
  immutable: false,
});

const SCRIPT_ASSET: DashboardAsset = Object.freeze({
  body: new Blob(["export{}"]),
  contentType: "text/javascript; charset=utf-8",
  entityTag: '"script-tag"',
  immutable: true,
});

const source: DashboardAssetSource = Object.freeze({
  find: (assetPath: string): DashboardAsset | null => {
    if (assetPath === "index.html") {
      return INDEX_ASSET;
    }
    return assetPath === "assets/app.js" ? SCRIPT_ASSET : null;
  },
});

const handle = createDashboardAssetHandler(source);

describe("dashboard asset handler", () => {
  it.each(["/dashboard", "/dashboard/"])("serves the dashboard document at %s", async (path) => {
    const response = handle(new Request(`https://school.example${path}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>Marea</html>");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-length")).toBe(String(INDEX_ASSET.body.size));
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("etag")).toBe('"index-tag"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves immutable assets without a response body for HEAD", async () => {
    const response = handle(
      new Request("https://school.example/dashboard/assets/app.js", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("returns an empty 304 for a matching entity tag", async () => {
    const response = handle(
      new Request("https://school.example/dashboard/assets/app.js", {
        headers: { "if-none-match": '"script-tag"' },
      }),
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("rejects unsupported methods", () => {
    const response = handle(new Request("https://school.example/dashboard", { method: "POST" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each(["/", "/dashboards", "/dashboard/missing.js", "/dashboard/assets%2Fapp.js"])(
    "does not expose an unlisted path at %s",
    async (path) => {
      const response = handle(new Request(`https://school.example${path}`));

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("Not Found");
    },
  );

  it("does not consult the asset source for paths outside the mount", () => {
    const find = vi.fn((): DashboardAsset | null => null);
    const guardedHandle = createDashboardAssetHandler({ find });

    const response = guardedHandle(new Request("https://school.example/outside"));

    expect(response.status).toBe(404);
    expect(find).not.toHaveBeenCalled();
  });
});
