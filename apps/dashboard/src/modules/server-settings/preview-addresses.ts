/** A command is meant for another computer, so loopback and wildcard hosts are never offered. */
export function studentOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    !/^[A-Za-z0-9.:[\]-]+$/u.test(url.hostname)
  )
    return null;
  const host = url.hostname.replace(/\.$/u, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (host.startsWith("127.") && /^[\d.]+$/u.test(host)) ||
    ["0.0.0.0", "[::]", "[::1]"].includes(host) ||
    /\[::ffff:(?:0:0|7f[\da-f]{2}:[\da-f]+)\]/iu.test(host)
  )
    return null;
  return url.origin;
}

export function studentAddressChoices(origins: readonly string[], browserOrigin: string) {
  const current = studentOrigin(browserOrigin);
  const choices = [
    ...new Set(
      [browserOrigin, ...origins].flatMap((origin) => {
        const value = studentOrigin(origin);
        return value === null ? [] : [value];
      }),
    ),
  ];
  return { choices, initial: current ?? (choices.length > 1 ? "" : (choices[0] ?? "")) };
}
