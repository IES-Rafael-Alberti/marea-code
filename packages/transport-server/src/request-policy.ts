import type { TransportPolicy } from "./contracts.js";

export type RequestPolicyDecision = { readonly allowed: false } | { readonly allowed: true };

export interface RequestPolicyEvaluation {
  readonly allowSearch?: boolean;
  readonly requireOrigin?: boolean;
}

function normalizedAuthority(authority: string): string {
  if (/[\s@]/u.test(authority)) {
    return "";
  }
  const structure = /^(?:\[[^\]]+\]|[^:]+)(?::(0|[1-9]\d*))?$/u.exec(authority);
  if (structure === null) {
    return "";
  }
  const value = `http://${authority}`;
  if (!URL.canParse(value)) {
    return "";
  }
  const url = new URL(value);
  return url.pathname === "/" && url.search === "" && url.hash === ""
    ? JSON.stringify([url.hostname, structure[1]])
    : "";
}

function normalizedOrigin(value: string): string {
  if (!URL.canParse(value)) {
    return "";
  }
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
    ? url.origin
    : "";
}

export class RequestPolicy {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(policy: TransportPolicy) {
    const hosts = policy.allowedHosts.map((host) => normalizedAuthority(host));
    const origins = policy.allowedOrigins.map((origin) => normalizedOrigin(origin));
    const validHosts = hosts.filter((host) => host !== "");
    const validOrigins = origins.filter((origin) => origin !== "");
    if (
      hosts.length === 0 ||
      origins.length === 0 ||
      validHosts.length !== hosts.length ||
      validOrigins.length !== origins.length
    ) {
      throw new TypeError("Transport policy contains an invalid host or origin.");
    }
    this.#allowedHosts = new Set(validHosts);
    this.#allowedOrigins = new Set(validOrigins);
  }

  evaluate(request: Request, options: RequestPolicyEvaluation = {}): RequestPolicyDecision {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    if (requestUrl.search !== "" && options.allowSearch !== true) {
      return { allowed: false };
    }
    const normalizedRequestHost = normalizedAuthority(host ?? requestUrl.host);
    const originAllowed =
      origin === null
        ? options.requireOrigin === false
        : this.#allowedOrigins.has(normalizedOrigin(origin));
    const allowed =
      request.headers.has("host") && this.#allowedHosts.has(normalizedRequestHost) && originAllowed;
    return { allowed };
  }
}
