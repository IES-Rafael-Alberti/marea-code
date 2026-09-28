import type { DashboardLocale } from "../messages.js";
import type { ProfileController } from "./profile-controller.js";
import type { AuthorizedCatalog, ProfileValue } from "./profile-catalog.js";
import { profileMessages } from "./profile-messages.js";
import { CompositionEditor } from "./composition-editor.js";
interface EditorProperties {
  readonly controller: ProfileController;
  readonly locale: DashboardLocale;
  readonly canChange: () => boolean;
}
export function ProfileEditor({ controller: c, locale, canChange }: EditorProperties) {
  const m = profileMessages(locale);
  return (
    <details className="profile-editor">
      <summary>{m.title}</summary>
      {c.dirty && <p role="status">{m.draft}</p>}
      {c.problem !== null && <p role="alert">{m[c.problem]}</p>}
      {c.current !== null && c.current.warnings.length > 0 && <p role="status">{m.warning}</p>}
      {c.draft !== null && c.catalog !== null && (
        <ProfileFields
          controller={c}
          locale={locale}
          canChange={canChange}
          draft={c.draft}
          catalog={c.catalog}
        />
      )}
      <button
        type="button"
        disabled={c.busy}
        onClick={() => {
          void c.read();
        }}
      >
        {m.read}
      </button>
      {c.recovery !== null && (
        <div>
          {c.matched && <p>{m.matched}</p>}
          <button
            onClick={() => {
              if (canChange()) c.reconcile(false);
            }}
          >
            {m.accept}
          </button>
          <button
            onClick={() => {
              c.reconcile(true);
            }}
          >
            {m.reapply}
          </button>
        </div>
      )}
    </details>
  );
}
function ProfileFields({
  controller: c,
  locale,
  canChange,
  draft,
  catalog,
}: EditorProperties & {
  readonly draft: ProfileValue;
  readonly catalog: AuthorizedCatalog;
}) {
  const m = profileMessages(locale);
  const inherited = c.current?.personal.value ?? catalog.releaseDefaults;
  return (
    <fieldset disabled={c.busy}>
      {c.scope.kind === "class" && (
        <>
          <label>
            <input
              type="checkbox"
              checked={draft.themeId === undefined}
              onChange={(event) => {
                const next = { ...draft };
                delete next.themeId;
                c.edit(
                  event.currentTarget.checked ? next : { ...draft, themeId: inherited.themeId },
                );
              }}
            />
            {m.inheritTheme}
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.modules === undefined}
              onChange={(event) => {
                if (!canChange()) return;
                const next = { ...draft };
                delete next.modules;
                c.edit(
                  event.currentTarget.checked ? next : { ...draft, modules: inherited.modules },
                );
              }}
            />
            {m.inheritModules}
          </label>
        </>
      )}
      <label>
        {m.theme}
        <select
          value={draft.themeId ?? inherited.themeId}
          disabled={c.scope.kind === "class" && draft.themeId === undefined}
          onChange={(event) => {
            c.edit({ ...draft, themeId: event.currentTarget.value });
          }}
        >
          {catalog.themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.highContrast ? m.contrast : m.marea}
            </option>
          ))}
        </select>
      </label>
      <CompositionEditor
        modules={draft.modules ?? inherited.modules}
        catalog={catalog}
        messages={m}
        disabled={c.scope.kind === "class" && draft.modules === undefined}
        change={(modules) => {
          c.edit({ ...draft, modules });
        }}
        canChange={canChange}
      />
      <label>
        <input
          type="checkbox"
          checked={c.discardUnavailable}
          onChange={(event) => {
            c.discardUnavailable = event.currentTarget.checked;
            c.edit({ ...draft });
          }}
        />
        {m.discard}
      </label>
      <button
        type="button"
        disabled={c.problem !== null}
        onClick={() => {
          void c.write();
        }}
      >
        {m.save}
      </button>
      <button
        type="button"
        disabled={c.problem !== null && c.problem !== "recovery"}
        onClick={() => {
          if (canChange() && window.confirm(m.confirmReset)) void c.write(true);
        }}
      >
        {m.reset}
      </button>
    </fieldset>
  );
}
