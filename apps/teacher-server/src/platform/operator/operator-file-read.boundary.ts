import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import { OperatorConfigurationError } from "./operator-configuration-errors.js";

/** Reads only the initially declared length plus one growth-detection byte. */
export function readOperatorFile(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new OperatorConfigurationError(
        "not-regular-file",
        "Operator configuration path must be a regular file.",
      );
    }
    if (status.size > maxBytes) {
      throw new OperatorConfigurationError(
        "too-large",
        "Operator configuration exceeds its byte bound.",
      );
    }
    const chunks: Buffer[] = [];
    let remaining = status.size + 1;
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(remaining, 65_536));
      const length = readSync(descriptor, chunk);
      if (length === 0) break;
      chunks.push(chunk.subarray(0, length));
      remaining -= length;
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(descriptor);
  }
}
