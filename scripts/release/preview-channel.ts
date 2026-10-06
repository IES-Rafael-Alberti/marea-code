import { z } from "zod";
import { CURRENT_PROTOCOL_VERSION, ProtocolVersionSchema } from "@marea/protocol";
import { component, target } from "./manifest.js";

/** Preview tags are monotonically ordered numbers; stable/RC/nightly tags never enter this channel. */
export const previewVersion = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/u);
export const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
export const previewSettingsSchema = z
  .object({
    format: z.literal(1),
    repository: repositoryName,
    component,
    channel: z.literal("preview"),
    serverUrl: z.string().optional(),
    installation: z.string().optional(),
  })
  .strict();
export type PreviewSettings = z.infer<typeof previewSettingsSchema>;

export function comparePreview(a: string, b: string): number {
  const numbers = (value: string) =>
    previewVersion.parse(value).replace("-preview.", ".").split(".").map(BigInt);
  const left = numbers(a);
  const right = numbers(b);
  for (const [index, value] of left.entries()) {
    const other = BigInt(String(right[index]));
    if (value > other) return 1;
    if (value < other) return -1;
  }
  return 0;
}

export function releaseUrl(repository: string, version: string, asset: string): string {
  repositoryName.parse(repository);
  previewVersion.parse(version);
  if (!/^[A-Za-z0-9._-]+$/u.test(asset)) throw new Error("Invalid release asset");
  return `https://github.com/${repository}/releases/download/v${version}/${asset}`;
}

export function manifestAsset(selected: string, platform: string): string {
  return `${component.parse(selected)}-${target.parse(platform)}.manifest.json`;
}

/** Refuse plaintext credentials over a school network; HTTP is useful for local rehearsals only. */
export function serverOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new Error("Use an HTTPS server origin (HTTP is allowed only on loopback)");
  return url.origin;
}

/** A small static index avoids downloading all release assets or sharing GitHub API quotas in a classroom. */
export const previewChannelSchema = z
  .object({
    format: z.literal(1),
    available: previewVersion,
    recommended: z.record(
      ProtocolVersionSchema,
      z.object({ student: previewVersion.optional(), server: previewVersion.optional() }).strict(),
    ),
  })
  .strict();
export type PreviewChannel = z.infer<typeof previewChannelSchema>;

export function channelVersion(
  input: unknown,
  selected: "student" | "server",
  discovery: "recommended" | "available",
): string | undefined {
  const channel = previewChannelSchema.parse(input);
  return discovery === "recommended"
    ? channel.recommended[ProtocolVersionSchema.parse(CURRENT_PROTOCOL_VERSION)]?.[selected]
    : channel.available;
}

export function availablePreview(input: unknown, version: string): PreviewChannel {
  previewVersion.parse(version);
  if (input === undefined) return { format: 1, available: version, recommended: {} };
  const previous = previewChannelSchema.parse(input);
  return comparePreview(version, previous.available) === 1
    ? { ...previous, available: version }
    : previous;
}
