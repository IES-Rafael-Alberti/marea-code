import { afterEach, expect, it, vi } from "vitest";
import { browserRandomUUID } from "./browser-random-uuid.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the native UUID in secure contexts", () => {
  const randomUUID = vi.fn(() => "native-uuid");
  vi.stubGlobal("crypto", { randomUUID });
  expect(browserRandomUUID()).toBe("native-uuid");
  expect(randomUUID).toHaveBeenCalledExactlyOnceWith();
});

it("creates RFC 4122 version 4 identifiers with secure randomness on HTTP", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(16);
    return bytes.fill(0xff);
  });
  vi.stubGlobal("crypto", { getRandomValues });
  expect(browserRandomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  getRandomValues.mockImplementationOnce((bytes) => bytes.fill(0));
  expect(browserRandomUUID()).toBe("00000000-0000-4000-8000-000000000000");
  getRandomValues.mockImplementationOnce((bytes) => {
    bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    return bytes;
  });
  expect(browserRandomUUID()).toBe("01020304-0506-4708-890a-0b0c0d0e0f10");
  expect(getRandomValues).toHaveBeenCalledTimes(3);
});
