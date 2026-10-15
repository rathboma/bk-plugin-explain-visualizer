import type { PropertyValue, ValueFormat } from "./plan";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? integer.format(value) : decimal.format(value);
}

/** Milliseconds, scaled to the most readable unit. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms === 0) return "0 ms";
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Compact counts for tight spaces: 1.2K, 3.4M. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return formatNumber(Math.round(value * 100) / 100);
  const units = ["K", "M", "B", "T"];
  let scaled = value;
  let unit = "";
  for (const u of units) {
    if (Math.abs(scaled) < 1000) break;
    scaled /= 1000;
    unit = u;
  }
  return `${scaled.toFixed(Math.abs(scaled) < 10 ? 1 : 0)}${unit}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "–";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatCost(cost: number): string {
  return decimal.format(cost);
}

export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** PostgreSQL blocks are 8 kB unless the server was built otherwise. */
const BLOCK_SIZE = 8192;

export function formatValue(value: PropertyValue, format: ValueFormat = "text"): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  switch (format) {
    case "ms":
      return formatMs(value);
    case "rows":
      return `${formatNumber(value)} ${value === 1 ? "row" : "rows"}`;
    case "cost":
      return formatCost(value);
    case "bytes":
      return formatBytes(value);
    case "kilobytes":
      return formatBytes(value * 1024);
    case "blocks":
      return `${formatNumber(value)} (${formatBytes(value * BLOCK_SIZE)})`;
    case "percent":
      return formatPercent(value);
    default:
      return formatNumber(value);
  }
}
