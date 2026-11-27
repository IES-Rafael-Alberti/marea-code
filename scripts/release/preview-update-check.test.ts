import { describe, expect, it, vi } from "vitest";

import type { PreviewFetch } from "./preview-download.boundary.js";
import { checkForUpdate, updateCheckCause } from "./preview-update-check.boundary.js";

const student = {
  format: 1,
  repository: "school/marea",
  component: "student",
  channel: "preview",
  serverUrl: "http://192.168.1.20:18787",
} as const;
const channel = JSON.stringify({
  format: 1,
  available: "0.1.0-preview.51",
  recommended: { "0.1": { student: "0.1.0-preview.50", server: "0.1.0-preview.50" } },
});
const capabilities = (protocol: string) =>
  JSON.stringify({
    requestId: "request:preview-update",
    serverVersion: "0.1.0-preview.52",
    supportedProtocolVersions: [protocol],
    capabilities: [],
  });

function failure(name: string, code?: string | number): Error {
  const error = new TypeError(`synthetic ${name}`);
  error.name = name;
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

const timeout = () => failure("TimeoutError", 23);
const refused = () => failure("TypeError", "ConnectionRefused");

/** Answers the classroom server and GitHub separately; a thrown value is that target's failure. */
function network(server: Error | string, github: Error | string): PreviewFetch {
  return vi.fn((url: string) => {
    const answer = url.startsWith("https://raw.githubusercontent.com/") ? github : server;
    return typeof answer === "string"
      ? Promise.resolve(new Response(answer, { status: answer === "403" ? 403 : 200 }))
      : Promise.reject(answer);
  });
}

async function check(
  fetch: PreviewFetch,
  options: Partial<Parameters<typeof checkForUpdate>[0]> = {},
) {
  const write = vi.fn();
  const result = await checkForUpdate({
    settings: student,
    current: "0.1.0-preview.49",
    manual: false,
    selectedVersion: undefined,
    fetch,
    environment: {},
    write,
    ...options,
  });
  return { result, lines: write.mock.calls.map(([text]) => String(text)) };
}

describe("update check before starting Marea", () => {
  it("still asks GitHub when the classroom server does not answer, and says which one failed", async () => {
    const fetch = network(timeout(), channel);
    const { result, lines } = await check(fetch);
    expect(result).toEqual({ offered: "0.1.0-preview.50", required: false, failed: true });
    expect(lines).toEqual([
      "No se ha podido consultar el servidor del aula (http://192.168.1.20:18787) para buscar actualizaciones: tiempo agotado tras 2 s.\n",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports GitHub without connection after a healthy classroom server", async () => {
    const { result, lines } = await check(network(capabilities("0.1"), refused()));
    expect(result).toEqual({ offered: undefined, required: false, failed: true });
    expect(lines).toEqual([
      "No se ha podido consultar GitHub (raw.githubusercontent.com) para buscar actualizaciones: sin conexión. Se conserva la versión instalada.\n",
    ]);
  });

  it("reports both failures, each with its own target and cause", async () => {
    const { result, lines } = await check(network("403", "not json"));
    expect(result.failed).toBe(true);
    expect(lines).toEqual([
      "No se ha podido consultar el servidor del aula (http://192.168.1.20:18787) para buscar actualizaciones: respuesta no válida (HTTP 403).\n",
      "No se ha podido consultar GitHub (raw.githubusercontent.com) para buscar actualizaciones: respuesta no válida. Se conserva la versión instalada.\n",
    ]);
  });

  it("offers the version an incompatible classroom server requires without asking GitHub", async () => {
    const fetch = network(capabilities("9.9"), channel);
    const { result, lines } = await check(fetch);
    expect(result).toEqual({ offered: "0.1.0-preview.52", required: true, failed: false });
    expect(lines).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks only GitHub for available previews on a manual update", async () => {
    const fetch = network(timeout(), channel);
    const { result, lines } = await check(fetch, { manual: true });
    expect(result).toEqual({ offered: "0.1.0-preview.51", required: false, failed: false });
    expect(lines).toEqual([]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://raw.githubusercontent.com/school/marea/marea-preview-channel/preview.json",
      expect.any(Object),
    );
  });

  it("uses an explicitly selected version instead of the channel", async () => {
    const fetch = network(timeout(), channel);
    const { result } = await check(fetch, { manual: true, selectedVersion: "0.1.0-preview.47" });
    expect(result).toEqual({ offered: "0.1.0-preview.47", required: false, failed: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never asks a classroom server that the installation does not name", async () => {
    const fetch = network(timeout(), channel);
    const server = { ...student, component: "server", serverUrl: undefined } as const;
    const { result } = await check(fetch, { settings: server });
    expect(result).toEqual({ offered: "0.1.0-preview.50", required: false, failed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blames the configured proxy for network failures on its own scheme only", async () => {
    const proxied = await check(network(refused(), timeout()), {
      environment: { HTTPS_PROXY: "http://user:secret@proxy.school:3128", http_proxy: "  " },
    });
    expect(proxied.lines).toEqual([
      "No se ha podido consultar el servidor del aula (http://192.168.1.20:18787) para buscar actualizaciones: sin conexión.\n",
      "No se ha podido consultar GitHub (raw.githubusercontent.com) para buscar actualizaciones: fallo del proxy configurado en HTTPS_PROXY (tiempo agotado tras 2 s). Se conserva la versión instalada.\n",
    ]);
    expect(proxied.lines.join("")).not.toContain("secret");
  });
});

describe("cause of a failed update check", () => {
  const http = "http://192.168.1.20:18787";
  const https = "https://raw.githubusercontent.com";

  it.each([
    [timeout(), https, {}, "tiempo agotado tras 2 s"],
    [refused(), https, {}, "sin conexión"],
    [failure("TypeError", "ENOTFOUND"), https, {}, "sin conexión"],
    [
      failure("TypeError", "SELF_SIGNED_CERT_IN_CHAIN"),
      https,
      { HTTPS_PROXY: "http://proxy" },
      "certificado no reconocido; puede que un proxy del centro intercepte la conexión",
    ],
    [
      failure("TypeError", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"),
      https,
      {},
      "certificado no reconocido; puede que un proxy del centro intercepte la conexión",
    ],
    [
      failure("TypeError", "ERR_TLS_CERT_ALTNAME_INVALID"),
      https,
      {},
      "certificado no reconocido; puede que un proxy del centro intercepte la conexión",
    ],
    [
      refused(),
      https,
      { https_proxy: "http://proxy" },
      "fallo del proxy configurado en https_proxy (sin conexión)",
    ],
    [
      refused(),
      http,
      { HTTP_PROXY: "http://proxy" },
      "fallo del proxy configurado en HTTP_PROXY (sin conexión)",
    ],
    [
      timeout(),
      http,
      { http_proxy: "http://proxy" },
      "fallo del proxy configurado en http_proxy (tiempo agotado tras 2 s)",
    ],
    [refused(), http, { HTTPS_PROXY: "http://proxy" }, "sin conexión"],
    [
      new Error("Release download unavailable: HTTP 502"),
      http,
      {},
      "respuesta no válida (HTTP 502)",
    ],
    [
      new Error("Release download unavailable: HTTP 502"),
      http,
      { HTTP_PROXY: "http://proxy" },
      "respuesta no válida (HTTP 502)",
    ],
    [new SyntaxError("Unexpected token"), https, {}, "respuesta no válida"],
    [failure("AbortError", 20), https, {}, "respuesta no válida"],
    [42, https, {}, "respuesta no válida"],
  ] as const)("%s from %s with %j is %s", (error, url, environment, cause) => {
    expect(updateCheckCause(error, url, environment)).toBe(cause);
  });
});
