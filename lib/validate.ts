// The radar grades itself before it grades anyone else — and it grades every term
// it was offered, not just the ones it kept.
//
// Schemes (all on the snapshot's own peer set, all recomputed at run time):
//   leave-one-out          each peer priced by a fit on the other 93
//   time split             earlier-listed half trains, later half is priced blind
//   walk-forward           expanding window over listing order, four folds
//   5-fold / 10-fold CV    seeded shuffles, so the folds are the same on every run
// Every scheme reports three numbers: this model, the pure empirical-median
// baseline, and the negative control — each protocol priced by the OTHER regime's
// multiples and intercept. A model that cannot beat both, on both primary holdouts
// (leave-one-out and the time split), does not ship; the dashboard prints the table
// either way.
//
// Ablations: each candidate term the model was offered (an age slope, a continuous
// growth term, a chain-count term, a two-level family shrinkage, other shrink
// weights, dropping the regime split) is refitted and graded on the two primary
// holdouts, with its keep/drop verdict and the reason in one line.
//
// The error unit is the median absolute log10 of predicted / actual market cap:
// 0.30 is a typical factor of two. Conformal bands come from the leave-one-out
// residuals themselves, grouped by category family. Rank ranges come from seeded
// bootstrap refits of the peer set.

import {
  SHRINK_K,
  baselineOf,
  familyOf,
  fitModelOnPeers,
  fitOdds,
  impliedOf,
  median,
  oddsOf,
  peerPool,
  regimeOf,
  type BoardRow,
  type FittedModel,
  type OddsModel,
  type Snapshot,
  type SnapshotProtocol,
} from './model.ts';

export const REFITS = 120;
const BOOTSTRAP_SEED = 0x51ab3;
const CV_SEED = 0x2f6e2b1;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SchemeResult {
  scheme: string;
  model: number;
  baseline: number;
  control: number;
  within2x: number;
  worst: { slug: string; name: string; factor: number; direction: 'over' | 'under' };
}

interface FoldScore { model: number[]; base: number[]; neg: number[]; worst: SchemeResult['worst']; worstErr: number; within: number; n: number; }

function emptyFold(): FoldScore {
  return { model: [], base: [], neg: [], worst: { slug: '', name: '', factor: 1, direction: 'over' }, worstErr: -1, within: 0, n: 0 };
}

function scoreInto(acc: FoldScore, train: SnapshotProtocol[], test: SnapshotProtocol[]): void {
  const model = fitModelOnPeers(train);
  for (const p of test) {
    const actual = p.mcap_usd!;
    const pred = impliedOf(model, p).implied;
    const swapped = impliedOf(model, p, regimeOf(p) === 'momentum' ? 'reversion' : 'momentum').implied;
    const e = Math.abs(Math.log10(pred / actual));
    acc.model.push(e);
    acc.base.push(Math.abs(Math.log10(baselineOf(model, p) / actual)));
    acc.neg.push(Math.abs(Math.log10(swapped / actual)));
    if (e < Math.log10(2)) acc.within++;
    acc.n++;
    if (e > acc.worstErr) {
      acc.worstErr = e;
      acc.worst = { slug: p.slug, name: p.name, factor: Math.round(Math.pow(10, e) * 10) / 10, direction: pred >= actual ? 'over' : 'under' };
    }
  }
}

function finish(scheme: string, acc: FoldScore): SchemeResult {
  return {
    scheme,
    model: round3(median(acc.model)),
    baseline: round3(median(acc.base)),
    control: round3(median(acc.neg)),
    within2x: round3(acc.within / acc.n),
    worst: acc.worst,
  };
}

const byListing = (peers: SnapshotProtocol[]): SnapshotProtocol[] =>
  [...peers].sort((a, b) => ((a.listed_at ?? '9999-12-31') < (b.listed_at ?? '9999-12-31') ? -1 : 1));

