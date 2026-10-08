import type { AuthorizedCatalog, ProfileSelection } from "./profile-catalog.js";
import { moduleLabel, type profileMessages } from "./profile-messages.js";
export function CompositionEditor({
  modules,
  catalog,
  disabled,
  messages: m,
  change,
  canChange,
}: {
  readonly modules: ProfileSelection[];
  readonly catalog: AuthorizedCatalog;
  readonly disabled: boolean;
  readonly messages: ReturnType<typeof profileMessages>;
  readonly change: (modules: ProfileSelection[]) => void;
  readonly canChange: () => boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <ol>
        {modules.map((module, index) => {
          const descriptor = catalog.modules.find((item) => item.id === module.moduleId);
          const replace = (next: ProfileSelection) => {
            change(modules.map((item, at) => (at === index ? next : item)));
          };
          const move = (direction: number) => {
            change(modules.toSpliced(index, 1).toSpliced(index + direction, 0, module));
          };
          return (
            <li key={module.moduleId}>
              <fieldset disabled={descriptor === undefined}>
                <legend>{moduleLabel(m, module.moduleId)}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={module.enabled}
                    onChange={(event) => {
                      if (canChange()) replace({ ...module, enabled: event.currentTarget.checked });
                    }}
                  />
                  {m.visible}
                </label>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    move(-1);
                  }}
                >
                  {m.up}
                </button>
                <button
                  type="button"
                  disabled={index === modules.length - 1}
                  onClick={() => {
                    move(1);
                  }}
                >
                  {m.down}
                </button>
                <details className="view-layout-options">
                  <summary>
                    {m.slot} · {m.size}
                  </summary>
                  <label>
                    {m.slot}
                    <select
                      value={module.placement.slot}
                      onChange={(event) => {
                        const placement = descriptor?.supportedPlacements.find(
                          (item) => item.slot === event.currentTarget.value,
                        );
                        if (placement !== undefined) replace({ ...module, placement });
                      }}
                    >
                      {[...new Set(descriptor?.supportedPlacements.map((item) => item.slot))].map(
                        (slot) => (
                          <option key={slot} value={slot}>
                            {m[slot]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    {m.size}
                    <select
                      value={module.placement.size}
                      onChange={(event) => {
                        const placement = descriptor?.supportedPlacements.find(
                          (item) =>
                            item.slot === module.placement.slot &&
                            item.size === event.currentTarget.value,
                        );
                        if (placement !== undefined) replace({ ...module, placement });
                      }}
                    >
                      {descriptor?.supportedPlacements
                        .filter((item) => item.slot === module.placement.slot)
                        .map((item) => (
                          <option key={item.size} value={item.size}>
                            {m[item.size]}
                          </option>
                        ))}
                    </select>
                  </label>
                </details>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {catalog.releaseDefaults.modules
        .filter((item) => !modules.some((module) => module.moduleId === item.moduleId))
        .map((item) => (
          <button
            key={item.moduleId}
            type="button"
            onClick={() => {
              change([...modules, { ...item, enabled: true }]);
            }}
          >
            {m.visible}: {moduleLabel(m, item.moduleId)}
          </button>
        ))}
    </fieldset>
  );
}
