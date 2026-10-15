<script setup lang="ts">
/** Small stroke icons drawn on a 16×16 grid. */
const PATHS: Record<string, string> = {
  // Node kinds
  scan: "M3 4h10M3 8h10M3 12h10",
  index: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM10 10l3.5 3.5",
  join: "M6 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM10 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z",
  aggregate: "M12 3H4l4.5 5L4 13h8",
  sort: "M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5",
  limit: "M3 4h10M3 8h6M3 12h3",
  materialize: "M3 5l5-2.5 5 2.5-5 2.5zM3 8l5 2.5 5-2.5M3 11l5 2.5 5-2.5",
  set: "M4 3v5a4 4 0 0 0 8 0V3",
  subquery: "M6 3c-2 0-2 1-2 2.5S3.5 8 2.5 8c1 0 1.5.5 1.5 2.5S4 13 6 13M10 3c2 0 2 1 2 2.5s.5 2.5 1.5 2.5c-1 0-1.5.5-1.5 2.5S12 13 10 13",
  modify: "M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5",
  parallel: "M4.5 3v10M8 3v10M11.5 3v10",
  other: "M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  // Interface
  play: "M5 3.5v9l7-4.5z",
  timer: "M8 5.5V9l2 1.5M8 3a5.5 5.5 0 1 0 0 11A5.5 5.5 0 1 0 8 3zM6.5 1.5h3",
  tune: "M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7M11 3v3M5 10v3",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  download: "M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10",
  zoomIn: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM10 10l3.5 3.5M5 7h4M7 5v4",
  zoomOut: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM10 10l3.5 3.5M5 7h4",
  fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  warning: "M8 2.5l6 11H2zM8 6.5v3M8 11.5v.5",
  critical: "M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 5v3.5M8 10.5v.5",
  info: "M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 7.5V11M8 5v.5",
  close: "M4 4l8 8M12 4l-8 8",
  chevronDown: "M4 6l4 4 4-4",
  chevronUp: "M4 10l4-4 4 4",
  diagram: "M6 2.5h4v3H6zM2.5 10.5h4v3h-4zM9.5 10.5h4v3h-4zM8 5.5V8M4.5 10.5V8h7v2.5",
  table: "M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6 6.5v6",
  code: "M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5",
  external: "M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v4h-9v-9h4",
  paste: "M5.5 3h-2v10.5h9V3h-2M5.5 2h5v2.5h-5z",
  panel: "M2.5 3h11v10h-11zM9.5 3v10",
};

defineProps<{ name: string; size?: number; title?: string }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="title ? undefined : 'true'"
    :role="title ? 'img' : undefined"
  >
    <title v-if="title">{{ title }}</title>
    <path :d="PATHS[name] ?? PATHS.other" :fill="name === 'play' ? 'currentColor' : 'none'" />
  </svg>
</template>
