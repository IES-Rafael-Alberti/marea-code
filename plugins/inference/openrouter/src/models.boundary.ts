import {
  InferenceProviderError,
  ProviderModelListSchema,
  type InferenceProviderConfiguration,
} from "@marea/plugin-api";
import * as z from "zod";
import { parseOpenRouterConfiguration } from "./configuration.js";
import { modelPricing } from "./model-pricing.boundary.js";

const Catalog = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        pricing: z.unknown().optional(),
      }),
    )
    .max(5000),
});

async function readJson(response: Response, limit: number): Promise<unknown> {
  // Stryker disable next-line ConditionalExpression,CallExpression: Without the guard, null still produces the same sanitized failure.
  if (response.body === null) throw new Error();
  const reader: Pick<
    ReadableStreamDefaultReader<Uint8Array>,
    "read" | "cancel"
  > = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.length;
      if (size > limit) throw new Error();
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    await reader.cancel();
  }
}

/** Validate the credential separately: the public model list alone does not authenticate a key. */
export async function listOpenRouterModels(
  raw: InferenceProviderConfiguration,
  signal: AbortSignal,
  fetchRequest: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
) {
  const configuration = parseOpenRouterConfiguration(raw);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const get = async (path: string, limit: number) => {
    const response = await fetchRequest(new URL(`../${path}`, configuration.endpoint).toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${configuration.apiKey}` },
      redirect: "error",
      signal: bounded,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new InferenceProviderError({
        code:
          response.status === 401 || response.status === 403
            ? "authentication-failed"
            : "unavailable",
        message: "The provider connection could not be verified.",
        retryable: false,
      });
    }
    return readJson(response, limit);
  };
  try {
    z.object({ data: z.object({}) }).parse(await get("key", 65536));
    const catalog = Catalog.parse(await get("models/user", 8388608));
    return ProviderModelListSchema.parse(
      catalog.data.map((model) => ({
        id: model.id,
        name: model.name,
        pricing: modelPricing(model.pricing),
      })),
    );
  } catch (error) {
    if (error instanceof InferenceProviderError) throw error;
    throw new InferenceProviderError({
      code: "unavailable",
      message: "The provider model catalog could not be loaded.",
      retryable: false,
    });
  }
}
