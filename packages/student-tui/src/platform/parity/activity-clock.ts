import { useEffect, useState } from "react";
import type { StatusState } from "../../parity/status.js";

/** An activity keeps its clock across streamed tokens and stops while waiting. */
export function useActivityClock(status: StatusState): StatusState {
  const [elapsed, setElapsed] = useState(0);
  const running = status.elapsedMs !== null;
  useEffect(() => {
    setElapsed(0);
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - started);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running, status.activity, status.toolName]);
  return { ...status, elapsedMs: status.elapsedMs === null ? null : status.elapsedMs + elapsed };
}
