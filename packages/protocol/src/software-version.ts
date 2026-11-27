/**
 * The version a build reports when the release workflow did not inject one. It is a valid
 * software version on the wire, so released servers still accept a development client.
 */
export const DEVELOPMENT_SOFTWARE_VERSION = "0.0.0-dev";

/** Whether a student or teacher should be told about two versions; development builds never are. */
export function softwareVersionsDiffer(first: string, second: string): boolean {
  return (
    first !== second &&
    first !== DEVELOPMENT_SOFTWARE_VERSION &&
    second !== DEVELOPMENT_SOFTWARE_VERSION
  );
}