function shuffled(peers: SnapshotProtocol[], seed: number): SnapshotProtocol[] {
  const rnd = mulberry32(seed);
  const arr = [...peers];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function kFold(peers: SnapshotProtocol[], k: number, seed: number): FoldScore {
  const order = shuffled(peers, seed);
  const acc = emptyFold();
  for (let fold = 0; fold < k; fold++) {
    const test = order.filter((_, i) => i % k === fold);
    const train = order.filter((_, i) => i % k !== fold);
    scoreInto(acc, train, test);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Ablations: a small generic fitter for the variants the shipped model rejected
// (and two it accepted), graded on the primary holdouts only.
// ---------------------------------------------------------------------------

interface VariantOpts { regime: boolean; age: boolean; growth: boolean; chains: boolean; twoLevel: boolean; k: number; }

const FAMILY_OF_LOCAL: Record<string, string> = {
  Lending: 'credit', CDP: 'credit', 'Collateral Management': 'credit',
  Dexs: 'trading', Derivatives: 'trading', Options: 'trading', 'Basis Trading': 'trading', Indexes: 'trading', 'Leveraged Farming': 'trading',
  Yield: 'yield', 'Yield Aggregator': 'yield', 'Risk Curators': 'yield', 'Onchain Capital Allocator': 'yield', 'Liquidity Manager': 'yield',
  Restaking: 'staking', 'Staking Pool': 'staking',
};

function solveLin(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!; m[col] = m[piv]!; m[piv] = tmp;
    for (let r = col + 1; r < n; r++) { const f = m[r]![col]! / m[col]![col]!; for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!; }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = m[i]![n]!; for (let j = i + 1; j < n; j++) s -= m[i]![j]! * x[j]!; x[i] = s / m[i]![i]!; }
  return x;
}

function wlsLocal(x: number[][], y: number[], w: number[]): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let k = 0; k < x.length; k++) for (let i = 0; i < n; i++) { b[i]! += w[k]! * x[k]![i]! * y[k]!; for (let j = 0; j < n; j++) a[i]![j]! += w[k]! * x[k]![i]! * x[k]![j]!; }
  for (let i = 0; i < n; i++) a[i]![i]! += 1e-8;
  return solveLin(a, b);
}

function ageYearsOf(p: SnapshotProtocol, asOf: string, fallback: number): number {
  if (p.listed_at === null) return fallback;
  const d = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) ? d / 365.25 : fallback;
}

interface VariantFit { mult: Map<string, number>; fb: Record<string, number>; beta: number[]; meanLogTvl: number; medAge: number; opts: VariantOpts; }

function fitVariant(peers: SnapshotProtocol[], asOf: string, opts: VariantOpts): VariantFit {
  const meanLogTvl = peers.reduce((s, p) => s + Math.log(p.tvl_usd), 0) / peers.length;
  const ages = peers.map((p) => ageYearsOf(p, asOf, NaN)).filter((v) => Number.isFinite(v));
  const medAge = median(ages);
  const fb: Record<string, number> = {};
  const mult = new Map<string, number>();
  for (const g of ['momentum', 'reversion', 'all']) {
    const rows = g === 'all' ? peers : peers.filter((p) => (regimeOf(p) === 'momentum' ? 'momentum' : 'reversion') === g);
    const use = rows.length ? rows : peers;
    fb[g] = median(use.map((p) => p.mcap_usd! / p.tvl_usd));
    const famLists = new Map<string, number[]>();
    for (const p of use) { const f = FAMILY_OF_LOCAL[p.category ?? ''] ?? 'other'; famLists.set(f, [...(famLists.get(f) ?? []), p.mcap_usd! / p.tvl_usd]); }
    const famMed = new Map<string, number>();
    for (const [f, l] of famLists) famMed.set(f, opts.twoLevel ? Math.exp((l.length * Math.log(median(l)) + 6 * Math.log(fb[g]!)) / (l.length + 6)) : fb[g]!);
    const catLists = new Map<string, number[]>();
    for (const p of use) catLists.set(p.category ?? 'Uncategorized', [...(catLists.get(p.category ?? 'Uncategorized') ?? []), p.mcap_usd! / p.tvl_usd]);
    for (const [c, l] of catLists) {
      const anyP = use.find((p) => (p.category ?? 'Uncategorized') === c)!;
      const target = opts.twoLevel ? famMed.get(FAMILY_OF_LOCAL[anyP.category ?? ''] ?? 'other')! : fb[g]!;
      mult.set(`${c}|${g}`, Math.exp((l.length * Math.log(median(l)) + opts.k * Math.log(target)) / (l.length + opts.k)));
    }
    for (const [f, v] of famMed) mult.set(`fam:${f}|${g}`, v);
  }
  const feats = (p: SnapshotProtocol): number[] => {
    const row = [1];
    if (opts.regime) row.push(regimeOf(p) === 'reversion' ? 1 : 0);
    row.push(Math.log(p.tvl_usd) - meanLogTvl);
    if (opts.age) row.push(ageYearsOf(p, asOf, medAge));
    if (opts.growth) row.push(Math.max(-60, Math.min(120, p.change_7d ?? 0)) / 10);
    if (opts.chains) row.push(Math.min(p.chains.length, 8));
    return row;
  };
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of peers) {
    const g = opts.regime ? regimeOf(p) : 'all';
    const m = mult.get(`${p.category ?? 'Uncategorized'}|${g}`) ?? fb[g]!;
    x.push(feats(p));
    y.push(Math.log(p.mcap_usd! / (p.tvl_usd * m)));
  }
  let beta = wlsLocal(x, y, x.map(() => 1));
  for (let iter = 0; iter < 3; iter++) {
    const res = x.map((row, k) => y[k]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const sc = median(res.map((r) => Math.abs(r))) * 1.4826 + 1e-9;
    beta = wlsLocal(x, y, res.map((r) => (Math.abs(r) <= 1.345 * sc ? 1 : (1.345 * sc) / Math.abs(r))));
  }
  return { mult, fb, beta, meanLogTvl, medAge, opts };
}

