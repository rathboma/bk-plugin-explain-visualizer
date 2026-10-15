/** Buckets a node's share of time or cost into four heat levels (0 = cold). */
export function heatLevel(share: number): 0 | 1 | 2 | 3 {
  if (share >= 0.5) return 3;
  if (share >= 0.2) return 2;
  if (share >= 0.05) return 1;
  return 0;
}
