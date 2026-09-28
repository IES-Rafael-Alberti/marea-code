import type { HostLifecycle } from "../contracts.js";
import type { HostLifecycleDependencies } from "./contracts.js";
import { controllerFor } from "./controller-registry.js";
import { HostRuntimeController } from "./runtime.js";

export function createHostLifecycle(dependencies: HostLifecycleDependencies): HostLifecycle {
  const controller = controllerFor(dependencies, HostRuntimeController);
  return Object.freeze({
    start: controller.start.bind(controller),
    shutdown: controller.shutdown.bind(controller),
    offlineDiagnose: controller.offlineDiagnose.bind(controller),
  });
}
