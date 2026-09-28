import type { UsageEntry } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import type { UsageController, UsageState } from "./usage-controller.js";
import { usageMessages } from "./usage-messages.js";
import { usageWindow } from "./usage-range.js";
import "../usage-health.css";

type Messages = ReturnType<typeof usageMessages>;
export type UsageActions = Pick<
  UsageController,
  "edit" | "apply" | "next" | "previous" | "refresh"
>;

function UsageRow({
  entry,
  m,
  locale,
}: {
  readonly entry: UsageEntry;
  readonly m: Messages;
  readonly locale: DashboardLocale;
}) {
  const number = new Intl.NumberFormat(locale);
  return (
    <tr>
      <td>
        <time dateTime={entry.createdAt}>
          {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(entry.createdAt),
          )}
        </time>
      </td>
      <td>{m[entry.purpose]}</td>
      <td>{m[entry.state]}</td>
      <td>{number.format(entry.inputTokens)}</td>
      <td>{number.format(entry.outputTokens)}</td>
      <td>{m[entry.tokenBasis]}</td>
      <td>
        {entry.cost.status === "priced"
          ? `${number.format(entry.cost.units)} ${entry.cost.unit}`
          : m.costUnavailable}
      </td>
    </tr>
  );
}

/** Page-scoped figures only: no class total is derived from partial or unavailable pricing. */
export function UsageView({
  locale,
  state,
  actions,
}: {
  readonly locale: DashboardLocale;
  readonly state: UsageState;
  readonly actions: UsageActions;
}) {
  const m = usageMessages(locale);
  const invalid = usageWindow(state.draft) === undefined;
  const loading = state.status === "loading";
  return (
    <section className="class-projection" aria-label={m.title}>
      <h2>{m.title}</h2>
      <p>{m.scope}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void actions.apply();
        }}
      >
        {(["from", "to"] as const).map((field) => (
          <label key={field}>
            {m[field]}
            <input
              type="date"
              required
              value={state.draft[field]}
              aria-invalid={invalid}
              onChange={(event) => {
                actions.edit(field, event.currentTarget.value);
              }}
            />
          </label>
        ))}
        <button type="submit" disabled={invalid || loading || state.status === "empty"}>
          {m.apply}
        </button>
      </form>
      {invalid && <p role="alert">{m.invalidRange}</p>}
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>{state.status === "ready" ? m[state.response.pricing] : m[state.status]}</p>
      </div>
      {state.status === "ready" &&
        (state.response.entries.length === 0 ? (
          <p>{m.none}</p>
        ) : (
          <div className="class-projection-table" tabIndex={0} role="group" aria-label={m.title}>
            <table>
              <thead>
                <tr>
                  {(
                    [
                      "created",
                      "purpose",
                      "state",
                      "inputTokens",
                      "outputTokens",
                      "basis",
                      "cost",
                    ] as const
                  ).map((column) => (
                    <th key={column} scope="col">
                      {m[column]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.response.entries.map((entry) => (
                  <UsageRow key={entry.attemptId} entry={entry} m={m} locale={locale} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <nav aria-label={m.page}>
        <button
          type="button"
          disabled={state.page === 1 || loading}
          onClick={() => void actions.previous()}
        >
          {m.previous}
        </button>
        <span>
          {m.page} {state.page}
        </span>
        <button
          type="button"
          disabled={state.status !== "ready" || state.response.nextAfterAttemptId === null}
          onClick={() => void actions.next()}
        >
          {m.next}
        </button>
        <button
          type="button"
          disabled={loading || state.status === "empty"}
          onClick={() => void actions.refresh()}
        >
          {m.refresh}
        </button>
      </nav>
    </section>
  );
}
