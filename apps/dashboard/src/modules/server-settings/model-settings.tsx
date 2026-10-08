import type { DashboardLocale } from "../../messages.js";
import type { EditableSettings } from "./client.boundary.js";
import { serverSettingsMessages } from "./messages.js";
import { BudgetFields, emptyBudget } from "./budget-fields.js";

import { ModelInput, pricedBudget } from "./model-input.js";
import type { ModelCatalogs } from "./provider-models.boundary.js";

type Messages = ReturnType<typeof serverSettingsMessages>;
type Route = NonNullable<EditableSettings["route"]>;
type Budget = NonNullable<Route["budget"]>;
type Task = NonNullable<EditableSettings["education"]["map"]>;
type Provider = EditableSettings["providers"][number];

/** New connections work without an administrator setting usage ceilings. */
const newBudget = (): Budget => ({
  inputTokenCeiling: 131072,
  tutoring: emptyBudget(),
  evaluation: emptyBudget(),
});

export const initialModelRoute = (providerId: string): Route => ({
  providerId,
  model: "",
  budget: newBudget(),
});

export function ModelSettings({
  state,
  connections,
  locale,
  edit,
  classNames = {},
  catalogs = {},
  onboarding = false,
  section = "all",
}: {
  section?: "all" | "models" | "limits" | "features";
  onboarding?: boolean;
  catalogs?: ModelCatalogs;
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
      {(section === "all" || section === "models") && !onboarding && (
        <>
          <h3>{m.routeStep}</h3>
          <p className="server-help">{m.routeHelp}</p>
        </>
      )}
      {(section === "all" || section === "models") && !onboarding && (
        <ProviderSelect
          m={m}
          locale={locale}
          providers={available}
          value={route?.providerId ?? ""}
          placeholder
          change={(providerId) => {
            edit({
              ...state,
              useCommonRoute: state.legacyRoutes.length === 0 || state.useCommonRoute,
              route: {
                ...route,
                providerId,
                model: route?.model ?? "",
                budget: route?.budget ?? newBudget(),
              },
            });
          }}
        />
      )}
      {route && (
        <RouteDetails
          state={state}
          onboarding={onboarding}
          section={section}
          route={route}
          catalogs={catalogs}
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
  onboarding,
  section,
  state,
  route,
  m,
  locale,
  providers,
  classNames,
  catalogs,
  edit,
}: {
  onboarding: boolean;
  section: "all" | "models" | "limits" | "features";
  state: EditableSettings;
  route: Route;
  catalogs: ModelCatalogs;
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
      <div data-settings-section="models" hidden={section !== "all" && section !== "models"}>
        <ModelInput
          id="models-tutoring"
          label={m.model}
          value={route.model}
          providerId={route.providerId}
          catalogs={catalogs}
          change={(model, pricing) => {
            set({
              model,
              budget: {
                ...budget,
                tutoring: pricedBudget(budget.tutoring, pricing),
                evaluation: route.evaluation
                  ? budget.evaluation
                  : pricedBudget(budget.evaluation, pricing),
              },
            });
          }}
        />
        {!onboarding && (
          <div className="server-common" data-active={state.useCommonRoute}>
            {state.legacyRoutes.length > 0 && (
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
            )}
            <p>
              {state.useCommonRoute || state.legacyRoutes.length === 0 ? m.commonOn : m.commonOff}
            </p>
            {state.legacyRoutes.length > 0 && <p>{m.commonNote}</p>}
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
        )}
      </div>
      {!onboarding && (
        <>
          <div data-settings-section="limits" hidden={section !== "all" && section !== "limits"}>
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
                  pricing={
                    catalogs[
                      purpose === "evaluation" ? evaluation.providerId : route.providerId
                    ]?.models.find(
                      (item) =>
                        item.id === (purpose === "evaluation" ? evaluation.model : route.model),
                    )?.pricing
                  }
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
          </div>
          <details
            data-settings-section="features"
            className="workspace-advanced"
            hidden={section !== "all" && section !== "features"}
            open={section === "features"}
          >
            <summary>{m.advanced}</summary>
            <fieldset>
              <legend>{m.evaluation}</legend>
              <ModelInput
                id="models-evaluation"
                label={m.model}
                value={evaluation.model}
                providerId={evaluation.providerId}
                catalogs={catalogs}
                change={(model, pricing) => {
                  set({
                    evaluation: { ...evaluation, model },
                    budget: { ...budget, evaluation: pricedBudget(budget.evaluation, pricing) },
                  });
                }}
              />
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
                catalogs={catalogs}
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
      )}
    </>
  );
}

/** Map and reports are optional tasks; enabling one starts from the main route. */
function TaskRoute({
  purpose,
  state,
  seed,
  catalogs,
  m,
  locale,
  providers,
  edit,
}: {
  purpose: "map" | "reports";
  state: EditableSettings;
  seed: Task;
  catalogs: ModelCatalogs;
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
          <ModelInput
            id={`models-${purpose}`}
            label={m.model}
            value={task.model}
            providerId={task.providerId}
            catalogs={catalogs}
            change={(model, pricing) => {
              setTask({ ...task, model, budget: pricedBudget(task.budget, pricing) });
            }}
          />
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
            pricing={
              catalogs[task.providerId]?.models.find((item) => item.id === task.model)?.pricing
            }
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
  const [first, second] = providers;
  if (first?.id === value && second === undefined)
    return <p className="server-provider-name">{providerName(providers, value, locale)}</p>;
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
          <option key={provider.id} value={provider.id} disabled={provider.descriptor === null}>
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
