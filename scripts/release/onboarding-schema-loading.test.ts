import { expect, it, vi } from "vitest";
import { setupInput } from "./onboarding.fixture.js";

it("loads setup operations freshly and rejects requests without an operation", async () => {
  vi.resetModules();
  const { onboardingHttp } = await import("./onboarding-http.boundary.js");
  const origin = "http://127.0.0.1:12345";
  const read = vi.fn(() => Promise.resolve({ ready: true }));
  const models = vi.fn(() => Promise.resolve({ models: [] }));
  const finish = vi.fn(() => Promise.resolve({ dashboardUrl: `${origin}/dashboard/` }));
  const handle = onboardingHttp({
    origin: () => origin,
    token: "synthetic-setup-token",
    assets: () => Promise.resolve(new Response()),
    read,
    models,
    finish,
  });
  const send = (body: object) =>
    handle(
      new Request(`${origin}/setup/api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-setup-token",
          origin,
          host: "127.0.0.1:12345",
        },
        body: JSON.stringify(body),
      }),
    );
  for (const body of [{}, { operation: "unknown" }, { providerId: "p", values: {} }])
    expect((await send(body)).status).toBe(400);
  for (const callback of [read, models, finish]) expect(callback).not.toHaveBeenCalled();
  expect(await (await send({ operation: "read" })).json()).toEqual({ ready: true });
  expect(await (await send({ operation: "models", providerId: "p", values: {} })).json()).toEqual({
    models: [],
  });
  expect((await send({ operation: "finish", setup: setupInput() })).status).toBe(200);
  for (const callback of [read, models, finish]) expect(callback).toHaveBeenCalledOnce();
});
