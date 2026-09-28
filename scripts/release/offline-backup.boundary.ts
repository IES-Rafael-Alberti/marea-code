import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import { createOperationsApplication } from "../../apps/teacher-server/src/platform/operations-cli/operations-application.js";
import { readOperationsConfig } from "../../apps/teacher-server/src/platform/operations-cli/operations-config.js";

/** Uses the same exclusive lock and deletion-authorized recovery bundle as operations CLI. */
export async function withOfflineBackup<T>(
  installation: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = acquireInstallation(installation);
  try {
    const config = readOperationsConfig(installation);
    const app = createOperationsApplication(owner.capability, config, () =>
      new Date().toISOString(),
    );
    try {
      await app.createBackup(`release-${String(Date.now())}`);
      owner.capability.assertOwned();
      return await operation();
    } finally {
      app.close();
    }
  } finally {
    owner.release();
  }
}
