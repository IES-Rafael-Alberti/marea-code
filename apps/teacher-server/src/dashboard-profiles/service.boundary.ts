import { parseDashboardProfileRequest } from "./request.boundary.js";
import { type DashboardModuleSelection, type DashboardProfileScope } from "@marea/protocol";
import type { AuthenticatedIdentity, Clock, IdGenerator } from "../identity/contracts.js";
import {
  DashboardProfileError,
  type DashboardProfileAuthority,
  type DashboardProfileEndpoint,
  type DashboardProfileRelease,
  type DashboardProfileStore,
} from "./contracts.js";
import { validateDashboardProfileRelease } from "./release.js";
import { recoverDashboardProfile } from "./recovery.boundary.js";

export function createDashboardProfileService<S extends DashboardModuleSelection>(dependencies: {
  readonly store: DashboardProfileStore;
  readonly release: DashboardProfileRelease<S>;
  readonly authority: DashboardProfileAuthority;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly currentCatalogRevision: () => string;
}): DashboardProfileEndpoint {
  const release = validateDashboardProfileRelease(dependencies.release);
  const { store, clock, ids } = dependencies;
  const permits = (identity: AuthenticatedIdentity, scope: DashboardProfileScope, id: string) => {
    return release.modules
      .filter((module) => dependencies.authority.permits(identity, scope, module))
      .some((module) => module.id === id);
  };
  const read = (
    identity: AuthenticatedIdentity,
    scope: DashboardProfileScope,
    requestId: string,
  ) => {
    const allowed = (id: string) => permits(identity, scope, id);
    const personal = recoverDashboardProfile(
      store.read(identity.userId, null),
      true,
      release,
      allowed,
    );
    const override =
      scope.kind === "class"
        ? recoverDashboardProfile(
            store.read(identity.userId, scope.classId),
            false,
            release,
            allowed,
          )
        : null;
    const effective = { ...release.defaults, ...personal.record.value, ...override?.record.value };
    effective.modules = effective.modules.filter(
      (module) => module.enabled && allowed(module.moduleId),
    );
    const state = release.schemas.state.parse({
      protocolVersion: "0.1",
      requestId,
      kind: "dashboard-profile-state",
      schemaVersion: 1,
      scope,
      generatedAt: clock.now(),
      catalogRevision: release.revision,
      personal: personal.record,
      override: override?.record ?? null,
      effective,
      warnings: [...personal.warnings, ...(override?.warnings ?? [])].slice(0, 64),
    });
    return {
      state,
      discarded: (override ?? personal).discarded,
    };
  };
  return {
    execute(identity, operation, bytes) {
      const request = parseDashboardProfileRequest(release.schemas, operation, bytes, release);
      try {
        return store.transaction(() => {
          const classId = request.scope.kind === "class" ? request.scope.classId : null;
          if (identity.role !== "teacher" || !store.authorized(identity.userId, classId))
            throw new DashboardProfileError(403);
          if (request.kind === "dashboard-profile-catalog")
            return release.catalogSchema.parse({
              ...request,
              kind: "dashboard-profile-catalog-result",
              catalogRevision: release.revision,
              modules: release.modules.filter((module) =>
                permits(identity, request.scope, module.id),
              ),
              themes: release.themes,
              releaseDefaults: {
                ...release.defaults,
                modules: release.defaults.modules.filter((module) =>
                  permits(identity, request.scope, module.moduleId),
                ),
              },
            });
          const before = read(identity, request.scope, request.requestId);
          if (request.kind === "dashboard-profile-read") return before.state;
          const scopeRecord = before.state.override ?? before.state.personal;
          if (
            request.expectedRevision !== scopeRecord.revision ||
            request.expectedPersonalRevision !== before.state.personal.revision ||
            request.catalogRevision !== release.revision ||
            dependencies.currentCatalogRevision() !== release.revision
          )
            throw new DashboardProfileError(409);
          if (request.kind === "dashboard-profile-save") {
            if (
              scopeRecord.status === "recovery-required" ||
              (before.discarded && !request.discardUnavailable)
            )
              throw new DashboardProfileError(409);
            if (
              request.value.modules?.some(
                (module) => !permits(identity, request.scope, module.moduleId),
              )
            )
              throw new DashboardProfileError(403);
          }
          store.write(identity.userId, classId, {
            schemaVersion: 1,
            revision: ids.createId("revision"),
            updatedAt: clock.now(),
            serializedValue:
              request.kind === "dashboard-profile-reset" ? null : JSON.stringify(request.value),
          });
          return read(identity, request.scope, request.requestId).state;
        });
      } catch (error) {
        throw new DashboardProfileError(
          error instanceof DashboardProfileError ? error.status : 500,
          request.requestId,
        );
      }
    },
  };
}
