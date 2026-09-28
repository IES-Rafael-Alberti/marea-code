/** Loopback-only HTTP adapter shared by compiled synthetic host journeys. */
export function syntheticHostPost(origin: string) {
  return (path: string, body: object, cookie = "") =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
}
