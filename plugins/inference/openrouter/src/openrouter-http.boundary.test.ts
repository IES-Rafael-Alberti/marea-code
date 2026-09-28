import { afterEach, describe, expect, it, vi } from "vitest";

import { EXPECTED_OPENROUTER_BODY, REQUEST } from "./openrouter.fixture.js";
import {
  openRouterHttp,
  parseOpenRouterChunk,
  parseOpenRouterData,
} from "./openrouter-http.boundary.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter HTTP boundary", () => {
  it("forwards the server output cap and rejects invalid caps before network access", async () => {
    const fetchCall =
      vi.fn<(...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    fetchCall.mockResolvedValue(new Response());
    vi.stubGlobal("fetch", Object.assign(fetchCall, { preconnect: vi.fn() }));
    const request = {
      apiKey: "server-secret",
      endpoint: "https://openrouter.example/api",
      signal: new AbortController().signal,
    };
    for (const maxOutputTokens of [1, 256, Number.MAX_SAFE_INTEGER]) {
      await openRouterHttp.send({ ...request, body: { ...REQUEST, maxOutputTokens } });
      expect(fetchCall.mock.lastCall?.[1]?.body).toBe(
        JSON.stringify({ max_tokens: maxOutputTokens, ...EXPECTED_OPENROUTER_BODY }),
      );
    }
    fetchCall.mockClear();
    for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        openRouterHttp.send({ ...request, body: { ...REQUEST, maxOutputTokens } }),
      ).rejects.toThrow();
    }
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("sends the normalized streaming request without exposing the key in its body", async () => {
    const fetchCall =
      vi.fn<(...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    fetchCall.mockResolvedValue(new Response("accepted"));
    const fetchMock: typeof fetch = Object.assign(fetchCall, { preconnect: vi.fn() });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await openRouterHttp.send({
      apiKey: "server-secret",
      body: REQUEST,
      endpoint: "https://openrouter.example/api",
      signal: controller.signal,
    });

    expect(fetchCall).toHaveBeenCalledOnce();
    const call = fetchCall.mock.calls[0];
    expect(call?.[0]).toBe("https://openrouter.example/api");
    const init = call?.[1];
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    expect(init?.headers).toEqual({
      Accept: "text/event-stream",
      Authorization: "Bearer server-secret",
      Connection: "close",
      "Content-Type": "application/json",
    });
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized OpenRouter request body.");
    }
    expect(init.body).toBe(JSON.stringify(EXPECTED_OPENROUTER_BODY));
    expect(init.body).not.toContain("server-secret");
  });

  it("omits tool fields when no tool is available", async () => {
    const fetchCall =
      vi.fn<(...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
    fetchCall.mockResolvedValue(new Response());
    const fetchMock: typeof fetch = Object.assign(fetchCall, { preconnect: vi.fn() });
    vi.stubGlobal("fetch", fetchMock);

    const firstMessage = REQUEST.messages[0];
    if (firstMessage === undefined) {
      throw new Error("Expected the request fixture to contain a message.");
    }
    await openRouterHttp.send({
      apiKey: "server-secret",
      body: {
        ...REQUEST,
        messages: [firstMessage, { content: "", role: "user" }],
        tools: [],
      },
      endpoint: "https://openrouter.example/api",
      signal: new AbortController().signal,
    });

    const body = fetchCall.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected a serialized OpenRouter request body.");
    }
    expect(body).toBe(
      JSON.stringify({
        messages: [
          { content: "Be concise.", role: "system" },
          { content: "", role: "user" },
        ],
        model: "private-model",
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    expect(body).not.toContain("tool_choice");
    expect(body).not.toContain("tool_call_id");
  });

  it("strips untrusted extra chunk fields and normalizes an empty choice", () => {
    expect(parseOpenRouterChunk({ choices: [], extra: "private" })).toEqual({
      delta: undefined,
      finishReason: undefined,
      usage: undefined,
    });
    expect(parseOpenRouterChunk({ choices: [{ index: 0 }], usage: null })).toEqual({
      delta: undefined,
      finishReason: undefined,
      usage: undefined,
    });
  });

  it("normalizes complete and partial tool-call deltas", () => {
    expect(
      parseOpenRouterChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: "write_file", arguments: '{"path":"a.txt"}' },
                },
                { index: 1, id: "call-2" },
              ],
            },
          },
        ],
      }).delta?.toolCalls,
    ).toEqual([
      { index: 0, id: "call-1", name: "write_file", arguments: '{"path":"a.txt"}' },
      { index: 1, id: "call-2", name: undefined, arguments: undefined },
    ]);
  });

  it("maps malformed serialized chunks to a stable boundary error", () => {
    expect(() => parseOpenRouterData("not-json")).toThrow(
      expect.objectContaining({
        code: "invalid-response",
        message: "The inference provider returned an invalid stream chunk.",
        retryable: false,
      }),
    );
  });
});
