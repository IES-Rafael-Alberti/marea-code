import { acquireInstallation } from "../src/platform/operator-cli/installation-lock.js";
import { createOperationsApplication } from "../src/platform/operations-cli/operations-application.js";
import { readOperationsConfig } from "../src/platform/operations-cli/operations-config.js";

// Test-only compiled driver: kill at an observed durable boundary, not a production failpoint.
const [root, boundary] = process.argv.slice(2);
if (root === undefined) throw new Error("installation required");
const owned = acquireInstallation(root);
const app = createOperationsApplication(
  owned.capability,
  readOperationsConfig(root),
  () => new Date().toISOString(),
  {
    acquire: acquireInstallation,
    read: readOperationsConfig,
    profileUpgradeDurable: (step) => {
      if (step === boundary) process.kill(process.pid, "SIGKILL");
    },
  },
);
try {
  await app.upgradeProfiles(`crash-${String(boundary)}`);
} finally {
  app.close();
  owned.release();
}
