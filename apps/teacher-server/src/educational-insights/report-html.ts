import type { ClassReports } from "./reports.js";
import { TeacherDomainError } from "../identity/errors.js";
const copy = {
  es: {
    title: "Informe de clase",
    partial: "Informe parcial",
    complete: "Completo",
    evidence: "Evidencias",
    session: "Sesión",
    student: "Alumno",
    mode: "Modo",
    status: "Estado",
    approved: "Aprobada",
    provisional: "Provisional",
    unavailable: "No disponible",
    tutoring: "Tutoría",
    free: "Libre",
  },
  en: {
    title: "Class report",
    partial: "Partial report",
    complete: "Complete",
    evidence: "Evidence",
    session: "Session",
    student: "Student",
    mode: "Mode",
    status: "Status",
    approved: "Approved",
    provisional: "Provisional",
    unavailable: "Unavailable",
    tutoring: "Tutoring",
    free: "Free",
  },
  eu: {
    title: "Gelako txostena",
    partial: "Txosten partziala",
    complete: "Osoa",
    evidence: "Ebidentziak",
    session: "Saioa",
    student: "Ikaslea",
    mode: "Modua",
    status: "Egoera",
    approved: "Onartua",
    provisional: "Behin-behinekoa",
    unavailable: "Ez dago erabilgarri",
    tutoring: "Tutoretza",
    free: "Librea",
  },
};
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function renderReport(report: ReturnType<ClassReports["read"]>): string {
  if (report.state !== "complete" || report.result === null)
    throw new TeacherDomainError("request.conflict");
  const result = report.result,
    m = copy[report.locale];
  const name = (alias: string) =>
    report.students.find((s) => s.alias === alias)?.displayName ?? alias;
  const findings = result.synthesis.findings
    .map(
      (f) =>
        `<article><h2>${escape(f.title)}</h2><p>${m[f.mode]} · ${String(f.affected.length)}/${String(f.evaluable.length)} (${String(f.evaluable.length === 0 ? 0 : Math.round((100 * f.affected.length) / f.evaluable.length))}%)</p><p>${escape(f.explanation)}</p><p>${escape(f.recommendation)}</p><p>${escape(f.affected.map(name).join(", "))}</p><p>${escape(f.evidence.join(", "))}</p></article>`,
    )
    .join("");
  const evidence = result.evidence
    .map(
      (e) =>
        `<tr><td>${escape(e.runId)}</td><td>${escape(name(e.alias))}</td><td>${m[e.mode]}</td><td>${m[e.status]}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="${report.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${m.title}</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px}article{break-inside:avoid;border-top:1px solid #bbb;padding:16px 0}table{width:100%;border-collapse:collapse}td,th{padding:8px;border:1px solid #bbb;text-align:left;overflow-wrap:anywhere}@media print{body{margin:0;padding:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body><h1>${m.title}</h1><p>${escape(report.from)} — ${escape(report.to)}</p><p>${result.partial ? m.partial : m.complete}</p><p>${escape(result.synthesis.summary)}</p>${findings}<p>${escape(result.synthesis.recommendation)}</p><h2>${m.evidence}</h2><table><thead><tr><th>${m.session}</th><th>${m.student}</th><th>${m.mode}</th><th>${m.status}</th></tr></thead><tbody>${evidence}</tbody></table></body></html>`;
}
