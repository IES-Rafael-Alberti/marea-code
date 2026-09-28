import type { InferenceProviderConfiguration } from "@marea/plugin-api";
import { InferenceProviderError } from "@marea/plugin-api";

export const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterConfiguration {
  readonly apiKey: string;
  readonly endpoint: string;
}

function configurationError(): never {
  throw new InferenceProviderError({
    code: "authentication-failed",
    message: "The inference provider configuration is invalid.",
    retryable: false,
  });
}

export function parseOpenRouterConfiguration(
  configuration: InferenceProviderConfiguration,
): OpenRouterConfiguration {
  const apiKey = configuration.apiKey.trim();
  if (apiKey.length < 16 || apiKey.length > 512) {
    configurationError();
  }
  const endpoint = configuration.endpoint ?? DEFAULT_OPENROUTER_ENDPOINT;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    configurationError();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    configurationError();
  }
  return Object.freeze({ apiKey, endpoint: url.toString() });
}
