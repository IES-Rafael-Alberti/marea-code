import { expect, it } from "vitest";
import { themeProperties } from "./theme.js";
import marea from "../../../../plugins/dashboard-themes/marea/src/index.js";
import highContrast from "../../../../plugins/dashboard-themes/high-contrast/src/index.js";
const themes = [
  { id: "marea", descriptor: marea },
  { id: "high-contrast", descriptor: highContrast },
];
function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}
it.each(themes)("validates $id semantic contrast pairs and closed CSS mapping", (theme) => {
  const t = theme.descriptor.tokens;
  const properties = themeProperties(t);
  expect(properties["--color-text"]).toBe(t.text.primary);
  expect(properties["--color-background"]).toBe(t.surfaces.canvas);
  expect(properties["--focus-width"]).toBe(`${String(t.focus.width)}px`);
  expect(properties["--shadow-surface"]).toBe(`0px 0px 0px 0px ${t.shadow.color}`);
  expect(properties["--chart-6"]).toBe(t.chartSeries[5]);
  for (const surface of Object.values(t.surfaces)) {
    for (const text of [t.text.primary, t.text.secondary, ...Object.values(t.states)])
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    for (const line of [t.borders.default, t.borders.strong, t.focus.color])
      expect(contrast(line, surface)).toBeGreaterThanOrEqual(3);
  }
  expect(contrast(t.actions.background, t.actions.foreground)).toBeGreaterThanOrEqual(7);
  expect(contrast(t.actions.hover, t.actions.foreground)).toBeGreaterThanOrEqual(7);
  expect(new Set(t.chartSeries).size).toBe(t.chartSeries.length);
  expect(() => themeProperties({ ...t, text: { ...t.text, primary: "url(secret)" } })).toThrow();
});
it.each(themes)("maps $id numeric token units without arbitrary CSS", (theme) => {
  const t = theme.descriptor.tokens;
  expect(themeProperties(t)).toMatchObject({
    "--focus-offset": `${String(t.focus.offset)}px`,
    "--theme-font-size": `${String(t.typography.fontSize)}px`,
    "--space-small": `${String(t.spacing.small)}px`,
    "--space-medium": `${String(t.spacing.medium)}px`,
    "--space-large": `${String(t.spacing.large)}px`,
    "--radius-small": `${String(t.radius.small)}px`,
    "--radius-large": `${String(t.radius.large)}px`,
  });
});
