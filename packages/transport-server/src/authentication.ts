import type { MiddlewareHandler } from "hono";

import type {
  AuthenticatedPrincipal,
  AuthenticationPort,
  AuthenticationResult,
} from "./contracts.js";
import type { BunUpgradeEnvironment } from "./bun-websocket.boundary.js";
import { publicError } from "./public-errors.js";

export interface TransportEnvironment {
  readonly Bindings: BunUpgradeEnvironment;
  readonly Variables: {
    readonly principal: AuthenticatedPrincipal;
  };
}

export function parseBearerCredential(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length > 8_192 ||
    value.slice(0, 7).toLowerCase() !== "bearer "
  ) {
    return undefined;
  }
  const credential = value.slice(7);
  return credential !== "" && !/\s/u.test(credential) ? credential : undefined;
}

function validPrincipal(principal: AuthenticatedPrincipal): boolean {
  const containsControlCharacter = Array.from(principal.id).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return principal.id.length > 0 && principal.id.length <= 128 && !containsControlCharacter;
}

export function authenticationMiddleware(
  authentication: AuthenticationPort,
): MiddlewareHandler<TransportEnvironment> {
  return async (context, next) => {
    const credential = parseBearerCredential(context.req.header("authorization"));
    if (credential === undefined) {
      return publicError(401, "authentication_failed", true);
    }
    let result: AuthenticationResult;
    try {
      result = await authentication.authenticate(credential, context.req.raw.signal);
    } catch {
      return publicError(503, "authentication_unavailable");
    }
    if (!result.authenticated) {
      return publicError(401, "authentication_failed", true);
    }
    if (!validPrincipal(result.principal)) {
      return publicError(503, "authentication_unavailable");
    }
    context.set("principal", result.principal);
    await next();
    return context.res;
  };
}
