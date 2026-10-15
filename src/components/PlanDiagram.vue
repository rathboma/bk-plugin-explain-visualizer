<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DiagramNode from "./DiagramNode.vue";
import Icon from "./Icon.vue";
import { useExplainer } from "../state/inject";
import { layoutPlan, linkPath, NODE_HEIGHT, NODE_WIDTH } from "../core/layout";
import { parentMap, type PlanNode } from "../core/plan";

const ex = useExplainer();
const { state, plan, stats } = ex;

const viewport = ref<HTMLElement>();
const view = reactive({ x: 0, y: 0, k: 1 });
const animating = ref(false);
let userMoved = false;

const layout = computed(() => (plan.value ? layoutPlan(plan.value.root) : undefined));
const parents = computed(() => (plan.value ? parentMap(plan.value) : new Map<number, PlanNode>()));

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
/** Fitting never zooms out further than this, so cards stay readable. */
const MIN_FIT_ZOOM = 0.7;
const PAD = 32;
const clamp = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Link thickness grows with the log of the rows flowing through it. */
function linkWidth(childId: number): number {
  const rows = stats.value?.nodes.get(childId)?.outputRows ?? 0;
  const max = stats.value?.maxOutputRows ?? 0;
  if (max <= 0) return 2;
  return 1.5 + 8.5 * (Math.log10(rows + 1) / Math.log10(max + 1));
}

function setView(x: number, y: number, k: number, animate = false) {
  animating.value = animate;
  view.x = x;
  view.y = y;
  view.k = k;
  if (animate) window.setTimeout(() => (animating.value = false), 220);
}

/** Shows the whole plan, or the top of it when it is too big to be legible. */
function fit(animate = false) {
  const el = viewport.value;
  const l = layout.value;
  if (!el || !l) return;
  const width = el.clientWidth;
  const height = el.clientHeight;
  const k = clamp(Math.max(MIN_FIT_ZOOM, Math.min(1, (width - PAD * 2) / l.width, (height - PAD * 2) / l.height)));
  const scaledHeight = l.height * k;
  const scaledWidth = l.width * k;
  const root = l.byId.get(plan.value!.root.id)!;
  const x =
    scaledWidth <= width - PAD * 2 ? (width - scaledWidth) / 2 : width / 2 - (root.x + NODE_WIDTH / 2) * k;
  const y = scaledHeight <= height - PAD * 2 ? (height - scaledHeight) / 2 : PAD + 12;
  userMoved = false;
  setView(x, y, k, animate);
}

function zoomAt(factor: number, cx?: number, cy?: number, animate = false) {
  const el = viewport.value;
  if (!el) return;
  const px = cx ?? el.clientWidth / 2;
  const py = cy ?? el.clientHeight / 2;
  const k = clamp(view.k * factor);
  const ratio = k / view.k;
  userMoved = true;
  setView(px - (px - view.x) * ratio, py - (py - view.y) * ratio, k, animate);
}

/** Pans so a node is in view, only when it isn't already. */
function reveal(id: number) {
  const el = viewport.value;
  const p = layout.value?.byId.get(id);
  if (!el || !p) return;
  const left = view.x + p.x * view.k;
  const top = view.y + p.y * view.k;
  const right = left + NODE_WIDTH * view.k;
  const bottom = top + NODE_HEIGHT * view.k;
  const margin = 24;
  if (left >= margin && top >= margin && right <= el.clientWidth - margin && bottom <= el.clientHeight - margin) return;
  const x = el.clientWidth / 2 - (p.x + NODE_WIDTH / 2) * view.k;
  const y = el.clientHeight / 2 - (p.y + NODE_HEIGHT / 2) * view.k;
  setView(x, y, view.k, true);
}

// Panning with the mouse; a click without movement clears the selection.
let drag: { id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | undefined;

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest(".node-card, .controls")) return;
  drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, moved: false };
  viewport.value?.setPointerCapture(event.pointerId);
}
function onPointerMove(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  userMoved = true;
  setView(drag.x + dx, drag.y + dy, view.k);
}
function onPointerUp(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved) ex.select(undefined);
  drag = undefined;
}

// Trackpads and wheels scroll; pinch or Ctrl/⌘ + wheel zooms.
function onWheel(event: WheelEvent) {
  event.preventDefault();
  const rect = viewport.value!.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX - rect.left, event.clientY - rect.top);
  } else {
    userMoved = true;
    setView(view.x - event.deltaX, view.y - event.deltaY, view.k);
  }
}

