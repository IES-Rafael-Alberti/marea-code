import { expect, it, vi } from "vitest";
import type { LocalePreference } from "@marea/i18n";
import { AccountLanguage } from "./account-language.js";
it("loads on login, persists edits and reports failures without leaking responses across logins", async () => {
  const request = vi
    .fn<
      (preference: LocalePreference | null, signal: AbortSignal) => Promise<LocalePreference | null>
    >()
    .mockResolvedValue("es");
  const changed = vi.fn();
  const language = new AccountLanguage(request, changed);
  await language.save("en");
  expect(request).not.toHaveBeenCalled();
  await language.connect();
  expect(request).toHaveBeenCalledWith(null, expect.any(AbortSignal));
  expect(changed.mock.calls).toEqual([
    [null, false, true],
    ["es", false, false],
  ]);
  request.mockResolvedValueOnce("eu");
  await language.save("eu");
  expect(request.mock.calls.at(-1)?.[0]).toBe("eu");
  expect(changed).toHaveBeenLastCalledWith("eu", false, false);
  request.mockRejectedValueOnce(new Error("offline"));
  await language.save("en");
  expect(changed).toHaveBeenLastCalledWith(null, true, false);
  const late = Promise.withResolvers<LocalePreference | null>();
  request.mockReturnValueOnce(late.promise);
  const connecting = language.connect();
  expect(request.mock.calls[0]?.[1].aborted).toBe(true);
  const signal = request.mock.calls.at(-1)?.[1];
  await language.save("eu");
  changed.mockClear();
  late.resolve("en");
  await connecting;
  expect(changed).not.toHaveBeenCalled();
  const abandoned = Promise.withResolvers<LocalePreference | null>();
  request.mockReturnValueOnce(abandoned.promise);
  const pending = language.save("es");
  language.disconnect();
  expect(signal?.aborted).toBe(true);
  changed.mockClear();
  abandoned.reject(new Error("signed-out"));
  await pending;
  expect(changed).not.toHaveBeenCalled();
  const stale = Promise.withResolvers<LocalePreference | null>();
  request.mockReturnValueOnce(stale.promise);
  const old = language.connect();
  await language.connect();
  changed.mockClear();
  stale.resolve("eu");
  await old;
  expect(changed).not.toHaveBeenCalled();
});
