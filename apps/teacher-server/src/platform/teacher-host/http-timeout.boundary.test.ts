import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("delivers JSON after more than Bun's default ten seconds of HTTP idleness", async () => {
  const moduleUrl = new URL("./bun-serve.boundary.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)("bun", [
    "--eval",
    `
    import { bunServe } from ${JSON.stringify(moduleUrl)};
    const host = bunServe({ hostname: "127.0.0.1", port: 0, fetch: async () => {
      await Bun.sleep(11_000);
      return Response.json({ completed: true });
    }});
    try {
      const response = await fetch(host.url);
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    } finally { await host.stop(); }
  `,
  ]);
  expect(JSON.parse(stdout)).toEqual({ status: 200, body: { completed: true } });
}, 20_000);
