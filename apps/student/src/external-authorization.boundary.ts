import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Translator } from "@marea/i18n";

import type { ExternalAuthorization, ExternalAuthorizationCallback } from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const CALLBACK_PATH = "/callback";
const VISIBLE_ASCII = /^[\x21-\x7e]{1,2048}$/u;

interface LoopbackListener {
  readonly address?: string;
  readonly port: number;
  close(): void;
}

/** The parts of a loopback request and response this receiver reads and writes. */
export interface LoopbackRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
}

export interface LoopbackResponse {
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown;
  end(body: string): unknown;
}

export type LoopbackListen = (
  handle: (request: LoopbackRequest, response: LoopbackResponse) => void,
) => Promise<LoopbackListener>;

export interface LoopbackAuthorizationOptions {
  readonly translator: Translator;
  /** Shows the provider address, so a student can open it when no browser starts. */
  readonly output: { error(text: string): void };
  readonly openBrowser?: (url: string) => void;
  readonly listen?: LoopbackListen;
  readonly timeoutMs?: number;
}

/** Only this machine can reach the listener; the operating system picks a free port. */
export function listenOnLoopback(
  handle: Parameters<LoopbackListen>[0],
  port = 0,
): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    const server = createServer(handle);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        address: address.address,
        port: address.port,
        close: () => {
          server.close();
        },
      });
    });
  });
}

function opener(platform: NodeJS.Platform): readonly [string, ...string[]] {
  if (platform === "darwin") return ["open"];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}

/** Opens the address without a shell, so no character of it is interpreted as a command. */
export function openSystemBrowser(url: string, platform: NodeJS.Platform = process.platform) {
  const [command, ...args] = opener(platform);
  const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" });
  // The address is also shown in the terminal, so a missing opener is not an error.
  child.on("error", () => undefined);
  child.unref();
}

function page(response: LoopbackResponse, status: number, text: string): void {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Marea</title><p>${escaped}</p>`);
}

/** The provider's answer, or undefined for anything else, including a provider error. */
function callbackOf(url: URL): ExternalAuthorizationCallback | undefined {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  return code !== null &&
    state !== null &&
    VISIBLE_ASCII.test(code) &&
    VISIBLE_ASCII.test(state) &&
    !url.searchParams.has("error")
    ? { code, state }
    : undefined;
}

export function createLoopbackAuthorization(
  options: LoopbackAuthorizationOptions,
): ExternalAuthorization {
  const listen = options.listen ?? listenOnLoopback;
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async authorize(start: (redirectUri: string) => Promise<string>) {
      const { promise: answered, resolve: settle } = Promise.withResolvers<
        ExternalAuthorizationCallback | Error
      >();
      const listener = await listen((request, response) => {
        const url = new URL(String(request.url), "http://127.0.0.1");
        if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
          page(response, 404, options.translator.t("student.auth.external-failed"));
          return;
        }
        const callback = callbackOf(url);
        page(
          response,
          callback === undefined ? 400 : 200,
          options.translator.t(
            callback === undefined
              ? "student.auth.external-failed"
              : "student.auth.external-complete",
          ),
        );
        settle(callback ?? new Error("The external sign-in was not completed."));
      });
      const timer = setTimeout(() => {
        settle(new Error("The external sign-in timed out."));
      }, timeoutMs);
      try {
        const url = await start(`http://127.0.0.1:${String(listener.port)}${CALLBACK_PATH}`);
        options.output.error(`${options.translator.t("student.auth.external-open", { url })}\n`);
        openBrowser(url);
        const result = await answered;
        if (result instanceof Error) throw result;
        return result;
      } finally {
        clearTimeout(timer);
        listener.close();
      }
    },
  });
}
