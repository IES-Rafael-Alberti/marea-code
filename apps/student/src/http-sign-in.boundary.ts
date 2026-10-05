import {
  ClassBootstrapResponseSchema,
  ExternalAuthBeginResponseSchema,
  ExternalAuthCompleteResponseSchema,
  ExternalAuthProvidersResponseSchema,
  type ClassBootstrapResponse,
  type ClassSelectRequest,
  type ExternalAuthBeginRequest,
  type ExternalAuthBeginResponse,
  type ExternalAuthCompleteRequest,
  type ExternalAuthCompleteResponse,
  type ExternalAuthProvidersRequest,
  type ExternalAuthProvidersResponse,
  type RequestId,
  type SessionToken,
} from "@marea/protocol";
import type * as z from "zod";

import type { AuthenticationResult, StudentServer } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";

/** The bounded JSON exchange of the student HTTP client. */
interface JsonClient {
  json<T extends { readonly requestId: RequestId }>(
    path: string,
    requestId: RequestId,
    body: object,
    schema: z.ZodType<T>,
    credential?: string,
  ): Promise<T>;
}

export const SIGN_IN_HTTP_PATHS = Object.freeze({
  beginExternal: "/v1/auth/external/begin",
  completeExternal: "/v1/auth/external/complete",
  externalProviders: "/v1/auth/external/providers",
  selectClass: "/v1/classes/select",
});

export interface SignInHttpPaths {
  readonly selectClass?: string;
  readonly externalProviders?: string;
  readonly beginExternal?: string;
  readonly completeExternal?: string;
}

/** A rejected session credential is an expected outcome; every other failure propagates. */
export async function authenticatedJson<T>(
  request: () => Promise<T>,
): Promise<AuthenticationResult<T>> {
  try {
    return { authenticated: true, value: await request() };
  } catch (error) {
    if (error instanceof StudentHttpError && error.code === "auth.invalid") {
      return { authenticated: false };
    }
    throw error;
  }
}

/** Class selection and external sign-in, each at its configured or fixed endpoint. */
export function signInMethods(
  client: JsonClient,
  paths: SignInHttpPaths,
): Pick<StudentServer, "selectClass" | "externalProviders" | "beginExternal" | "completeExternal"> {
  return {
    selectClass: (
      token: SessionToken,
      request: ClassSelectRequest,
    ): Promise<AuthenticationResult<ClassBootstrapResponse>> =>
      authenticatedJson(() =>
        client.json(
          paths.selectClass ?? SIGN_IN_HTTP_PATHS.selectClass,
          request.requestId,
          request,
          ClassBootstrapResponseSchema,
          token,
        ),
      ),
    externalProviders: (
      request: ExternalAuthProvidersRequest,
    ): Promise<ExternalAuthProvidersResponse> =>
      client.json(
        paths.externalProviders ?? SIGN_IN_HTTP_PATHS.externalProviders,
        request.requestId,
        request,
        ExternalAuthProvidersResponseSchema,
      ),
    beginExternal: (request: ExternalAuthBeginRequest): Promise<ExternalAuthBeginResponse> =>
      client.json(
        paths.beginExternal ?? SIGN_IN_HTTP_PATHS.beginExternal,
        request.requestId,
        request,
        ExternalAuthBeginResponseSchema,
      ),
    completeExternal: (
      request: ExternalAuthCompleteRequest,
    ): Promise<ExternalAuthCompleteResponse> =>
      client.json(
        paths.completeExternal ?? SIGN_IN_HTTP_PATHS.completeExternal,
        request.requestId,
        request,
        ExternalAuthCompleteResponseSchema,
      ),
  };
}
