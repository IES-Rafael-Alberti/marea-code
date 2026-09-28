import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import { createLangfuseExporter } from "./exporter.js";
import { envelope, settings, signal } from "./exporter.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

// Run the collector on Node even under Bun: test actual TCP closure independently
// of Bun's node:http/node:net close-event emulation.
it.each(["timeout", "limit", "shutdown"])(
  "closes the native collector socket on %s",
  async (mode) => {
    const child = spawn(
      "node",
      [
        "--input-type=module",
        "-e",
        `
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      request.socket.once('close', () => process.stdout.write('closed\\n'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(${JSON.stringify(mode === "limit" ? " ".repeat(10) : "{")});
      process.stdout.write('ready\\n');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    cleanup.push(async () => {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const first = await iterator.next();
    const endpoint = `http://127.0.0.1:${String(first.value)}`;
    // Keep native TCP real while advancing the exporter deadline explicitly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const port = createLangfuseExporter(
      { ...settings, operationTimeoutMs: 200, maxResponseBytes: 5 },
      { endpoint, publicKey: "p", secretKey: "s" },
    );
    const pending = Promise.allSettled([port.export(envelope, signal())]);
    expect((await iterator.next()).value).toBe("ready");
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(200);
    if (mode === "shutdown") await port.shutdown(signal());
    expect(await pending).toEqual([
      {
        status: "rejected",
        reason: new TelemetryExporterError(mode === "limit" ? "payload-too-large" : "cancelled"),
      },
    ]);
    expect((await iterator.next()).value).toBe("closed");
    await port.shutdown(signal());
    lines.close();
  },
);
