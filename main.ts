// GTA VI trophy rarity forecast — dilution + earn-hazard model.
//
// Exophase only refreshes a game's counts in jumps: between refreshes the
// page is frozen, so a flat stretch of history carries no signal about play.
// At a refresh the tracked population jumps from N to N' and the holders of
// trophy i jump from C to C'. That jump mixes two things: the old cohort
// earning more trophies between reads, and newcomers arriving with the
// trophy already earned. Across the refreshes in a case's history we split
// the two with a two-term fit, per trophy:
//
//     C' - C  ~=  a * (N - C) * dt  +  b * (C / N) * (N' - N)
//
// a is the per-hour hazard that a non-holder earns the trophy, b is the
// share of newcomers who arrive already holding it, as a fraction of the
// trophy's current rate. Both are fitted per trophy and clamped to sane
// ranges; with no refresh in the history they fall back to priors (a = 0,
// b = the trophy's own rate, so newcomers hold almost nothing but the one
// trophy everybody holds).
//
// The population at the target is projected from the refreshes seen so far:
// their rate per hour, their mean log growth, and a decay that lets each
// later refresh add less than the one before it. When the history is flat
// — launch night, no refresh yet — we fall back to the launch-night prior:
// Exophase's first refresh multiplied the tracked population about sixfold,
// so one refresh of about that size is expected before a short target.
//
// Holders are then simulated forward to the target in small steps, with
// the fitted hazard earning trophies for the current cohort and each
// population jump bringing newcomers at share b of the current rate.
//
// The spread is honest about refresh jumps: a random-walk term in the
// horizon plus the jump sizes the history actually showed (or the
// launch-night prior when it showed none), so the 90% band is wide enough
// to cover a refresh the history has not seen yet.
//
// Node 22, standard library only. Reads every *.in case in
// $MAKEFUN_INPUT_DIR (else /input) and writes /output/<id>.out (or
// $MAKEFUN_OUTPUT_DIR): {"trophies": [{"id": n, "q": [q05, q25, q50, q75,
// q95]}, ...]}. Deterministic: no clock, no randomness, fixed order.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** How much the tracked population multiplied at launch night's first refresh. */
const FIRST_REFRESH_GROWTH = 3868 / 638;
/** Hours between Exophase refreshes on launch night, used when none is seen. */
const REFRESH_EVERY_HOURS = 4;
/** Steps the forward simulation takes from the last read to the target. */
const SIM_STEPS = 24;

type Trophy = { id: number };
type Read = { at: string; players_tracked: number; rates: Array<number | null> };
type CaseFile = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
};

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** A rate in percent, clamped the way the scorer clamps it. */
const clampRate = (x: number): number => clamp(x, 0.01, 99.99);
const logitOf = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => clampRate(100 / (1 + Math.exp(-l)));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Fit y ~= a*u + b*v by least squares, with a in [0, 0.5] and b in [0, 1].
 * Tries the unconstrained solve, then the edges (a = 0, b = 0, both 0), and
 * keeps whichever fits best. Returns [a, b].
 */
function fitHazardAndShare(
  us: number[],
  vs: number[],
  ys: number[],
): [number, number] {
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suy = 0;
  let svy = 0;
  for (let k = 0; k < ys.length; k += 1) {
    suu += us[k] * us[k];
    suv += us[k] * vs[k];
    svv += vs[k] * vs[k];
    suy += us[k] * ys[k];
    svy += vs[k] * ys[k];
  }
  const sse = (a: number, b: number): number => {
    let s = 0;
    for (let k = 0; k < ys.length; k += 1) {
      const d = ys[k] - a * us[k] - b * vs[k];
      s += d * d;
    }
    return s;
  };
  const candidates: Array<[number, number]> = [[0, 0]];
  const det = suu * svv - suv * suv;
  if (Math.abs(det) > 1e-12) {
    const a = (suy * svv - svy * suv) / det;
    const b = (svy * suu - suy * suv) / det;
    candidates.push([clamp(a, 0, 0.5), clamp(b, 0, 1)]);
  }
  if (suu > 0) candidates.push([clamp(suy / suu, 0, 0.5), 0]);
  if (svv > 0) candidates.push([0, clamp(svy / svv, 0, 1)]);
  let best: [number, number] = [0, 0];
  let bestSse = Infinity;
  for (const [a, b] of candidates) {
    const e = sse(a, b);
    if (e < bestSse) {
      bestSse = e;
      best = [a, b];
    }
  }
  return best;
}