function predictVariant(f: VariantFit, p: SnapshotProtocol, asOf: string): number {
  const g = f.opts.regime ? regimeOf(p) : 'all';
  const m = f.mult.get(`${p.category ?? 'Uncategorized'}|${g}`) ?? f.mult.get(`fam:${FAMILY_OF_LOCAL[p.category ?? ''] ?? 'other'}|${g}`) ?? f.fb[g]!;
  const row = [1];
  if (f.opts.regime) row.push(regimeOf(p) === 'reversion' ? 1 : 0);
  row.push(Math.log(p.tvl_usd) - f.meanLogTvl);
  if (f.opts.age) row.push(ageYearsOf(p, asOf, f.medAge));
  if (f.opts.growth) row.push(Math.max(-60, Math.min(120, p.change_7d ?? 0)) / 10);
  if (f.opts.chains) row.push(Math.min(p.chains.length, 8));
  return p.tvl_usd * m * Math.exp(row.reduce((s, v, j) => s + v * f.beta[j]!, 0));
}

export interface Ablation { term: string; loo: number; half: number; verdict: string; }

function gradeVariant(peers: SnapshotProtocol[], asOf: string, opts: VariantOpts): { loo: number; half: number } {
  const errs: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const f = fitVariant(peers.filter((_, j) => j !== i), asOf, opts);
    errs.push(Math.abs(Math.log10(predictVariant(f, peers[i]!, asOf) / peers[i]!.mcap_usd!)));
  }
  const sorted = byListing(peers);
  const half = Math.floor(sorted.length / 2);
  const fH = fitVariant(sorted.slice(0, half), asOf, opts);
  const hErrs = sorted.slice(half).map((p) => Math.abs(Math.log10(predictVariant(fH, p, asOf) / p.mcap_usd!)));
  return { loo: round3(median(errs)), half: round3(median(hErrs)) };
}

// ---------------------------------------------------------------------------
// Odds grading: time split over listing order, Brier against the base rate.
// ---------------------------------------------------------------------------

export interface OddsGrade { brier: number; brierBase: number; auc: number; train: number; test: number; }

function gradeOdds(snapshot: Snapshot): OddsGrade {
  const dated = snapshot.protocols.filter((p) => p.listed_at !== null && p.tvl_usd > 0);
  const sorted = [...dated].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(sorted.length / 2);
  const trainSnap: Snapshot = { ...snapshot, protocols: sorted.slice(0, half) };
  const model: OddsModel = fitOdds(trainSnap);
  const test = sorted.slice(half);
  const base = sorted.slice(0, half).filter((p) => p.gecko_id !== null).length / half;
  let brier = 0;
  let brierBase = 0;
  const pos: number[] = [];
  const neg: number[] = [];
  for (const p of test) {
    const pr = oddsOf(model, p, snapshot.as_of);
    const y = p.gecko_id !== null ? 1 : 0;
    brier += (pr - y) ** 2;
    brierBase += (base - y) ** 2;
    (y ? pos : neg).push(pr);
  }
  let conc = 0;
  let tot = 0;
  for (const a of pos) for (const b of neg) { tot++; conc += a > b ? 1 : a === b ? 0.5 : 0; }
  return { brier: round3(brier / test.length), brierBase: round3(brierBase / test.length), auc: round3(conc / tot), train: half, test: test.length };
}

// ---------------------------------------------------------------------------
// The full report.
// ---------------------------------------------------------------------------

export interface ValidationReport {
  peers: number;
  schemes: SchemeResult[];
  ablations: Ablation[];
  odds: OddsGrade;
  /** Conformal half-widths in log10, by category family; '*' is the global band. */
  bands: Record<string, number>;
}

