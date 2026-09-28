/* global document, window */

import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { skillAuthoringDraftFixture } from "../src/modules/skill-authoring/skill-authoring.fixture.js";
import { SkillAuthoringLiveEditor } from "../src/modules/skill-authoring/skill-authoring-editor.js";
import { skillAuthoringMessages } from "../src/modules/skill-authoring/skill-authoring-messages.js";
import { createBrowserSkillAuthoringFileExchange } from "../src/modules/skill-authoring/skill-authoring-files.js";

const messages = skillAuthoringMessages("en");

function files(...entries) {
  return entries.map(([path, content]) => ({ path, content }));
}

const initialDraft = {
  ...skillAuthoringDraftFixture,
  slug: "browser-proof",
  files: files(
    ["SKILL.md", "original main"],
    ["resources/keep.txt", "keep resource"],
    ["resources/nested/lección%20.txt", "keep encoded resource"],
  ),
};

const importPlans = [
  { label: "cancel", files: files(["SKILL.md", "cancel main"]) },
  { label: "replace", files: files(["SKILL.md", "replace only main"]) },
  {
    label: "clean",
    files: files(["SKILL.md", "clean main"], ["resources/clean.txt", "clean resource"]),
  },
  { label: "stage-A", files: files(["SKILL.md", "staged A"], ["resources/a.txt", "resource A"]) },
  { label: "stage-B", files: files(["SKILL.md", "staged B"]) },
  { label: "order-A", files: files(["SKILL.md", "late A"]) },
  { label: "order-B", files: files(["SKILL.md", "late B"]) },
  { label: "pending-busy", files: files(["SKILL.md", "pending busy"]) },
  { label: "fresh-pending-busy", files: files(["SKILL.md", "fresh after pending busy"]) },
  { label: "staged-busy", files: files(["SKILL.md", "staged busy"]) },
  { label: "fresh-staged-busy", files: files(["SKILL.md", "fresh after staged busy"]) },
  { label: "pending-edit", files: files(["SKILL.md", "late after edit"]) },
  { label: "fresh-pending-edit", files: files(["SKILL.md", "fresh after pending edit"]) },
  { label: "staged-edit", files: files(["SKILL.md", "staged before edit"]) },
  { label: "fresh-staged-edit", files: files(["SKILL.md", "fresh after staged edit"]) },
  { label: "pending-navigation", files: files(["SKILL.md", "late after navigation"]) },
  {
    label: "fresh-pending-navigation",
    files: files(["SKILL.md", "fresh after pending navigation"]),
  },
  { label: "staged-navigation", files: files(["SKILL.md", "staged before navigation"]) },
  {
    label: "fresh-staged-navigation",
    files: files(["SKILL.md", "fresh after staged navigation"]),
  },
  { label: "pending-recovery", files: files(["SKILL.md", "late after recovery"]) },
  { label: "fresh-pending-recovery", files: files(["SKILL.md", "fresh after pending recovery"]) },
  { label: "staged-recovery", files: files(["SKILL.md", "staged during recovery"]) },
  { label: "fresh-staged-recovery", files: files(["SKILL.md", "fresh after staged recovery"]) },
  { label: "pending-unmount", files: files(["SKILL.md", "late after unmount"]) },
  { label: "fresh-pending-unmount", files: files(["SKILL.md", "fresh after pending unmount"]) },
  { label: "staged-unmount", files: files(["SKILL.md", "staged before unmount"]) },
  { label: "fresh-staged-unmount", files: files(["SKILL.md", "fresh after staged unmount"]) },
];

function cloneDraft(draft) {
  return { ...draft, files: draft.files.map((file) => ({ ...file })) };
}

const nativeFiles = createBrowserSkillAuthoringFileExchange();

