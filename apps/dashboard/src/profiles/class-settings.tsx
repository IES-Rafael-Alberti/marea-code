import { useState, type ReactNode } from "react";
import type { DashboardLocale } from "../messages.js";

const sections = ["tutor", "access", "features", "library"] as const;
const labels = {
  es: ["Tutor", "Acceso del alumnado", "Funciones educativas", "Crear y editar skills"],
  en: ["Tutor", "Student access", "Educational features", "Create and edit skills"],
  eu: ["Tutorea", "Ikasleen sarbidea", "Hezkuntza-funtzioak", "Sortu eta editatu skillak"],
};
/** Panels stay mounted, preserving drafts while teachers move between class settings. */
export function ClassSettings({
  locale,
  content,
}: {
  locale: DashboardLocale;
  content: Partial<Record<(typeof sections)[number], ReactNode>>;
}) {
  const [selected, select] = useState<(typeof sections)[number]>("tutor");
  return (
    <div className="class-settings">
      <nav className="settings-subnavigation">
        {sections.map((id, index) =>
          content[id] === undefined ? null : (
            <button
              type="button"
              key={id}
              aria-current={selected === id ? "page" : undefined}
              onClick={() => {
                select(id);
              }}
            >
              {labels[locale][index]}
            </button>
          ),
        )}
      </nav>
      {sections.map((id) =>
        content[id] === undefined ? null : (
          <div hidden={selected !== id} key={id}>
            {content[id]}
          </div>
        ),
      )}
    </div>
  );
}
