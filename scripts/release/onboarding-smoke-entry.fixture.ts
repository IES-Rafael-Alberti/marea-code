import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { runBrowserOnboarding } from "./preview-onboarding.boundary.js";
import { runPrivateCommand } from "./preview-manager.boundary.js";
import { runForeground } from "./preview-process.boundary.js";
import { previewSettingsSchema } from "./preview-channel.js";

const [root, release] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const settings = previewSettingsSchema.parse(
  JSON.parse(readFileSync(join(root, "preview.json"), "utf8")),
);
const realFetch = globalThis.fetch;
// The probe uses synthetic credentials and substitutes only the external provider's network.
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: {} });
  if (url === "https://openrouter.ai/api/v1/models/user")
    return Response.json({
      data: [
        {
          id: "synthetic/classroom",
          name: "Classroom model",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });
  return realFetch(input, init);
}, realFetch);
const suffix = process.platform === "win32" ? ".exe" : "";
process.exitCode = await runBrowserOnboarding({
  root,
  release,
  version: "0.1.0-preview.18",
  settings,
  run: runPrivateCommand,
  openBrowser: (url) => {
    writeFileSync(join(root, "setup-url.txt"), url, { mode: 0o600 });
  },
  launch: (allowHttp) =>
    runForeground(
      join(release, `marea-teacher${suffix}`),
      [
        "--installation",
        join(root, "installation"),
        "--release",
        "release:preview",
        ...(allowHttp ? ["--allow-http"] : []),
      ],
      process.env,
    ),
});
