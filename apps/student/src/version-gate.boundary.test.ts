import { createTranslator } from "@marea/i18n";
import { describe, expect, it, vi } from "vitest";

import type { StudentVersionAcceptanceStore, VersionPair } from "./version-acceptance.boundary.js";
import { createVersionGate, StudentVersionError } from "./version-gate.boundary.js";

const translator = createTranslator("es");

const PAIR = {
  serverUrl: "https://teacher.example",
  serverVersion: "0.2.0-preview.48",
  clientVersion: "0.2.0-preview.47",
} as const;

function memoryStore(accepted = false) {
  const has = vi.fn<(pair: VersionPair) => Promise<boolean>>(() => Promise.resolve(accepted));
  const remember = vi.fn<(pair: VersionPair) => Promise<void>>(() => Promise.resolve());
  const store: StudentVersionAcceptanceStore = {
    has: (pair) => has(pair),
    remember: (pair) => remember(pair),
  };
  return { has, remember, store };
}

function gateFor(
  interactive: boolean,
  confirm: (
    message: string,
    choices: readonly { name: string; value: boolean }[],
  ) => Promise<boolean>,
  store?: StudentVersionAcceptanceStore,
) {
  return createVersionGate({
    serverUrl: PAIR.serverUrl,
    translator,
    store,
    interactive: () => interactive,
    confirm,
  });
}

const mismatch = translator.t("student.version.mismatch", {
  client: PAIR.clientVersion,
  server: PAIR.serverVersion,
});
const recommendation = translator.t("student.version.recommendation");

describe("version gate", () => {
  it("shows both versions and the recommendation and defaults to leaving", async () => {
    const { remember, store } = memoryStore();
    const confirm = vi.fn(() => Promise.resolve(false));
    const gate = gateFor(true, confirm, store);
    const declined = gate(PAIR.serverVersion, PAIR.clientVersion);
    await expect(declined).rejects.toBeInstanceOf(StudentVersionError);
    await expect(declined).rejects.toThrow(
      [mismatch, recommendation, translator.t("student.version.declined")].join("\n"),
    );
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      [mismatch, recommendation, translator.t("student.version.question")].join("\n"),
      [
        { name: translator.t("student.version.exit"), value: false },
        { name: translator.t("student.version.continue"), value: true },
      ],
    );
    expect(remember).not.toHaveBeenCalled();
  });

  it("remembers an accepted pair for this server", async () => {
    const { remember, store } = memoryStore();
    const gate = gateFor(true, () => Promise.resolve(true), store);
    await expect(gate(PAIR.serverVersion, PAIR.clientVersion)).resolves.toBeUndefined();
    expect(remember).toHaveBeenCalledExactlyOnceWith(PAIR);
  });

  it("does not ask again for a pair that was accepted before", async () => {
    const { has, store } = memoryStore(true);
    const confirm = vi.fn(() => Promise.resolve(false));
    const gate = gateFor(false, confirm, store);
    await expect(gate(PAIR.serverVersion, PAIR.clientVersion)).resolves.toBeUndefined();
    expect(has).toHaveBeenCalledExactlyOnceWith(PAIR);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses without a terminal and never waits for an answer", async () => {
    const { remember, store } = memoryStore();
    const confirm = vi.fn(() => Promise.resolve(true));
    const gate = gateFor(false, confirm, store);
    const refused = gate(PAIR.serverVersion, PAIR.clientVersion);
    await expect(refused).rejects.toBeInstanceOf(StudentVersionError);
    await expect(refused).rejects.toThrow(
      [mismatch, recommendation, translator.t("student.version.terminal-required")].join("\n"),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it("still continues when the acceptance cannot be saved", async () => {
    const store: StudentVersionAcceptanceStore = {
      has: () => Promise.resolve(false),
      remember: () => Promise.reject(new Error("Read-only state.")),
    };
    const gate = gateFor(true, () => Promise.resolve(true), store);
    await expect(gate(PAIR.serverVersion, PAIR.clientVersion)).resolves.toBeUndefined();
  });

  it("works without a store, asking every time", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const gate = gateFor(true, confirm);
    await gate(PAIR.serverVersion, PAIR.clientVersion);
    await gate(PAIR.serverVersion, PAIR.clientVersion);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("defaults to the real terminal: a test run has none, so it refuses", async () => {
    const gate = createVersionGate({ serverUrl: PAIR.serverUrl, translator });
    await expect(gate(PAIR.serverVersion, PAIR.clientVersion)).rejects.toThrow(
      translator.t("student.version.terminal-required"),
    );
  });
});
