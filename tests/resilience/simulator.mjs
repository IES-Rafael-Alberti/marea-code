/* global Bun, Response, ReadableStream, TextEncoder, URL */
import { readFileSync } from "node:fs";

/** Local TLS provider/collector; timestamp is captured at each actual SSE enqueue. */
export async function simulator(tls) {
  const state = { mode: "normal", emissions: 0, telemetry: 0, active: 0, peak: 0, barriers: [] };
  let barrier,
    releaseBarrier,
    arrived = 0,
    expected = 0;
  const burst = (count) => {
    expected = count;
    if (count > 0) state.barriers.push({ startedAt: Date.now(), expected: count, arrivals: [] });
    arrived = 0;
    barrier =
      count === 0
        ? undefined
        : new Promise((done) => {
            releaseBarrier = done;
          });
  };
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: readFileSync(tls.cert), key: readFileSync(tls.key) },
    async fetch(request) {
      await request.text();
      if (new URL(request.url).pathname !== "/model") {
        state.telemetry++;
        if (state.mode === "telemetry-failure")
          state.collectorFailures = (state.collectorFailures ?? 0) + 1;
        if (state.mode === "telemetry-timeout") {
          state.collectorTimeouts = (state.collectorTimeouts ?? 0) + 1;
          await Bun.sleep(200);
        }
        return Response.json({}, { status: state.mode === "telemetry-failure" ? 503 : 200 });
      }
      if (state.mode === "failure") return new Response("synthetic unavailable", { status: 503 });
      const mode = state.mode;
      const admission = mode === "normal" ? barrier : undefined;
      if (admission) state.barriers.at(-1).arrivals.push(Date.now());
      if (admission && ++arrived === expected) {
        const observation = state.barriers.at(-1);
        observation.durationMs = Date.now() - observation.startedAt;
        state.confirmedBursts = (state.confirmedBursts ?? 0) + 1;
        releaseBarrier();
      }
      let index = 0,
        finished = false;
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      const finish = () => {
        if (!finished) {
          finished = true;
          state.active--;
        }
      };
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (finished) return;
            if (admission) await admission;
            if (index++ < (mode === "slow" ? 512 : 4)) {
              if (index > 1) await Bun.sleep(mode === "timeout" ? 5500 : 10);
              if (finished) return;
              const text = mode === "slow" ? "x".repeat(8192) : `P5:${Date.now()};`;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
                ),
              );
              state.emissions++;
            } else {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
                ),
              );
              finish();
              controller.close();
            }
          },
          cancel: finish,
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    state,
    burst,
    endpoint: `https://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
