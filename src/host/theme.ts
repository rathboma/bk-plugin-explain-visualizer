import type { AppTheme } from "./host";

/** Applies Beekeeper Studio's theme variables to the plugin page. */
export function applyTheme(theme: AppTheme | undefined): void {
  if (!theme) return;
  const style = document.getElementById("app-theme");
  if (style) style.textContent = `:root { ${theme.cssString} }`;
  document.documentElement.dataset.theme = theme.type;
}
