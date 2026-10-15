import { inject, type InjectionKey } from "vue";
import type { Explainer } from "./explainer";

export const ExplainerKey: InjectionKey<Explainer> = Symbol("explainer");

export function useExplainer(): Explainer {
  const explainer = inject(ExplainerKey);
  if (!explainer) throw new Error("useExplainer() called outside the app");
  return explainer;
}
