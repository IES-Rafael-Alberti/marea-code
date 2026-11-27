/**
 * The release workflow rewrites this file in its build workspace (scripts/release/build.ts).
 * Every other build, including tests and local compilations, leaves it undefined.
 */
export const INJECTED_RELEASE_VERSION: string | undefined = undefined;
