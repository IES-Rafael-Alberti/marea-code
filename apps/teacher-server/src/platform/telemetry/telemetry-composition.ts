import { TELEMETRY_PREVIEW_PATH } from "@marea/protocol";
import {
  createOperationalTelemetry,
  type OperationalTelemetryRuntime,
} from "@marea/telemetry-pipeline";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type {
  ProductIdentityService,
  TeacherProductHttpApplication,
} from "../../product-http/contracts.js";
import { createTelemetryPreviewHttp } from "../../telemetry/preview-http.boundary.js";
import { createTelemetryPreviewService } from "../../telemetry/preview-service.js";
import { parseOperationalTelemetryConfiguration } from "../../telemetry/operational-configuration.boundary.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";

/** The caller supplies the same runtime used for host emission and shutdown. */
export function withTelemetryPreview(
  product: TeacherProductHttpApplication,
  options: {
    readonly telemetry?: OperationalTelemetryRuntime;
    readonly database: SqliteApplicationDatabase;
    readonly identity: ProductIdentityService;
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
  },
): TeacherProductHttpApplication {
  const telemetry =
    options.telemetry ??
    createOperationalTelemetry(parseOperationalTelemetryConfiguration(undefined));
  const preview = createTelemetryPreviewHttp({
    ...options,
    service: createTelemetryPreviewService({
      membership: new SqliteTeachingConfigurationRepository(options.database),
      telemetry,
    }),
  });
  return {
    fetch: (request) =>
      new URL(request.url).pathname === TELEMETRY_PREVIEW_PATH
        ? preview.fetch(request)
        : product.fetch(request),
  };
}
