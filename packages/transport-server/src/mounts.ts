function validMount(path: string): boolean {
  if (path.length > 128 || !path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._~-]+$/u.test(segment));
}

export function validateTransportMounts(stream: string, session: string): void {
  if (!validMount(stream) || !validMount(session) || stream === session) {
    throw new TypeError("Transport mounts must be distinct static absolute paths.");
  }
}
