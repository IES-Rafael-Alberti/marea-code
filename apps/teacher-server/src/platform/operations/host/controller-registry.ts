import type { HostRuntimeDependencies } from "./contracts.js";
import type { HostRuntimeController } from "./runtime.js";

type HostRuntimeControllerConstructor = new (
  dependencies: HostRuntimeDependencies,
) => HostRuntimeController;

const CONTROLLERS = new WeakMap<object, HostRuntimeController>();

export function controllerFor(
  dependencies: HostRuntimeDependencies,
  Controller: HostRuntimeControllerConstructor,
): HostRuntimeController {
  const existing = CONTROLLERS.get(dependencies);
  if (existing !== undefined) return existing;
  const controller = new Controller(dependencies);
  CONTROLLERS.set(dependencies, controller);
  return controller;
}
