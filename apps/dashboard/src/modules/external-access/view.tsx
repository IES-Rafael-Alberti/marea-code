import { ProviderHelp } from "../../forms/provider-help.js";
import { IdentityStatusResponse, identityRequest } from "../server-settings/identity-client.js";
import type { z } from "zod";
import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  MAX_EXTERNAL_RULE_VALUES_PER_CHANGE,
  RequestIdSchema,
  type ExternalAccessResponse,
  type RequestId,
} from "@marea/protocol";
import { useEffect, useState } from "react";

import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { externalAccess } from "./client.boundary.js";
import { externalAccessMessages } from "./messages.js";
import "./external-access.css";

function requestId(): RequestId {
  return RequestIdSchema.parse(`external-access:${browserRandomUUID()}`);
}

/** Splits pasted text on whitespace, commas and semicolons. */
export function entriesOf(text: string): readonly string[] {
  return text.split(/[\s,;]/u).filter((entry) => entry.length > 0);
}

/**
 * Who may join the selected class through each installed identity provider. Without an
 * installed provider the server offers nothing and this section does not appear.
 */
export function ExternalAccessView({
  fetchRequest,
  locale,
  classId,
}: {
  readonly fetchRequest: DashboardFetch;
  readonly locale: DashboardLocale;
  readonly classId: string | null;
}) {
  const m = externalAccessMessages(locale);
  const [state, setState] = useState<ExternalAccessResponse | null>(null);
  /** The message of the last failure, shown until the next attempt. */
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const [readiness, setReadiness] = useState<z.infer<typeof IdentityStatusResponse> | null>(null);
  useEffect(() => {
    if (classId === null) return;
    const controller = new AbortController();
    setState(null);
    setDrafts({});
    setSaved(false);
    void identityRequest(
      fetchRequest,
      { operation: "identity-status" },
      IdentityStatusResponse,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setReadiness(value);
      },
      () => {
        if (!controller.signal.aborted) setReadiness(null);
      },
    );
    setProblem(null);
    setBusy(true);
    void externalAccess(
      fetchRequest,
      { kind: "external-access-query", protocolVersion: "0.1", requestId: requestId(), classId },
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setState(result.value);
      // A server without identity providers has no such endpoint: nothing to show.
      else if (result.reason !== "missing") setProblem(m.error);
      setBusy(false);
    });
    return () => {
      controller.abort();
    };
  }, [fetchRequest, classId, attempt]);
  if (classId === null || (state === null && problem === null && !busy)) return null;
  if (state !== null && state.providers.length === 0) return null;
  const change = (
    providerId: string,
    ruleKind: string,
    operation: "add" | "remove",
    values: readonly string[],
  ) => {
    if (values.length > MAX_EXTERNAL_RULE_VALUES_PER_CHANGE) {
      setProblem(m.tooMany);
      return;
    }
    setBusy(true);
    setSaved(false);
    setProblem(null);
    void externalAccess(
      fetchRequest,
      {
        kind: "external-access-change",
        protocolVersion: "0.1",
        requestId: requestId(),
        classId,
        operation,
        providerId,
        ruleKind,
        values,
      },
      new AbortController().signal,
    ).then((result) => {
      if (result.ok) {
        setState(result.value);
        setSaved(true);
        if (operation === "add") setDrafts({ ...drafts, [`${providerId}/${ruleKind}`]: "" });
      } else setProblem(result.reason === "conflict" ? m.conflict : m.error);
      setBusy(false);
    });
  };
  return (
    <section
      className="dashboard-module external-access"
      aria-busy={busy}
      data-dirty={Object.values(drafts).some((value) => value.trim().length > 0)}
    >
      <h2>{m.title}</h2>
      <p>{m.intro}</p>
      {state === null ? (
        problem === null ? (
          <p>{m.loading}</p>
        ) : (
          <p role="alert">
            {m.error}{" "}
            <button
              type="button"
              onClick={() => {
                setAttempt(attempt + 1);
              }}
            >
              {m.retry}
            </button>
          </p>
        )
      ) : (
        <>
          {state.providers.map((provider) => (
            <fieldset key={provider.providerId} disabled={busy}>
              <legend>{provider.displayName[locale]}</legend>
              {provider.ruleKinds.map((ruleKind) => {
                const key = `${provider.providerId}/${ruleKind.kind}`;
                const status = readiness?.providers.find(
                  (entry) => entry.id === provider.providerId,
                );
                const ready =
                  status?.kinds.find((entry) => entry.kind === ruleKind.kind)?.ready !== false;
                const rules = state.rules.filter(
                  (rule) => rule.providerId === provider.providerId && rule.kind === ruleKind.kind,
                );
                return (
                  <div className="external-access-kind" key={key}>
                    <h3>{ruleKind.label[locale]}</h3>
                    {rules.length === 0 ? (
                      <p>{m.empty}</p>
                    ) : (
                      <ul>
                        {rules.map((rule) => (
                          <li key={rule.value}>
                            <span>{rule.value}</span>
                            <button
                              type="button"
                              aria-label={`${m.remove} ${rule.value}`}
                              onClick={() => {
                                change(provider.providerId, ruleKind.kind, "remove", [rule.value]);
                              }}
                            >
                              {m.remove}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!ready && (
                      <div className="access-prerequisite">
                        <p>{m.needsSetup}</p>
                        <a href="?view=settings&settings=server&server=identities">{m.configure}</a>
                        <ProviderHelp guides={status.guides} locale={locale} />
                      </div>
                    )}
                    {ready && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const values = entriesOf(drafts[key] ?? "");
                          if (values.length > 0)
                            change(provider.providerId, ruleKind.kind, "add", values);
                        }}
                      >
                        <label>
                          {`${ruleKind.label[locale]} · ${m.values}`}
                          <textarea
                            rows={3}
                            value={drafts[key] ?? ""}
                            onChange={(event) => {
                              setDrafts({ ...drafts, [key]: event.target.value });
                              setSaved(false);
                            }}
                          />
                        </label>
                        <button type="submit">{m.add}</button>
                      </form>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
          {problem !== null ? (
            <p role="alert">{problem}</p>
          ) : (
            saved && (
              <p role="status">
                {state.rejected.length === 0
                  ? m.saved
                  : `${m.rejected} ${state.rejected.join(", ")}`}
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
