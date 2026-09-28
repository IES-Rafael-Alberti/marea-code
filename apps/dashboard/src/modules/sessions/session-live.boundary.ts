/** A notification is only a hint: authorized history remains the source of truth. */
export function subscribeSessionChanges(changed: () => void): () => void {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") return () => undefined;
  let closed = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const url = new URL("/api/v1/dashboard/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      socket = new WebSocket(url);
    } catch {
      timer = setTimeout(connect, 3000);
      return;
    }
    socket.onmessage = (event) => {
      if (!closed && event.data === "changed") changed();
    };
    socket.onopen = () => {
      if (!closed) changed();
    };
    socket.onclose = () => {
      if (!closed) timer = setTimeout(connect, 3000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
  };
}
