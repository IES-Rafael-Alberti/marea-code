import { statfsSync } from "node:fs";

import type { DiskSpacePort } from "./database-port.js";

// Stryker disable BlockStatement: an empty failure handler also returns undefined.
function availableBytes(directory: string): number | undefined {
  try {
    // Stryker disable next-line BooleanLiteral,ObjectLiteral: plain numbers give the same figure below 2^53 bytes; bigint only guards overflow.
    const volume = statfsSync(directory, { bigint: true });
    return Number(volume.bavail * volume.bsize);
  } catch {
    return undefined;
  }
}
// Stryker restore BlockStatement

export const diskSpace: DiskSpacePort = Object.freeze({ freeBytes: availableBytes });
