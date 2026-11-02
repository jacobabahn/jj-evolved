// @ts-nocheck
for (const n of [50_000, 100_000, 130_000, 200_000, 350_000, 500_000, 700_000, 1_000_000, 1_500_000]) {
  try { Math.max(0, ...new Array(n).fill(0)); console.log(n, "ok"); } catch (e) { console.log(n, String(e)); }
}