/** Forecast one case: five quantiles per trophy at the case's target. */
function forecast(c: CaseFile): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);
  const releaseMs = Date.parse(c.game.release_date);
  const epochMs = Number.isFinite(releaseMs) ? releaseMs : Date.parse(c.history[0].at);
  const hoursSinceRelease = (iso: string): number => (Date.parse(iso) - epochMs) / 3_600_000;
  const horizonDays = c.horizon_minutes / 1440;
  const targetMs = Date.parse(c.target);
  const lastRead = c.history[c.history.length - 1];
  const simHours = Math.max(c.horizon_minutes / 60, (targetMs - Date.parse(lastRead.at)) / 3_600_000);

  // Refreshes: reads where the tracked population jumped. The counts a read
  // shows are frozen since the previous refresh, so the earning a jump
  // carries accumulated over the whole stretch since that refresh — not
  // over the ten minutes between the two reads that straddle it.
  type Refresh = {
    dt: number;
    nPrev: number;
    nNew: number;
    logGrowth: number;
    atHours: number;
    prevIdx: number;
    curIdx: number;
  };
  const refreshes: Refresh[] = [];
  let lastRefreshMs = Date.parse(c.history[0].at);
  for (let j = 1; j < c.history.length; j += 1) {
    const prev = c.history[j - 1];
    const cur = c.history[j];
    if (cur.players_tracked > prev.players_tracked) {
      refreshes.push({
        dt: (Date.parse(cur.at) - lastRefreshMs) / 3_600_000,
        nPrev: prev.players_tracked,
        nNew: cur.players_tracked - prev.players_tracked,
        logGrowth: Math.log(cur.players_tracked / prev.players_tracked),
        atHours: hoursSinceRelease(cur.at),
        prevIdx: j - 1,
        curIdx: j,
      });
      lastRefreshMs = Date.parse(cur.at);
    }
  }

  // Expected refreshes before the target, and the population there.
  const historySpanHours = Math.max(
    (Date.parse(lastRead.at) - Date.parse(c.history[0].at)) / 3_600_000,
    1 / 60,
  );
  let expectedRefreshes: number;
  let targetPlayers: number;
  if (refreshes.length === 0) {
    expectedRefreshes = Math.max(1, simHours / REFRESH_EVERY_HOURS);
    targetPlayers = lastRead.players_tracked * Math.pow(FIRST_REFRESH_GROWTH, expectedRefreshes);
    targetPlayers = Math.min(targetPlayers, lastRead.players_tracked * 50);
  } else {
    const ratePerHour = refreshes.length / historySpanHours;
    expectedRefreshes = Math.min(ratePerHour * simHours, 60);
    // Later refreshes add less: fit log growth against refresh index when
    // there are enough of them, else decay the mean log growth by 0.85 a
    // refresh. Either way the total growth stays bounded.
    let totalLogGrowth = 0;
    if (refreshes.length >= 3) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      refreshes.forEach((r, j) => {
        sx += j;
        sy += r.logGrowth;
        sxx += j * j;
        sxy += j * r.logGrowth;
      });
      const n = refreshes.length;
      const denom = n * sxx - sx * sx;
      const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / n;
      const meanLog = sy / n;
      for (let k = 1; k <= Math.ceil(expectedRefreshes); k += 1) {
        const g = intercept + slope * (n - 1 + k);
        totalLogGrowth += clamp(g, 0, meanLog) * Math.pow(0.85, k);
      }
    } else {
      const meanLog = refreshes.reduce((s, r) => s + r.logGrowth, 0) / refreshes.length;
      const decay = 0.85;
      totalLogGrowth =
        (meanLog * (1 - Math.pow(decay, expectedRefreshes))) / (1 - decay);
    }
    totalLogGrowth = Math.min(totalLogGrowth, Math.log(50));
    targetPlayers = lastRead.players_tracked * Math.exp(totalLogGrowth);
  }

  // How jumpy the rates are at a refresh, after removing each refresh's
  // average move: the honest extra spread a future refresh adds.
  let jumpSpread = 0.6;
  if (refreshes.length > 0) {
    const residuals: number[] = [];
    const refreshIdx = new Set<number>();
    for (let j = 1; j < c.history.length; j += 1) {
      if (c.history[j].players_tracked > c.history[j - 1].players_tracked) refreshIdx.add(j);
    }
    for (const j of refreshIdx) {
      const prev = c.history[j - 1];
      const cur = c.history[j];
      const moves: number[] = [];
      for (let i = 0; i < c.trophies.length; i += 1) {
        const rPrev = prev.rates[i];
        const rCur = cur.rates[i];
        if (rPrev !== null && rCur !== null && rPrev > 0 && rCur > 0) {
          moves.push(Math.log(rCur / rPrev));
        }
      }
      if (moves.length === 0) continue;
      const mean = moves.reduce((s, m) => s + m, 0) / moves.length;
      for (const m of moves) residuals.push(m - mean);
    }
    if (residuals.length >= 5) {
      const mean = residuals.reduce((s, e) => s + e, 0) / residuals.length;
      const variance =
        residuals.reduce((s, e) => s + (e - mean) * (e - mean), 0) / residuals.length;
      jumpSpread = clamp(Math.sqrt(variance), 0.1, 1.5);
    }
  }
  const baseSpread = 0.5 * Math.sqrt(horizonDays);
  const spread = clamp(
    Math.sqrt(0.3 * 0.3 + baseSpread * baseSpread + jumpSpread * jumpSpread * expectedRefreshes),
    0.4,
    2.5,
  );

  // Per trophy: fit the hazard and the newcomers' share, then simulate.
  return c.trophies.map((t, i) => {
    const lastRate = lastRead.rates[i] ?? 0;
    const lastCount = (lastRate / 100) * lastRead.players_tracked;
    let hazard = 0;
    let share = lastRate >= 99.99 ? 1 : lastRate / 100;
    if (refreshes.length === 1) {
      // One jump cannot split the two terms: keep the share prior and read
      // the hazard off the jump that is left. The jump's earning covers
      // the whole stretch since the first read, not the gap between the
      // two reads that straddle it.
      const r0 = refreshes[0];
      const prev = c.history[r0.prevIdx];
      const cur = c.history[r0.curIdx];
      const rPrev = prev.rates[i] ?? 0;
      const cPrev = (rPrev / 100) * prev.players_tracked;
      const cCur = ((cur.rates[i] ?? 0) / 100) * cur.players_tracked;
      const fromNewcomers = share * (rPrev / 100) * (cur.players_tracked - prev.players_tracked);
      const nonHolders = Math.max(prev.players_tracked - cPrev, 1);
      hazard = r0.dt > 0 ? clamp((cCur - cPrev - fromNewcomers) / (nonHolders * r0.dt), 0, 0.5) : 0;
    } else if (refreshes.length >= 2) {
      const us: number[] = [];
      const vs: number[] = [];
      const ys: number[] = [];
      for (const r0 of refreshes) {
        const prev = c.history[r0.prevIdx];
        const cur = c.history[r0.curIdx];
        const rPrev = prev.rates[i] ?? 0;
        const cPrev = (rPrev / 100) * prev.players_tracked;
        const cCur = ((cur.rates[i] ?? 0) / 100) * cur.players_tracked;
        us.push(Math.max(prev.players_tracked - cPrev, 0) * r0.dt);
        vs.push((rPrev / 100) * (cur.players_tracked - prev.players_tracked));
        ys.push(cCur - cPrev);
      }
      [hazard, share] = fitHazardAndShare(us, vs, ys);
    }

    // Forward simulation: the cohort earns at `hazard`, the population
    // grows geometrically toward targetPlayers, newcomers arrive holding
    // the trophy at `share` of the current rate.
    let players = lastRead.players_tracked;
    let holders = lastCount;
    const growthPerStep = Math.pow(targetPlayers / players, 1 / SIM_STEPS);
    const dtStep = simHours / SIM_STEPS;
    for (let s = 0; s < SIM_STEPS; s += 1) {
      const newcomers = players * growthPerStep - players;
      holders += hazard * Math.max(players - holders, 0) * dtStep;
      holders += share * (holders / players) * newcomers;
      players *= growthPerStep;
      holders = clamp(holders, 0, players);
    }
    const median = clampRate((holders / players) * 100);
    const centre = logitOf(median);
    let prevQ = -Infinity;
    const q = Z.map((z) => {
      const v = round4(invLogitPct(centre + z * spread));
      const kept = Math.max(v, prevQ);
      prevQ = kept;
      return kept;
    });
    return { id: t.id, q };
  });
}

mkdirSync(OUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(IN_DIR).filter((f) => f.endsWith(".in")).sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(IN_DIR, file), "utf8")) as CaseFile;
  const trophies = forecast(c);
  writeFileSync(join(OUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