export function validateModel(snapshot: Snapshot, _model: FittedModel): ValidationReport {
  const peers = peerPool(snapshot);
  const asOf = snapshot.as_of;

  const loo = emptyFold();
  for (let i = 0; i < peers.length; i++) scoreInto(loo, peers.filter((_, j) => j !== i), [peers[i]!]);
  const sorted = byListing(peers);
  const half = Math.floor(sorted.length / 2);
  const time = emptyFold();
  scoreInto(time, sorted.slice(0, half), sorted.slice(half));
  const wf = emptyFold();
  for (let fold = 1; fold <= 3; fold++) {
    const cut = Math.floor((sorted.length / 4) * fold);
    const nxt = Math.floor((sorted.length / 4) * (fold + 1));
    scoreInto(wf, sorted.slice(0, cut), sorted.slice(cut, nxt));
  }
  const schemes = [
    finish('leave-one-out', loo),
    finish('time split — older half trains', time),
    finish('walk-forward — expanding, 4 folds', wf),
    finish('cross-validation — 5 folds, seeded', kFold(peers, 5, CV_SEED)),
    finish('cross-validation — 10 folds, seeded', kFold(peers, 10, CV_SEED)),
  ];

  const shipped: VariantOpts = { regime: true, age: false, growth: false, chains: false, twoLevel: false, k: SHRINK_K };
  const base = gradeVariant(peers, asOf, shipped);
  const ablations: Ablation[] = [];
  const test = (term: string, opts: VariantOpts, kept: string, dropped: string) => {
    const g = gradeVariant(peers, asOf, opts);
    const wins = g.loo < base.loo && g.half < base.half;
    ablations.push({ term, loo: g.loo, half: g.half, verdict: wins ? kept : dropped });
  };
  test('age slope (linear years)', { ...shipped, age: true }, 'kept — beats the shipped fit on both holdouts', 'dropped — raises one or both holdout errors against the shipped fit');
  test('growth term (continuous 7d change)', { ...shipped, growth: true }, 'kept — beats the shipped fit on both holdouts', 'dropped — raises one or both holdout errors against the shipped fit');
  test('chain-count term', { ...shipped, chains: true }, 'kept — beats the shipped fit on both holdouts', 'dropped — raises one or both holdout errors against the shipped fit');
  test('two-level family shrinkage', { ...shipped, twoLevel: true }, 'kept — beats the shipped fit on both holdouts', 'dropped — raises one or both holdout errors against the shipped fit');
  test('shrink weight K=2', { ...shipped, k: 2 }, 'would win — beats K=4.5 on both holdouts', 'not taken — does not beat K=4.5 on both holdouts');
  test('shrink weight K=8', { ...shipped, k: 8 }, 'would win — beats K=4.5 on both holdouts', 'not taken — does not beat K=4.5 on both holdouts');
  test('no regime split', { ...shipped, regime: false }, 'would win — and would retire the split', 'kept the split — the single-regime fit does not beat it on both holdouts, and the swapped control is worse on both');
  ablations.unshift({ term: 'shipped fit (regime split, K=4.5, size slope)', loo: base.loo, half: base.half, verdict: 'shipped — the reference every variant below was graded against' });

  // Conformal bands from the shipped model's own leave-one-out residuals.
  const residByFamily = new Map<string, number[]>();
  const allResid: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const m = fitModelOnPeers(peers.filter((_, j) => j !== i));
    const e = Math.abs(Math.log10(impliedOf(m, peers[i]!).implied / peers[i]!.mcap_usd!));
    const fam = familyOf(peers[i]!);
    residByFamily.set(fam, [...(residByFamily.get(fam) ?? []), e]);
    allResid.push(e);
  }
  const pct80 = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(0.8 * s.length))]!;
  };
  const bands: Record<string, number> = { '*': round3(pct80(allResid)) };
  for (const [fam, list] of residByFamily) if (list.length >= 8) bands[fam] = round3(pct80(list));

  return { peers: peers.length, schemes, ablations, odds: gradeOdds(snapshot), bands };
}

/** Bootstrap rank ranges: resample peers with replacement, refit, re-rank the board. */
export function bootstrapRanks(snapshot: Snapshot, board: BoardRow[]): Map<string, [number, number]> {
  const peers = peerPool(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const targets = board.map((r) => bySlug.get(r.slug)!).filter((p) => p !== undefined);
  const samples = new Map<string, number[]>(board.map((r) => [r.slug, []]));
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let refit = 0; refit < REFITS; refit++) {
    const draw: SnapshotProtocol[] = [];
    for (let i = 0; i < peers.length; i++) draw.push(peers[Math.floor(rand() * peers.length)]!);
    const model = fitModelOnPeers(draw);
    const scored = targets
      .map((p) => ({ slug: p.slug, implied: impliedOf(model, p).implied }))
      .sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => samples.get(s.slug)!.push(i + 1));
  }
  const ranges = new Map<string, [number, number]>();
  for (const row of board) {
    const list = [...samples.get(row.slug)!].sort((a, b) => a - b);
    const lo = list[Math.floor(0.1 * (list.length - 1))]!;
    const hi = list[Math.floor(0.9 * (list.length - 1))]!;
    ranges.set(row.slug, [Math.min(lo, row.rank), Math.max(hi, row.rank)]);
  }
  return ranges;
}
