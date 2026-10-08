import { useState, type ReactNode } from "react";
import type { DashboardLocale } from "../messages.js";

const sections = ["tutor", "access", "features", "library"] as const;
const labels = {
  es: [
    "Tutor y skills activas",
    "Acceso del alumnado",
    "Funciones educativas",
    "Crear y editar skills",
  ],
  en: [
    "Tutor and active skills",
    "Student access",
    "Educational features",
    "Create and edit skills",
  ],
  eu: [
    "Tutorea eta skill aktiboak",
    "Ikasleen sarbidea",
    "Hezkuntza-funtzioak",
    "Sortu eta editatu skillak",
  ],
};
/** Panels stay mounted, preserving drafts while teachers move between class settings. */
export function ClassSettings({
  locale,
  content,
}: {
  locale: DashboardLocale;
  content: Record<(typeof sections)[number], ReactNode>;
}) {
  const [selected, select] = useState<(typeof sections)[number]>("tutor");
  return (
    <div className="class-settings">
      <nav className="settings-subnavigation">
        {sections.map((id, index) => (
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
        ))}
      </nav>
      {sections.map((id) => (
        <div hidden={selected !== id} key={id}>
          {content[id]}
        </div>
      ))}
    </div>
  );
}