function onKeydown(event: KeyboardEvent) {
  const p = plan.value;
  if (!p) return;
  const current = state.selectedId === undefined ? undefined : p.nodes[state.selectedId];
  let next: number | undefined;
  switch (event.key) {
    case "ArrowUp":
      next = current ? parents.value.get(current.id)?.id : p.root.id;
      break;
    case "ArrowDown":
      next = current ? current.children[0]?.id : p.root.id;
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      if (!current) {
        next = p.root.id;
        break;
      }
      const siblings = parents.value.get(current.id)?.children ?? [];
      const index = siblings.findIndex((s) => s.id === current.id) + (event.key === "ArrowLeft" ? -1 : 1);
      next = siblings[index]?.id;
      break;
    }
    case "Escape":
      ex.select(undefined);
      return;
    case "+":
    case "=":
      zoomAt(1.2, undefined, undefined, true);
      return;
    case "-":
      zoomAt(1 / 1.2, undefined, undefined, true);
      return;
    case "0":
      fit(true);
      return;
    default:
      return;
  }
  event.preventDefault();
  if (next !== undefined) ex.select(next);
}

watch(
  () => plan.value,
  async () => {
    await nextTick();
    fit();
  }
);
watch(
  () => state.selectedId,
  (id) => {
    if (id !== undefined) reveal(id);
  }
);

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  fit();
  resizeObserver = new ResizeObserver(() => {
    if (!userMoved) fit();
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const zoomLabel = computed(() => `${Math.round(view.k * 100)}%`);
defineExpose({ fit });
</script>

<template>
  <div
    ref="viewport"
    class="diagram"
    tabindex="0"
    role="tree"
    aria-label="Plan diagram. Arrow keys move between nodes."
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @keydown="onKeydown"
  >
    <div
      v-if="layout"
      class="stage"
      :class="{ animating }"
      :style="{
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
      }"
    >
      <svg class="links" :width="layout.width" :height="layout.height">
        <path
          v-for="link in layout.links"
          :key="link.child.node.id"
          :d="linkPath(link)"
          :stroke-width="linkWidth(link.child.node.id)"
          :class="{
            active: state.selectedId === link.child.node.id || state.selectedId === link.parent.node.id,
            subplan: !!link.child.node.subplanName,
          }"
        />
      </svg>
      <DiagramNode
        v-for="p in layout.nodes"
        :key="p.node.id"
        :node="p.node"
        :x="p.x"
        :y="p.y"
        :stats="stats?.nodes.get(p.node.id)"
        :color-by="ex.colorBy.value"
        :analyzed="plan?.analyzed ?? false"
        :selected="state.selectedId === p.node.id"
        @select="ex.select"
      />
    </div>

    <div class="controls">
      <button class="btn ghost icon-only" title="Zoom out (-)" @click="zoomAt(1 / 1.25, undefined, undefined, true)">
        <Icon name="zoomOut" />
      </button>
      <button class="zoom-label" title="Reset to 100%" @click="setView(view.x, view.y, 1, true)">{{ zoomLabel }}</button>
      <button class="btn ghost icon-only" title="Zoom in (+)" @click="zoomAt(1.25, undefined, undefined, true)">
        <Icon name="zoomIn" />
      </button>
      <button class="btn ghost icon-only" title="Fit to view (0)" @click="fit(true)">
        <Icon name="fit" />
      </button>
    </div>
    <div class="legend hint">
      Data flows upward. Wider links carry more rows. Color shows each step's share of
      {{ ex.colorBy.value === "time" ? "execution time" : "estimated cost" }}.
    </div>
  </div>
</template>

<style scoped>
.diagram {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background-color: var(--canvas);
  background-image: radial-gradient(circle, var(--border-color) 1px, transparent 1px);
  background-size: 22px 22px;
  cursor: grab;
  outline: none;
  touch-action: none;
}
.diagram:active {
  cursor: grabbing;
}
.stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
.stage.animating {
  transition: transform 0.2s ease-out;
}
.links {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
}
.links path {
  fill: none;
  stroke: color-mix(in srgb, var(--theme-base) 16%, transparent);
  stroke-linecap: round;
  transition: stroke 0.12s;
}
.links path.subplan {
  stroke-dasharray: 6 5;
}
.links path.active {
  stroke: color-mix(in srgb, var(--accent) 70%, transparent);
}
.controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--raised);
  box-shadow: var(--shadow);
  cursor: default;
}
.zoom-label {
  min-width: 44px;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  max-width: calc(100% - 220px);
  padding: 3px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--canvas) 85%, transparent);
  pointer-events: none;
}
</style>
