import { DEVELOPMENT_SOFTWARE_VERSION, SoftwareVersionSchema } from "@marea/protocol";

import { INJECTED_RELEASE_VERSION } from "./release-version.js";

/** The version this student program reports: the injected release, otherwise development. */
export function studentClientVersion(
  injected: string | undefined = INJECTED_RELEASE_VERSION,
): string {
  return SoftwareVersionSchema.parse(injected ?? DEVELOPMENT_SOFTWARE_VERSION);
}
