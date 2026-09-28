import type { MaintenanceCoordinator } from "../contracts.js";
import type { HostMaintenanceDependencies } from "./contracts.js";
import { controllerFor } from "./controller-registry.js";
import { HostRuntimeController } from "./runtime.js";

export function createMaintenanceCoordinator(
  dependencies: HostMaintenanceDependencies,
): MaintenanceCoordinator {
  const controller = controllerFor(dependencies, HostRuntimeController);
  return Object.freeze({
    preview: controller.preview.bind(controller),
    run: controller.run.bind(controller),
  });
}
