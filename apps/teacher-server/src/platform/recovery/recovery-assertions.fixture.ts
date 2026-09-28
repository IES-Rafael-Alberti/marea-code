import { expect } from "vitest";

import type { RecoveryErrorCode } from "./contracts.js";
import { RecoveryBundleError } from "./contracts.js";

export function expectRecoveryError(
  operation: () => unknown,
  code: RecoveryErrorCode,
): RecoveryBundleError {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RecoveryBundleError);
  const recoveryError = error as RecoveryBundleError;
  expect(recoveryError.name).toBe("RecoveryBundleError");
  expect(recoveryError.code).toBe(code);
  expect(recoveryError.message).toBe(code);
  return recoveryError;
}
