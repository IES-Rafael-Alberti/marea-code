import type { ServerSettings } from "../src/server-settings/contracts.js";
/** An administrator with no inference route or external destination configured. */
export function emptyServerSettings(administrator: string): ServerSettings {
  return {
    version: 1,
    revision: 0,
    administrators: [administrator],
    connections: {},
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
  };
}
