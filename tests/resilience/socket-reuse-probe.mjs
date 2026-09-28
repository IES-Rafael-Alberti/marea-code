/* global Bun, Response, ReadableStream, TextEncoder, fetch, AbortSignal, console, process */
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";

assert.equal(Bun.version, JSON.parse(readFileSync("package.json", "utf8")).engines.bun);
const rounds = Number(process.env.RESILIENCE_SOCKET_ROUNDS ?? 12);
const idleSeconds = Number(process.env.RESILIENCE_SOCKET_IDLE_SECONDS ?? 10);
assert.ok(rounds > 0 && rounds <= 100 && idleSeconds >= 1 && idleSeconds <= 10);
const startedAt = new Date().toISOString();
const encoder = new TextEncoder();
const probe = async (reuse) => {
  const state = { reuse, received: 0, cancelled: 0, failures: [], rounds: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: idleSeconds,
    async fetch(request, listener) {
      const body = await request.text();
      const peer = listener.requestIP(request);
      state.received++;
      if (body === "cancel") {
        let cancelled = false;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(5);
              if (!cancelled) controller.enqueue(encoder.encode("x".repeat(8192)));
            },
            cancel() {
              cancelled = true;
              state.cancelled++;
            },
          }),
        );
      }
      if (body === "stream") listener.timeout(request, 0);
      return Response.json({ port: peer?.port, body });
    },
  });
  const request = (body) =>
    fetch(server.url, {
      method: "POST",
      body,
      keepalive: reuse,
      signal: AbortSignal.timeout(5000),
    });
  try {
    for (let cycle = 0; cycle < rounds; cycle++) {
      const responses = await Promise.allSettled(
        Array.from({ length: 30 }, async () => {
          const response = await request("stream");
          const value = await response.json();
          const ack = await request("ack");
          await ack.text();
          return value.port;
        }),
      );
      const ports = responses
        .filter((item) => item.status === "fulfilled")
        .map((item) => item.value);
      for (const item of responses.filter((item) => item.status === "rejected"))
        state.failures.push({ cycle, code: item.reason.code, message: item.reason.message });
      const cancel = await request("cancel");
      await Bun.sleep(100);
      await cancel.body.cancel();
      // Deliberately sweep either side of the server idle boundary; never retry failures.
      const pauseMs = Math.max(1, idleSeconds * 1000 - 400 + (cycle % 5) * 200);
      state.rounds.push({ cycle, ports, pauseMs });
      await Bun.sleep(pauseMs);
    }
  } catch (error) {
    state.failures.push({ phase: "cancellation", code: error.code, message: error.message });
  } finally {
    await server.stop(true);
  }
  return state;
};
const results = await Promise.all([probe(true), probe(false)]);
const receipt = {
  startedAt,
  finishedAt: new Date().toISOString(),
  runtime: Bun.version,
  rounds,
  idleSeconds,
  results,
  boundary:
    "Isolated Bun HTTP reuse/cancellation diagnostic; no Marea process, no acceptance claim, no automatic retries",
};
writeFileSync(
  `reports/resilience/socket-reuse-${idleSeconds}s.json`,
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt));
