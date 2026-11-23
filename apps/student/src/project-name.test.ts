import { describe, expect, it } from "vitest";

import { projectDisplayNameFromFolder } from "./project-name.js";

describe("projectDisplayNameFromFolder", () => {
  it.each([
    ["C++", "C__"],
    ["tarea#2", "tarea_2"],
    ["notas&ejercicios", "notas_ejercicios"],
    [".hidden", "hidden"],
    ["Unidad 2 (copia)", "Unidad 2 (copia)"],
    ["ñandúº", "ñandúº"],
    ["x".repeat(130), "x".repeat(120)],
    ["...", "project"],
    ["x".repeat(119) + " y", "x".repeat(119)],
  ])("sanitizes %s", (folder, expected) => {
    expect(projectDisplayNameFromFolder(folder)).toBe(expected);
  });
});
