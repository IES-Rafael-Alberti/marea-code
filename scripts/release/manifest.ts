import { createHash } from "node:crypto";
import { z } from "zod";

export const releaseVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
export const component = z.enum(["student", "server"]);
export const target = z.enum([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
]);
const filePath = z
  .string()
  .regex(/^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/u)
  .refine((value) =>
    value
      .split("/")
      .every(
        (part) =>
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) && !part.endsWith("."),
      ),
  );
/** Fixed-locale inventory keys also protect Windows case-insensitive installations. */
function conflictingPath(paths: readonly string[]): string | undefined {
  const unique = new Set<string>();
  for (const path of paths) {
    if (unique.has(path)) return path;
    unique.add(path);
  }
  for (const path of paths) {
    const parents = path.split("/");
    parents.pop();
    let prefix = "";
    for (const part of parents) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      if (unique.has(prefix)) return prefix;
    }
  }
  return undefined;
}

export const manifestSchema = z
  .object({
    format: z.literal(1),
    version: releaseVersion,
    component,
    target,
    // Runtime versions describe the signed bundle, not the installed updater.
    bun: releaseVersion,
    opentui: releaseVersion,
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    files: z
      .array(
        z
          .object({
            path: filePath,
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = value.files.map((file) => file.path.toLocaleLowerCase("en-US"));
    const conflict = conflictingPath(paths);
    if (conflict !== undefined) {
      context.addIssue({ code: "custom", message: `Duplicate or conflicting paths: ${conflict}` });
    }
    if (value.component === "server" && ["linux-arm64", "win32-arm64"].includes(value.target)) {
      context.addIssue({ code: "custom", message: "Unsupported server target" });
    }
  });
export type ReleaseManifest = z.infer<typeof manifestSchema>;
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function signingIdentity(repository: string, ref: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^refs\/(?:heads|tags)\/[\w./-]+$/u.test(ref))
    throw new Error("Explicit trusted repository and ref required");
  return `https://github.com/${repository}/.github/workflows/native-release-candidate.yml@${ref}`;
}
export function selectRelease(
  value: unknown,
  version: string,
  selected: string,
  platform: string,
): ReleaseManifest {
  const manifest = manifestSchema.parse(value);
  if (
    manifest.version !== version ||
    manifest.component !== selected ||
    manifest.target !== platform
  )
    throw new Error("Release selection mismatch");
  return manifest;
}
