import { z } from "zod";
import { CURRENT_PROTOCOL_VERSION, ProtocolVersionSchema } from "@marea/protocol";
import { comparePreview, previewChannelSchema, type PreviewChannel } from "./preview-channel.js";

/** Only the current wire generation is promoted; older generations keep their last recommendation. */
export function recommendPreview(
  input: unknown,
  version: string,
  selected: "student" | "server",
  compatibility: readonly unknown[],
): PreviewChannel {
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
  const channel = previewChannelSchema.parse(input);
  if (comparePreview(version, channel.available) > 0)
    throw new Error("Release is not yet available in the preview channel");
  const protocol = ProtocolVersionSchema.parse(CURRENT_PROTOCOL_VERSION);
  const previous = channel.recommended[protocol]?.[selected];
  if (previous !== undefined && comparePreview(version, previous) < 0)
    throw new Error("Recommendations cannot move backwards");
  return {
    ...channel,
    recommended: {
      ...channel.recommended,
      [protocol]: {
        ...channel.recommended[protocol],
        [selected]: version,
      },
    },
  };
}
