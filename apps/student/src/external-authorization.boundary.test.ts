/* eslint-disable @typescript-eslint/require-await */
import { createTranslator, type Translator } from "@marea/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
  calls: [] as { command: string; args: readonly string[]; options: object }[],
  handlers: [] as { event: string; handler: () => void }[],
  unrefs: 0,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[], options: object) => {
    spawned.calls.push({ command, args, options });
    return {
      on: (event: string, handler: () => void) => {
        spawned.handlers.push({ event, handler });
      },
      unref: () => {
        spawned.unrefs += 1;
      },
    };
  },
}));

import {
  createLoopbackAuthorization,
  listenOnLoopback,
  openSystemBrowser,
  type LoopbackListen,
  type LoopbackRequest,
  type LoopbackResponse,
} from "./external-authorization.boundary.js";

beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout");
  vi.spyOn(globalThis, "clearTimeout");
});

afterEach(() => {
  vi.restoreAllMocks();
  spawned.calls.length = 0;
  spawned.handlers.length = 0;
  spawned.unrefs = 0;
});

type Handler = (request: LoopbackRequest, response: LoopbackResponse) => void;

function harness() {
  const state: { handler?: Handler; closed: number } = { closed: 0 };
  const listen: LoopbackListen = (handle) => {
    state.handler = handle;
    return Promise.resolve({
      port: 4321,
      close: () => {
        state.closed += 1;
      },
    });
  };
  const call = (url: string | undefined, method = "GET") => {
    const written: { status?: number; headers?: Record<string, string>; body?: string } = {};
    state.handler?.(
      { method, url },
      {
        writeHead: (status: number, headers: Record<string, string>) => {
          written.status = status;
          written.headers = headers;
        },
        end: (body: string) => {
          written.body = body;
        },
      },
    );
    return written;
  };
  return { state, listen, call };
}

const translator = createTranslator("en");

/** An authorization waiting on its loopback callback, with no browser and no output. */
async function listening(text: Translator) {
  const test = harness();
  const pending = createLoopbackAuthorization({
    translator: text,
    output: { error: () => undefined },
    openBrowser: () => undefined,
    listen: test.listen,
  }).authorize(async () => "https://accounts.example.test/auth");
  await vi.waitFor(() => {
    expect(test.state.handler).toBeDefined();
  });
  return { test, pending };
}

describe("loopback external authorization", () => {
  it("serves the provider answer once on its callback and reports progress", async () => {
    const test = harness();
    const shown: string[] = [];
    const opened: string[] = [];
    const authorization = createLoopbackAuthorization({
      translator,
      output: { error: (text) => shown.push(text) },
      openBrowser: (url) => opened.push(url),
      listen: test.listen,
    });
    const redirects: string[] = [];
    const pending = authorization.authorize(async (redirectUri) => {
      redirects.push(redirectUri);
      return "https://accounts.example.test/auth?x=1";
    });
    await vi.waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(test.call("/elsewhere").status).toBe(404);
    expect(test.call("/callback?code=a&state=b", "POST").status).toBe(404);
    const done = test.call("/callback?code=4%2Fcode&state=xyz");
    await expect(pending).resolves.toEqual({ code: "4/code", state: "xyz" });
    const limit = vi.mocked(setTimeout).mock.calls.findIndex(([, delay]) => delay === 300_000);
    expect(clearTimeout).toHaveBeenCalledWith(vi.mocked(setTimeout).mock.results[limit]?.value);
    expect(redirects).toEqual(["http://127.0.0.1:4321/callback"]);
    expect(shown).toEqual([
      "Open this address in your browser to continue: https://accounts.example.test/auth?x=1\n",
    ]);
    expect(opened).toEqual(["https://accounts.example.test/auth?x=1"]);
    expect(done).toEqual({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
      body: '<!doctype html><meta charset="utf-8"><title>Marea</title><p>You can close this window and return to Marea.</p>',
    });
    expect(test.state.closed).toBe(1);
  });

  it.each([
    "/callback?error=access_denied&code=a&state=b",
    "/callback?code=a",
    "/callback?state=b",
    "/callback?code=a%20b&state=b",
    `/callback?code=${"a".repeat(2_049)}&state=b`,
  ])("rejects an incomplete or failed answer %s", async (url) => {
    const { test, pending } = await listening(translator);
    const answer = test.call(url);
    expect(answer.status).toBe(400);
    expect(answer.body).toContain("Sign-in could not be completed.");
    await expect(pending).rejects.toThrow("The external sign-in was not completed.");
    expect(test.state.closed).toBe(1);
  });

  it("escapes page text and treats a request without a target as unknown", async () => {
    const { test, pending } = await listening({ locale: "en", t: () => "<b>&</b>" });
    const unknownTarget = test.call(undefined);
    expect(unknownTarget.status).toBe(404);
    expect(unknownTarget.body).toContain("<p>&lt;b&gt;&amp;&lt;/b&gt;</p>");
    test.call("/callback?code=a&state=b");
    await expect(pending).resolves.toEqual({ code: "a", state: "b" });
  });

  it("gives up after its time limit and closes the listener when starting fails", async () => {
    const slow = harness();
    await expect(
      createLoopbackAuthorization({
        translator,
        output: { error: () => undefined },
        openBrowser: () => undefined,
        listen: slow.listen,
        timeoutMs: 5,
      }).authorize(async () => "https://accounts.example.test/auth"),
    ).rejects.toThrow("The external sign-in timed out.");
    expect(slow.state.closed).toBe(1);
    const failing = harness();
    await expect(
      createLoopbackAuthorization({
        translator,
        output: { error: () => undefined },
        listen: failing.listen,
      }).authorize(() => Promise.reject(new Error("begin failed"))),
    ).rejects.toThrow("begin failed");
    expect(failing.state.closed).toBe(1);
    expect(spawned.calls).toEqual([]);
  });

  it("opens the system browser by default and listens only on this machine", async () => {
    const authorization = createLoopbackAuthorization({
      translator,
      output: { error: () => undefined },
    });
    const pending = authorization.authorize(async (redirectUri) => {
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
      // Longer than a mistaken default time limit of a fraction of a second.
      setTimeout(() => {
        void fetch(`${redirectUri}?code=real&state=socket`, { headers: { connection: "close" } });
      }, 200);
      return "https://accounts.example.test/auth";
    });
    await expect(pending).resolves.toEqual({ code: "real", state: "socket" });
    expect(spawned.calls).toHaveLength(1);
  });

  it("listens on an ephemeral unprivileged port of this machine only", async () => {
    const listener = await listenOnLoopback((_request, response) => {
      response.end("ok");
    });
    expect(listener.address).toBe("127.0.0.1");
    expect(listener.port).toBeGreaterThanOrEqual(1_024);
    const url = `http://127.0.0.1:${String(listener.port)}/`;
    expect(await (await fetch(url, { headers: { connection: "close" } })).text()).toBe("ok");
    await expect(listenOnLoopback(() => undefined, listener.port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    listener.close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it.each([
    ["darwin", "open", []],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler"]],
    ["linux", "xdg-open", []],
  ] as const)("opens addresses on %s without a shell", (platform, command, prefix) => {
    openSystemBrowser("https://a.test/?x=1&y=2", platform);
    expect(spawned.calls).toEqual([
      {
        command,
        args: [...prefix, "https://a.test/?x=1&y=2"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    expect(spawned.unrefs).toBe(1);
    expect(spawned.handlers.map(({ event }) => event)).toEqual(["error"]);
    expect(() => {
      spawned.handlers[0]?.handler();
    }).not.toThrow();
  });
});
