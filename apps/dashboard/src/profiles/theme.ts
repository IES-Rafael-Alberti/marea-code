import { DashboardThemeTokensSchema, type DashboardThemeTokens } from "@marea/plugin-api";

const fonts = {
  "system-sans": "system-ui, sans-serif",
  "system-serif": "ui-serif, Georgia, serif",
  "system-mono": "ui-monospace, monospace",
};
/** Validated token data maps only to this fixed host allowlist. */
export function themeProperties(input: DashboardThemeTokens): Readonly<Record<string, string>> {
  const t = DashboardThemeTokensSchema.parse(input);
  return {
    "--color-background": t.surfaces.canvas,
    "--color-surface": t.surfaces.panel,
    "--color-shoal": t.surfaces.raised,
    "--color-text": t.text.primary,
    "--color-heading": t.text.primary,
    "--color-muted": t.text.secondary,
    "--color-border": t.borders.default,
    "--color-border-strong": t.borders.strong,
    "--color-accent": t.actions.background,
    "--color-status": t.states.info,
    "--color-success": t.states.success,
    "--color-error": t.states.error,
    "--color-warning": t.states.warning,
    "--color-inverse": t.text.inverse,
    "--action-foreground": t.actions.foreground,
    "--action-hover": t.actions.hover,
    "--action-disabled": t.actions.disabled,
    "--focus-color": t.focus.color,
    "--focus-width": `${String(t.focus.width)}px`,
    "--focus-offset": `${String(t.focus.offset)}px`,
    "--theme-font": fonts[t.typography.fontFamily],
    "--theme-font-size": `${String(t.typography.fontSize)}px`,
    "--theme-line-height": String(t.typography.lineHeight),
    "--space-small": `${String(t.spacing.small)}px`,
    "--space-medium": `${String(t.spacing.medium)}px`,
    "--space-large": `${String(t.spacing.large)}px`,
    "--radius-small": `${String(t.radius.small)}px`,
    "--radius-large": `${String(t.radius.large)}px`,
    "--shadow-surface": `${String(t.shadow.x)}px ${String(t.shadow.y)}px ${String(t.shadow.blur)}px ${String(t.shadow.spread)}px ${t.shadow.color}`,
    ...Object.fromEntries(
      t.chartSeries.map((color, index) => [`--chart-${String(index + 1)}`, color]),
    ),
  };
}