function Fixture() {
  const [draft, setDraft] = useState(() => cloneDraft(initialDraft));
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState("original");
  const [recovery, setRecovery] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastImportLabel, setLastImportLabel] = useState("none");
  const pendingRef = useRef([]);
  const nextPlanRef = useRef(0);
  const nextOperationRef = useRef(1);

  const filesExchange = useMemo(
    () => ({
      importDirectory: () => {
        const plan = importPlans[nextPlanRef.current] ?? importPlans.at(-1);
        nextPlanRef.current += 1;
        const id = `op-${String(nextOperationRef.current)}`;
        nextOperationRef.current += 1;
        return new Promise((resolve) => {
          pendingRef.current.push({ id, plan, resolve });
          setPendingCount(pendingRef.current.length);
        });
      },
      importExplicit: (entries) => {
        if (window.__failNextExplicitImport) {
          window.__failNextExplicitImport = false;
          return Promise.reject(new Error("fixture-secret-raw-error"));
        }
        return nativeFiles.importExplicit(entries);
      },
      exportFile: nativeFiles.exportFile,
    }),
    [],
  );

  const resolveImport = (id) => {
    const index = pendingRef.current.findIndex((pending) => pending.id === id);
    if (index < 0) return;
    const [pending] = pendingRef.current.splice(index, 1);
    setPendingCount(pendingRef.current.length);
    setLastImportLabel(pending.plan.label);
    pending.resolve(pending.plan.files);
  };

  const resetEditor = () => {
    for (const pending of pendingRef.current.splice(0)) pending.resolve(pending.plan.files);
    setPendingCount(0);
    setLastImportLabel("none");
    setDraft(cloneDraft(initialDraft));
    setDirty(true);
    setBusy(false);
    setScreen("original");
    setRecovery(false);
    setMounted(true);
  };

  const edit = (nextDraft) => {
    setDraft(nextDraft);
    setDirty(true);
  };
  const contextKey = `${screen}:${recovery ? "recovery" : "editor"}`;
  const pendingOperations = pendingRef.current.map(({ id, plan }) => ({ id, label: plan.label }));

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("output", { "data-testid": "draft-state" }, JSON.stringify(draft)),
    React.createElement(
      "output",
      { "data-testid": "resource-state" },
      JSON.stringify(draft.files.filter((file) => file.path !== "SKILL.md")),
    ),
    React.createElement("output", { "data-testid": "dirty-state" }, String(dirty)),
    React.createElement("output", { "data-testid": "busy-state" }, String(busy)),
    React.createElement("output", { "data-testid": "context-state" }, contextKey),
    React.createElement("output", { "data-testid": "directory-pending" }, String(pendingCount)),
    React.createElement(
      "output",
      { "data-testid": "directory-pending-ids" },
      JSON.stringify(pendingOperations),
    ),
    React.createElement("output", { "data-testid": "last-import-label" }, lastImportLabel),
    React.createElement("button", { onClick: resetEditor }, "reset editor"),
    React.createElement("button", { onClick: () => setDirty(false) }, "mark clean"),
    React.createElement("button", { onClick: () => setBusy(true) }, "set busy true"),
    React.createElement("button", { onClick: () => setBusy(false) }, "set busy false"),
    React.createElement("button", { onClick: () => setScreen("away") }, "navigate away"),
    React.createElement(
      "button",
      { onClick: () => setScreen("original") },
      "return original context",
    ),
    React.createElement("button", { onClick: () => setRecovery(true) }, "enter recovery context"),
    React.createElement("button", { onClick: () => setRecovery(false) }, "leave recovery context"),
    React.createElement("button", { onClick: () => setMounted(false) }, "unmount editor"),
    React.createElement("button", { onClick: () => setMounted(true) }, "mount editor"),
    pendingOperations.map(({ id, label }) =>
      React.createElement(
        "button",
        { key: id, "aria-label": `resolve import ${id}`, onClick: () => resolveImport(id) },
        `resolve import ${id} (${label})`,
      ),
    ),
    React.createElement(
      "button",
      { onClick: () => (window.__failNextExplicitImport = true) },
      "fail next explicit import",
    ),
    mounted &&
      React.createElement(SkillAuthoringLiveEditor, {
        blocked: false,
        busy,
        copySource: null,
        contextKey,
        dirty,
        draft,
        edit,
        editable: true,
        expectedDigest: null,
        files: filesExchange,
        loadedBundle: null,
        messages,
        save: async () => undefined,
        copy: async () => undefined,
        validate: async () => undefined,
      }),
  );
}

window.__failNextExplicitImport = false;
window.__mareaUnhandledRejections = [];
window.addEventListener("unhandledrejection", (event) => {
  window.__mareaUnhandledRejections.push(String(event.reason?.message ?? event.reason));
  event.preventDefault();
});

createRoot(document.getElementById("fixture")).render(React.createElement(Fixture));
