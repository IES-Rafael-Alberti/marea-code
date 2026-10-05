import { IdentityProviderError, type IdentityProviderRuntime } from "@marea/plugin-api";

/** Network failures and server errors are temporary; a refused request is a denial. */
export async function googleRequest(
  runtime: IdentityProviderRuntime,
  request: Request,
): Promise<Response> {
  let response: Response;
  try {
    response = await runtime.fetch(request);
  } catch {
    throw new IdentityProviderError("unavailable", "Google could not be reached.");
  }
  if (response.status >= 500)
    throw new IdentityProviderError("unavailable", "Google is temporarily unavailable.");
  return response;
}

export async function googleJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new IdentityProviderError("invalid-response", "Google returned an unreadable answer.");
  }
}
