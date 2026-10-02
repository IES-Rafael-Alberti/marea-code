import type { DashboardLocale } from "../../messages.js";
import type { EditableSettings } from "./client.boundary.js";
import { serverSettingsMessages } from "./messages.js";
import { BudgetFields, emptyBudget } from "./budget-fields.js";

type Messages = ReturnType<typeof serverSettingsMessages>;
type Route = NonNullable<EditableSettings["route"]>;
type Budget = NonNullable<Route["budget"]>;
type Task = NonNullable<EditableSettings["education"]["map"]>;
type Provider = EditableSettings["providers"][number];

/** A connection without captured limits starts at zero; the administrator must complete it. */
const newBudget = (): Budget => ({
  inputTokenCeiling: 1,
  tutoring: emptyBudget(),
  evaluation: emptyBudget(),
});

export function ModelSettings({
  state,
  connections,
  locale,
  edit,
  classNames = {},
}: {
  state: EditableSettings;
  connections: Record<string, Record<string, string>>;
  locale: DashboardLocale;
  edit: (next: EditableSettings) => void;
  classNames?: Readonly<Record<string, string>> | undefined;
}) {
  const m = serverSettingsMessages(locale);
  const available = state.providers.filter((provider) => connections[provider.id] !== undefined);
  const route = state.route;
  return (
    <>
      <h3>{m.routeStep}</h3>
      <p className="server-help">{m.routeHelp}</p>
      <ProviderSelect
        m={m}
        locale={locale}
        providers={available}
        value={route?.providerId ?? ""}
        placeholder
        change={(providerId) => {
          edit({
            ...state,
            route: {
              ...route,
              providerId,
              model: route?.model ?? "",
              budget: route?.budget ?? newBudget(),
            },
          });
        }}
      />
      {route && (
        <RouteDetails
          state={state}
          route={route}
          m={m}
          locale={locale}
          providers={available}
          classNames={classNames}
          edit={edit}
        />
      )}
    </>
  );
}

