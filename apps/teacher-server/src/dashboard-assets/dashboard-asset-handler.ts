import type { DashboardAsset, DashboardAssetSource } from "./dashboard-asset-source.js";

const DASHBOARD_MOUNT_PATH = "/dashboard";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const HTML_CACHE_CONTROL = "no-cache";

export type DashboardAssetHandler = (request: Request) => Response;

export function createDashboardAssetHandler(source: DashboardAssetSource): DashboardAssetHandler {
  return (request): Response => {
    const assetPath = selectAssetPath(new URL(request.url).pathname);
    if (assetPath === null) {
      return notFound();
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        headers: { allow: "GET, HEAD" },
        status: 405,
      });
    }

    const asset = source.find(assetPath);
    if (asset === null) {
      return notFound();
    }

    const headers = createAssetHeaders(asset);
    if (request.headers.get("if-none-match") === asset.entityTag) {
      return new Response(null, { headers, status: 304 });
    }

    const body = request.method === "HEAD" ? null : asset.body;
    return new Response(body, { headers, status: 200 });
  };
}

function selectAssetPath(pathname: string): string | null {
  if (pathname === DASHBOARD_MOUNT_PATH || pathname === `${DASHBOARD_MOUNT_PATH}/`) {
    return "index.html";
  }

  const prefix = `${DASHBOARD_MOUNT_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const assetPath = pathname.slice(prefix.length);
  return assetPath.includes("%") ? null : assetPath;
}

function createAssetHeaders(asset: DashboardAsset): Headers {
  const headers = new Headers({
    "cache-control": asset.immutable ? IMMUTABLE_CACHE_CONTROL : HTML_CACHE_CONTROL,
    "content-length": String(asset.body.size),
    "content-type": asset.contentType,
    etag: asset.entityTag,
    "x-content-type-options": "nosniff",
  });

  if (!asset.immutable) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  }
  return headers;
}

function notFound(): Response {
  return new Response("Not Found", {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 404,
  });
}
