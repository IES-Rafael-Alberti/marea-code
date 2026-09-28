import { readGovernancePages } from "./governance-controller-pagination.js";
import { resetCenterScope } from "./governance-controller-scopes.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

export function loadAccess(runtime: GovernanceControllerRuntime): Promise<void> {
  if (runtime.disposed) return Promise.resolve();
  runtime.beginAccessRefresh();
  const epoch = runtime.currentCenterEpoch();
  return runtime.read(
    () => runtime.client.access(runtime.abort.signal),
    () => runtime.isCurrentCenter(epoch),
    (response) => {
      runtime.update({ access: response.access, problem: null });
    },
  );
}

export function loadCenters(runtime: GovernanceControllerRuntime): Promise<void> {
  if (runtime.disposed || runtime.state.access?.administrator !== true) return Promise.resolve();
  const epoch = runtime.currentCenterEpoch();
  const token = runtime.requests.centers.begin();
  const current = (): boolean =>
    runtime.isCurrentCenter(epoch) && runtime.requests.centers.isLatest(token);
  return runtime.read(
    () =>
      readGovernancePages(
        (afterId) => runtime.client.centers({ afterId }, runtime.abort.signal),
        (center) => center.centerId,
        current,
      ),
    current,
    (centers) => {
      const selectedMissing = !centers.some((center) => center.centerId === runtime.state.centerId);
      if (selectedMissing) runtime.invalidateCenter();
      runtime.update({
        ...(selectedMissing ? resetCenterScope(null) : {}),
        centers,
        centersLoaded: true,
        problem: null,
      });
    },
  );
}