function RouteDetails({
  state,
  route,
  m,
  locale,
  providers,
  classNames,
  edit,
}: {
  state: EditableSettings;
  route: Route;
  m: Messages;
  locale: DashboardLocale;
  providers: readonly Provider[];
  classNames: Readonly<Record<string, string>>;
  edit: (next: EditableSettings) => void;
}) {
  const set = (next: Partial<Route>) => {
    edit({ ...state, route: { ...route, ...next } });
  };
  const budget = route.budget ?? newBudget();
  const evaluation = route.evaluation ?? { providerId: route.providerId, model: route.model };
  return (
    <>
      <label className="server-field">
        {m.model}
        <input
          required
          value={route.model}
          onChange={(event) => {
            set({ model: event.currentTarget.value });
          }}
        />
      </label>
      <div className="server-common" data-active={state.useCommonRoute}>
        <label>
          <input
            type="checkbox"
            checked={state.useCommonRoute}
            onChange={(event) => {
              edit({ ...state, useCommonRoute: event.currentTarget.checked });
            }}
          />
          {m.common}
        </label>
        <p>{state.useCommonRoute ? m.commonOn : m.commonOff}</p>
        <p>{m.commonNote}</p>
        {state.legacyRoutes.length > 0 && (
          <details>
            <summary>
              {m.legacyTitle} ({state.legacyRoutes.length})
            </summary>
            <ul>
              {state.legacyRoutes.map((item) => (
                <li key={item.classId}>
                  <strong>{classNames[item.classId] ?? item.classId}</strong> ·{" "}
                  {providerName(state.providers, item.route.providerId, locale)} ·{" "}
                  <code>{item.route.model}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <h3>{m.limitsStep}</h3>
      <p className="server-help">{m.budgetNote}</p>
      {(["tutoring", "evaluation"] as const).map((purpose) => (
        <details className="workspace-advanced" key={purpose}>
          <summary>
            {m[purpose]} · {m.limits}
          </summary>
          <BudgetFields
            m={m}
            value={budget[purpose]}
            change={(next) => {
              const other = budget[purpose === "tutoring" ? "evaluation" : "tutoring"];
              set({
                budget: {
                  ...budget,
                  [purpose]: next,
                  inputTokenCeiling: Math.min(next.maxInputTokens, other.maxInputTokens),
                },
              });
            }}
          />
        </details>
      ))}
      <details className="workspace-advanced">
        <summary>{m.advanced}</summary>
        <fieldset>
          <legend>{m.evaluation}</legend>
          <label className="server-field">
            {m.model}
            <input
              value={evaluation.model}
              onChange={(event) => {
                set({ evaluation: { ...evaluation, model: event.currentTarget.value } });
              }}
            />
          </label>
          <ProviderSelect
            m={m}
            locale={locale}
            providers={providers}
            value={evaluation.providerId}
            change={(providerId) => {
              set({ evaluation: { ...evaluation, providerId } });
            }}
          />
        </fieldset>
        {(["map", "reports"] as const).map((purpose) => (
          <TaskRoute
            key={purpose}
            purpose={purpose}
            state={state}
            seed={{
              providerId: route.providerId,
              model: route.model,
              inputTokenCeiling: budget.inputTokenCeiling,
              budget: budget.evaluation,
            }}
            m={m}
            locale={locale}
            providers={providers}
            edit={edit}
          />
        ))}
      </details>
    </>
  );
}

/** Map and reports are optional tasks; enabling one starts from the main route. */
function TaskRoute({
  purpose,
  state,
  seed,
  m,
  locale,
  providers,
  edit,
}: {
  purpose: "map" | "reports";
  state: EditableSettings;
  seed: Task;
  m: Messages;
  locale: DashboardLocale;
  providers: readonly Provider[];
  edit: (next: EditableSettings) => void;
}) {
  const task = state.education[purpose];
  const setTask = (next: Task | undefined) => {
    const education = { ...state.education };
    if (next === undefined) Reflect.deleteProperty(education, purpose);
    else education[purpose] = next;
    edit({ ...state, education });
  };
  return (
    <fieldset>
      <legend>{m[purpose]}</legend>
      <label>
        <input
          type="checkbox"
          checked={task !== undefined}
          onChange={(event) => {
            setTask(event.currentTarget.checked ? seed : undefined);
          }}
        />
        {m.enable}
      </label>
      {task && (
        <>
          <label className="server-field">
            {m.model}
            <input
              required
              value={task.model}
              onChange={(event) => {
                setTask({ ...task, model: event.currentTarget.value });
              }}
            />
          </label>
          <ProviderSelect
            m={m}
            locale={locale}
            providers={providers}
            value={task.providerId}
            change={(providerId) => {
              setTask({ ...task, providerId });
            }}
          />
          <BudgetFields
            m={m}
            value={task.budget}
            change={(budget) => {
              setTask({ ...task, budget, inputTokenCeiling: budget.maxInputTokens });
            }}
          />
        </>
      )}
    </fieldset>
  );
}

function ProviderSelect({
  m,
  locale,
  providers,
  value,
  placeholder = false,
  change,
}: {
  m: Messages;
  locale: DashboardLocale;
  providers: readonly Provider[];
  value: string;
  placeholder?: boolean;
  change: (providerId: string) => void;
}) {
  return (
    <label className="server-field">
      {m.provider}
      <select
        value={value}
        onChange={(event) => {
          change(event.currentTarget.value);
        }}
      >
        {placeholder && (
          <option value="" disabled>
            {m.provider}
          </option>
        )}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {providerName(providers, provider.id, locale)}
          </option>
        ))}
      </select>
    </label>
  );
}

function providerName(providers: readonly Provider[], id: string, locale: DashboardLocale) {
  return providers.find((item) => item.id === id)?.descriptor?.name[locale] ?? id;
}
