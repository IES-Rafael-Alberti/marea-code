import { ProjectDisplayNameSchema } from "@marea/protocol";

/** Converts an arbitrary folder basename into a stable protocol display name. */
export function projectDisplayNameFromFolder(folderName: string): string {
  const sanitized = folderName
    .replace(/[^\p{L}\p{N} ._()'-]/gu, "_")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 120)
    .trim();
  return ProjectDisplayNameSchema.parse(sanitized || "project");
}
