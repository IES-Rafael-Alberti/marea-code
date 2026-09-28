import { createDashboardAssetHandler } from "../src/dashboard-assets/dashboard-asset-handler.js";
import { loadFileSystemDashboardAssets } from "../src/dashboard-assets/filesystem-dashboard-assets.boundary.js";

const distributionRoot = process.argv[2];
if (distributionRoot === undefined) {
  throw new Error("A dashboard distribution directory is required.");
}

const source = await loadFileSystemDashboardAssets(distributionRoot);
const handleDashboardAsset = createDashboardAssetHandler(source);
const server = Bun.serve({
  fetch: handleDashboardAsset,
  hostname: "127.0.0.1",
  port: 0,
});

try {
  const origin = server.url.origin;
  const documentResponse = await fetch(`${origin}/dashboard`);
  requireCondition(
    documentResponse.ok,
    "The compiled server did not serve the dashboard document.",
  );
  requireCondition(
    documentResponse.headers.get("cache-control") === "no-cache",
    "The dashboard document had an unsafe cache policy.",
  );

  const document = await documentResponse.text();
  const scriptPath = /<script[^>]+src="(\/dashboard\/assets\/[^"]+\.js)"/u.exec(document)?.[1];
  requireCondition(scriptPath !== undefined, "The Vite document did not reference a built script.");

  const scriptResponse = await fetch(`${origin}${scriptPath}`);
  requireCondition(scriptResponse.ok, "The compiled server did not serve the Vite script.");
  requireCondition(
    scriptResponse.headers.get("cache-control") === "public, max-age=31536000, immutable",
    "The Vite script was not served as an immutable asset.",
  );
  requireCondition((await scriptResponse.text()).length > 0, "The Vite script was empty.");

  const unlistedResponse = await fetch(`${origin}/dashboard/assets%2Fmissing.js`);
  requireCondition(unlistedResponse.status === 404, "An unlisted dashboard path was exposed.");
} finally {
  await server.stop(true);
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

process.stdout.write("Compiled teacher server served the Vite dashboard assets safely.\n");
