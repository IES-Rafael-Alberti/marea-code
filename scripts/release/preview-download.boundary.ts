import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CapabilitiesResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  ProtocolVersionSchema,
  selectProtocolVersion,
} from "@marea/protocol";
import {
  manifestAsset,
  channelVersion,
  previewVersion,
  releaseUrl,
  repositoryName,
  serverOrigin,
  type PreviewSettings,
} from "./preview-channel.js";
import { selectRelease, sha256, signingIdentity, type ReleaseManifest } from "./manifest.js";
import type { InstallationProgress } from "./preview-progress.boundary.js";

export type PreviewFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface DownloadPorts {
  readonly fetch: PreviewFetch;
  readonly verify: (manifest: string, bundle: string, identity: string) => void;
  readonly progress?: Pick<InstallationProgress, "stage" | "update">;
}

/** Bounds the streamed body as well as time; an absent or dishonest Content-Length is not trusted. */
export async function boundedDownload(
  fetcher: PreviewFetch,
  url: string,
  limit: number,
  init: RequestInit = {},
  progress?: (bytes: number) => void,
): Promise<Uint8Array> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok || response.body === null) throw new Error("Release download unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error("Release download exceeds size limit");
      chunks.push(part.value);
      progress?.(size);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function offeredVersion(
  settings: PreviewSettings,
  fetcher: PreviewFetch,
  discovery: "recommended" | "available" = "recommended",
): Promise<string | undefined> {
  // Update discovery must never delay or prevent an ordinary offline start.
  const quickFetch: PreviewFetch = (input, init) =>
    fetcher(input, { ...init, signal: AbortSignal.timeout(2_000) });
  const body = await boundedDownload(
    quickFetch,
    `https://raw.githubusercontent.com/${repositoryName.parse(settings.repository)}/marea-preview-channel/preview.json`,
    65_536,
  );
  return channelVersion(JSON.parse(new TextDecoder().decode(body)), settings.component, discovery);
}

/** A different software version is fine; only an incompatible wire protocol requires a switch. */
export async function requiredPreviewVersion(
  settings: PreviewSettings,
  current: string,
  fetcher: PreviewFetch,
): Promise<string | undefined> {
  if (settings.component !== "student" || settings.serverUrl === undefined) return undefined;
  const quickFetch: PreviewFetch = (input, init) =>
    fetcher(input, { ...init, signal: AbortSignal.timeout(2_000) });
  const body = await boundedDownload(
    quickFetch,
    `${serverOrigin(settings.serverUrl)}/v1/capabilities`,
    65_536,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request:preview-update",
        clientVersion: current,
        supportedProtocolVersions: [CURRENT_PROTOCOL_VERSION],
      }),
    },
  );
  const result = CapabilitiesResponseSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  if (result.requestId !== "request:preview-update")
    throw new Error("Unrelated capabilities response");
  return selectProtocolVersion(
    [ProtocolVersionSchema.parse(CURRENT_PROTOCOL_VERSION)],
    result.supportedProtocolVersions,
  ) === null
    ? previewVersion.parse(result.serverVersion)
    : undefined;
}

/** Only an authenticated inventory can select file names or hashes. No archive extraction occurs. */
export async function downloadPreview(
  settings: PreviewSettings,
  version: string,
  platform: string,
  directory: string,
  ports: DownloadPorts,
): Promise<ReleaseManifest> {
  const asset = manifestAsset(settings.component, platform);
  const get = (name: string, limit: number) =>
    boundedDownload(ports.fetch, releaseUrl(settings.repository, version, name), limit);
  ports.progress?.stage("Obteniendo la información de la versión...");
  for (const [name, remote] of [
    ["manifest.json", asset],
    ["manifest.sigstore.json", `${asset}.sigstore.json`],
  ] as const)
    writeFileSync(join(directory, name), await get(remote, 8_388_608), { flag: "wx", mode: 0o600 });
  ports.progress?.stage("Verificando la firma de la versión...");
  ports.verify(
    join(directory, "manifest.json"),
    join(directory, "manifest.sigstore.json"),
    signingIdentity(settings.repository, `refs/tags/v${version}`),
  );
  const manifest = selectRelease(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
    version,
    settings.component,
    platform,
  );
  let totalBytes = 0;
  ports.progress?.stage(`Descargando ${String(manifest.files.length)} archivos de Marea...`);
  for (const [index, file] of manifest.files.entries()) {
    const report = (bytes: number) =>
      ports.progress?.update(
        `Descargando archivo ${String(index + 1)}/${String(manifest.files.length)}: ${((totalBytes + bytes) / 1_048_576).toFixed(1)} MiB recibidos en total`,
      );
    report(0);
    const bytes = await boundedDownload(
      ports.fetch,
      releaseUrl(settings.repository, version, `sha256-${file.sha256}`),
      512_000_000,
      {},
      report,
    );
    totalBytes += bytes.length;
    if (totalBytes > 2_000_000_000 || sha256(bytes) !== file.sha256)
      throw new Error("Release checksum or total size mismatch");
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    if (file.executable) chmodSync(path, 0o700);
  }
  ports.progress?.stage(`Descarga verificada: ${String(manifest.files.length)} archivos.`);
  return manifest;
}
