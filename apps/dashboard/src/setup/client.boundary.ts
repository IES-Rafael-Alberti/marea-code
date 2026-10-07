import * as z from "zod";
import { ServerSetupRequestSchema, type ServerSetupRequest } from "@marea/protocol";
import { ProviderSettingsDescriptorSchema } from "@marea/plugin-api";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
import { SettingsResponse } from "../modules/server-settings/client.boundary.js";

export function createSetupClient(token: string, fetchRequest: DashboardFetch) {
  const send = (init: Parameters<DashboardFetch>[1]) =>
    fetchRequest("/setup/api", {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${token}`,
      },
    });
  const authenticated: DashboardFetch = (_url, init) => send(init);
  return {
    fetch: authenticated,
    async read(signal: AbortSignal) {
      const response = await send({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "read" }),
        signal,
      });
      if (!response.ok) throw new Error("setup-unavailable");
      const text = await response.text();
      if (text.length > 262144) throw new Error("invalid-setup-response");
      return z
        .object({
          settings: SettingsResponse,
          identityProviders: z
            .array(
              z.object({ id: z.string(), descriptor: ProviderSettingsDescriptorSchema }).strict(),
            )
            .max(8),
        })
        .strict()
        .parse(JSON.parse(text));
    },
    async finish(setup: ServerSetupRequest) {
      const response = await send({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "finish", setup: ServerSetupRequestSchema.parse(setup) }),
      });
      if (!response.ok) throw new Error("setup-unavailable");
      const text = await response.text();
      if (text.length > 4096) throw new Error("invalid-setup-response");
      return z
        .object({ dashboardUrl: z.url({ protocol: /^https?$/ }) })
        .strict()
        .parse(JSON.parse(text)).dashboardUrl;
    },
  };
}
export type SetupClient = ReturnType<typeof createSetupClient>;
