// GTA VI launch-day Twitch CCU forecaster (gta6-twitch-ccu-forecast-01).
//
// Model: per-hour OLS of log(viewers_h / viewers_1) on log(hour-1 print),
// fitted at runtime from the case file's own comparables (hour-1 >= 10k,
// excluding the GTA VI pre-release category, which is a premiere, not a
// launch). The ratio is floored at the big-launch (p1 >= 50k) medians, then
// adjusted for the DST-aware US unlock wave (East midnight wave, West +3h),
// and quantiles are lognormal around the median with spread
// s_h = 0.85 * max(residual SD, 0.25). If fewer than 15 comparables qualify,
// a hardcoded fitted table (same coefficients, floors and spreads) is used.
//
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOURS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
// Wave blend: sqrt(practice-4 median / pooled p1>=10k median) at wave+0..+4.
const WAVE_BLEND = [1.322, 1.3, 1.256, 1.196, 1.147];
// Hardcoded fallback table (research §4.1): [a_h, b_h, residSD_h, FLOOR_h]
// for h = 2..24, fitted on comparables with hour-1 >= 10k (n = 28).
const FALLBACK: Array<[number, number, number, number]> = [
  [-0.696, 0.053, 0.199, 0.91],
  [-1.471, 0.101, 0.315, 0.8],
  [-0.795, 0.036, 0.317, 0.73],
  [-0.041, -0.024, 0.352, 0.73],
  [0.531, -0.067, 0.519, 0.74],
  [1.264, -0.131, 0.547, 0.68],
  [2.087, -0.2, 0.527, 0.66],
  [2.462, -0.234, 0.534, 0.62],
  [2.783, -0.261, 0.546, 0.54],
  [2.733, -0.255, 0.563, 0.53],
  [2.976, -0.271, 0.58, 0.58],
  [3.079, -0.269, 0.614, 0.71],
  [3.265, -0.274, 0.64, 0.87],
  [3.62, -0.294, 0.66, 1.02],
  [3.894, -0.31, 0.644, 1.09],
  [3.777, -0.292, 0.6, 1.24],
  [4.577, -0.353, 0.521, 1.28],
  [5.722, -0.442, 0.521, 1.31],
  [6.369, -0.495, 0.535, 1.35],
  [6.298, -0.488, 0.528, 1.37],
  [6.14, -0.477, 0.502, 1.24],
  [5.915, -0.463, 0.483, 1.15],
  [5.465, -0.434, 0.48, 1.17],
];

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}
interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: HourlyPoint[];
}
interface CaseFile {
  id?: string;
  day_start: string;
  checkpoint?: string;
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  history_hourly?: HourlyPoint[];
  streams?: Array<{ viewers: number }> | null;
  categories_hourly?: unknown;
  comparables?: Comparable[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// Hour index of an ISO instant, as epoch milliseconds (hour-aligned inputs).
const hourMs = (iso: string): number => Date.parse(iso);

// nth Sunday of a month (UTC), as epoch ms at 00:00Z.
function nthSundayMs(year: number, month0: number, n: number): number {
  const first = Date.UTC(year, month0, 1);
  const dow = new Date(first).getUTCDay(); // 0 = Sunday
  const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
  return Date.UTC(year, month0, day);
}

// US daylight saving time in effect at the given instant: second Sunday of
// March 07:00Z to first Sunday of November 06:00Z.
function isUsDst(ms: number): boolean {
  const year = new Date(ms).getUTCFullYear();
  const start = nthSundayMs(year, 2, 2) + 7 * 3600 * 1000;
  const end = nthSundayMs(year, 10, 1) + 6 * 3600 * 1000;
  return ms >= start && ms < end;
}

// Anchor: hour-1 print; fallbacks per the spec (mean of hour-1 history,
// streams top-20 sum, then 1). The pre-launch level is never an anchor.
function anchorP1(c: CaseFile): number {
  const known1 = (c.known ?? []).find((k) => k.hour === 1);
  if (known1 !== undefined && Number.isFinite(known1.viewers) && known1.viewers > 0) {
    return known1.viewers;
  }
  const start = hourMs(c.day_start);
  const end = c.checkpoint !== undefined ? hourMs(c.checkpoint) : start + 3600 * 1000;
  const inHour1 = (c.history_hourly ?? []).filter((p) => {
    const t = hourMs(p.from);
    return t >= start && t < end && Number.isFinite(p.viewers) && p.viewers > 0;
  });
  if (inHour1.length > 0) {
    const mean = inHour1.reduce((s, p) => s + p.viewers, 0) / inHour1.length;
    if (mean > 0) return mean;
  }
  if (Array.isArray(c.streams) && c.streams.length > 0) {
    const sum = c.streams.reduce((s, st) => s + (Number.isFinite(st.viewers) ? st.viewers : 0), 0);
    if (sum > 0) return Math.max(1, sum);
  }
  return 1;
}

// Fit set: comparables sorted by name (deterministic), with a valid hour-1
// print >= 10k, excluding the GTA VI pre-release category.
function fitSet(c: CaseFile): Array<{ p1: number; byHour: Map<number, number> }> {
  const comps = [...(c.comparables ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: Array<{ p1: number; byHour: Map<number, number> }> = [];
  for (const comp of comps) {
    if (typeof comp.name === 'string' && comp.name.includes('Grand Theft Auto VI')) continue;
    if (!Array.isArray(comp.hourly)) continue;
    const base = hourMs(comp.day_start);
    if (!Number.isFinite(base)) continue;
    const byHour = new Map<number, number>();
    for (const p of comp.hourly) {
      if (!Number.isFinite(p.viewers) || p.viewers <= 0) continue;
      const h = Math.round((hourMs(p.from) - base) / 3600000) + 1;
      if (h >= 1 && h <= 24 && !byHour.has(h)) byHour.set(h, p.viewers);
    }
    const p1 = byHour.get(1);
    if (p1 === undefined || p1 < 10000) continue;
    out.push({ p1, byHour });
  }
  return out;
}

// Per-hour OLS of ln(v_h / v_1) on ln(p1); returns [a, b, residSD] per hour.
// An hour with too few points falls back to its hardcoded fitted row
// instead of a flat ratio, so a sparse hour can never silently flatten.
function fitOls(
  fit: Array<{ p1: number; byHour: Map<number, number> }>,
  fallback: Array<[number, number, number, number]>,
): Array<[number, number, number]> {
  return HOURS.map((h, i) => {
    const pts: Array<[number, number]> = [];
    for (const comp of fit) {
      const vh = comp.byHour.get(h);
      if (vh !== undefined) pts.push([Math.log(comp.p1), Math.log(vh / comp.p1)]);
    }
    const n = pts.length;
    if (n < 3) return [fallback[i][0], fallback[i][1], fallback[i][2]];
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (y - my);
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    let ss = 0;
    for (const [x, y] of pts) {
      const r = y - (a + b * x);
      ss += r * r;
    }
    const residSD = n > 2 ? Math.sqrt(ss / (n - 2)) : 0.25;
    return [a, b, residSD];
  });
}

function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const p1raw = anchorP1(c);
  const p1 = Math.max(1, p1raw);
  const fit = fitSet(c);
  const useFit = fit.length >= 15;
  const coefs = useFit ? fitOls(fit, FALLBACK) : FALLBACK.map(([a, b, s]) => [a, b, s] as [number, number, number]);
  const floors = FALLBACK.map((row) => row[3]);

  const lp = clamp(Math.log(p1), Math.log(1000), Math.log(2000000));

  // DST-aware unlock wave: East midnight wave hour, West three hours later.
  const dayMs = hourMs(c.day_start);
  const eastWave = Number.isFinite(dayMs) && isUsDst(dayMs) ? 5 : 6;
  const westWave = eastWave + 3;

  const hours = HOURS.map((h, i) => {
    const [a, b, residSD] = coefs[i];
    let r = Math.exp(a + b * lp);
    r = Math.max(r, floors[i]);
    // Wave blend over wave+0..+4, then the per-wave bumps.
    const off = h - eastWave;
    if (off >= 0 && off <= 4) r *= WAVE_BLEND[off];
    if (h === eastWave) r *= 1.35;
    if (h === eastWave + 1) r *= 1.15;
    if (h === westWave) r *= 1.1;
    r = clamp(r, 0.3, 25);
    const s = 0.85 * Math.max(residSD, 0.25);
    const q = Z.map((z) => round2(clamp(p1 * r * Math.exp(z * s), 1, 1e9)));
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) {
      if (q[j] < q[j - 1]) q[j] = q[j - 1];
    }
    return { hour: h, q };
  });
  return { hours };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  // streams / categories_hourly may be null; they are only null-checked
  // (streams guard lives in anchorP1) and never dereferenced blindly.
  void c.categories_hourly;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
