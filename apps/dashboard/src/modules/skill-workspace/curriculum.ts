import type { SkillCurriculumSummary, SkillLibraryEntry } from "@marea/protocol";
type Module = SkillCurriculumSummary["modulos"][number];
const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/gu, " ");
const catalogModules = (catalog: readonly SkillLibraryEntry[]) =>
  catalog
    .flatMap((entry) => entry.curriculum?.modulos)
    .filter((entry): entry is Module => entry !== undefined);

export function moduleLabel(module: Module): string {
  return [module.nombre, module.codigo].filter((value) => value !== undefined).join(" · ");
}
/** A name alone maps to a code only when the visible catalog establishes one unambiguous link. */
export function moduleKey(module: Module, catalog: readonly SkillLibraryEntry[]): string {
  if (module.codigo !== undefined) return `code:${normalize(module.codigo)}`;
  const name = normalize(moduleLabel(module));
  const codes = new Set(
    catalogModules(catalog).flatMap((entry) =>
      entry.codigo !== undefined && entry.nombre !== undefined && normalize(entry.nombre) === name
        ? [`code:${normalize(entry.codigo)}`]
        : [],
    ),
  );
  return codes.size === 1 ? [...codes].toString() : `name:${name}`;
}
export function curriculumModules(catalog: readonly SkillLibraryEntry[]) {
  const modules = new Map<string, string>();
  for (const module of catalogModules(catalog)) {
    const key = moduleKey(module, catalog),
      label = moduleLabel(module);
    const previous = modules.get(key);
    if (previous === undefined || label.length > previous.length) modules.set(key, label);
  }
  return [...modules].sort((a, b) => a[1].localeCompare(b[1]));
}
export function curriculumLabels(entry: SkillLibraryEntry): string[] {
  const curriculum = entry.curriculum;
  if (curriculum === undefined) return [];
  return [
    ...new Set([
      ...curriculum.modulos.map(moduleLabel),
      ...curriculum.referencias.map(
        (ref) => `${moduleLabel(ref.modulo)} · RA${String(ref.ra)}.${ref.criterio}`,
      ),
    ]),
  ];
}
export function matchesCurriculum(
  entry: SkillLibraryEntry,
  module: string,
  catalog: readonly SkillLibraryEntry[],
): boolean {
  const modules = entry.curriculum?.modulos ?? [];
  if (module === "") return true;
  if (module === "unlinked") return modules.length === 0;
  return modules.some((item) => moduleKey(item, catalog) === module);
}
export function matchesSkill(entry: SkillLibraryEntry, query: string): boolean {
  return normalize([entry.title, entry.description, ...curriculumLabels(entry)].join(" ")).includes(
    normalize(query),
  );
}
