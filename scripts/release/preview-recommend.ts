import { z } from "zod";
import { CURRENT_PROTOCOL_VERSION, ProtocolVersionSchema } from "@marea/protocol";
import {
  comparePreview,
  newestPreview,
  previewVersion,
  recommendationMarker,
} from "./preview-channel.js";

/** Only the current wire generation is promoted; older generations keep their last recommendation. */
export function recommendedNotes(
  releases: unknown,
  version: string,
  selected: "student" | "server",
  body: string,
  compatibility: readonly unknown[],
): string {
  previewVersion.parse(version);
  if (compatibility.length !== (selected === "student" ? 5 : 3))
    throw new Error("Missing native compatibility inventories");
  const schema = z
    .object({ supportedProtocolVersions: z.array(ProtocolVersionSchema).min(1) })
    .strict();
  for (const inventory of compatibility) {
    if (
      !schema
        .parse(inventory)
        .supportedProtocolVersions.some((value) => value === CURRENT_PROTOCOL_VERSION)
    )
      throw new Error("Release does not support this recommendation's protocol");
  }
  const previous = newestPreview(releases, selected);
  if (previous !== undefined && comparePreview(version, previous) < 0)
    throw new Error("Recommendations cannot move backwards");
  const marker = recommendationMarker(selected);
  return body.split(/\r?\n/u).includes(marker) ? body : `${body}\n\n${marker}\n`;
}
