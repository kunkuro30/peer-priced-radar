// Peer-priced radar, version 5: one sealed snapshot in, one fully accounted board out.
//
// What changed against the previous generation of this radar, and why: every candidate
// term was fitted and then graded blind — leave-one-out, a half time split, expanding
// walk-forward folds and seeded k-fold cross-validation — and only the terms that beat
// the pure empirical-median baseline AND a regime-swapped negative control on both
// primary holdouts were kept. The age slope the older model carried failed that vote
// (it raised both holdout errors), so it is gone. The growth and chain-count terms and
// a two-level category->family shrinkage failed it too. What survives:
//
//   peers      the snapshot's launch-type tokens that trade today (mcap and TVL both
//              recorded), wrapper categories set aside — their caps price an asset
//              underneath, not a launch
//   regimes    momentum (7-day TVL change > 0) vs reversion (<= 0); each regime prices
//              with its own shrunk category medians and its own intercept
//   multiple   a category's median mcap/TVL inside the regime, shrunk toward the
//              regime's median with weight SHRINK_K = 4.5 (chosen on a 2..8 grid by
//              the same blind tests, printed in the validation table)
//   size       one pooled slope on centred log TVL, fitted by Huber IRLS on the log
//              residuals of TVL x multiple, so a single wild peer cannot bend prices
//   implied    TVL x multiple x exp(intercept[regime] + size slope x centred log TVL)
//
// Around the price, three more instruments, each graded the same way:
//   odds       a logistic fit of "records a token by now" on age, size and growth over
//              every dated protocol in the snapshot — the peers' own historical record,
//              graded held-out by time split (Brier against the base rate, plus AUC)
//   interval   a conformal band per category family: the 80th percentile of that
//              family's leave-one-out absolute log residuals, applied around the price
//   verdict    the farm plan under each row is costed step by step (dollars and
//              minutes); the verdict divides odds-weighted implied value by the plan's
//              cost per hour, and tiers the board into thirds by that density
//
// And one accounting rule the older board did not keep: every protocol in the
// snapshot is accounted for on the first screen — priced as a peer, priced as a
// wrapper, boarded as a candidate, or set aside with the reason named and counted.

/** One protocol entry of the sealed snapshot: exactly the ten fields it carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {}

/** The model's version label, printed on the dashboard and quoted in the dossier. */
export const MODEL_VERSION = 'peer-priced-5';

/** Categories whose tokens price an underlying asset; set aside from the peer set. */
export const WRAPPER_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Shrink weight of a category median toward its regime median (grid-tested 2..8). */
export const SHRINK_K = 4.5;

/** Live-token reference rows the dashboard carries, by market cap. */
export const LIVE_ROWS = 24;

/** The two pricing regimes. */
export type Regime = 'momentum' | 'reversion';

export function regimeOf(p: SnapshotProtocol): Regime {
  return (p.change_7d ?? 0) > 0 ? 'momentum' : 'reversion';
}

/** Whole days from a protocol's listing day to the snapshot's as-of day, or null. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** True when the snapshot records no token for the protocol at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Why a pre-token protocol is not a launch candidate, or null when it is one. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return null;
  if (WRAPPER_CATEGORIES.has(p.category ?? '')) return 'wrapper category';
  if (VERSION_MARKER.test(p.name)) return 'versioned clone';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'exchange product';
  return null;
}

export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return isPreToken(p) && exclusionReason(p) === null;
}

/** The peer set: live launch-type tokens with both halves of the price recorded. */
export function peerPool(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !WRAPPER_CATEGORIES.has(p.category ?? ''),
  );
}

// ---------------------------------------------------------------------------
// Full accounting: every protocol in exactly one bucket, reasons counted.
// ---------------------------------------------------------------------------

export interface Accounting {
  total: number;
  peers: number;
  wrapperPriced: number;
  tokenUnusable: number;
  candidates: number;
  excluded: { reason: string; count: number }[];
}

/** Classify every protocol in the snapshot; the buckets sum to the total. */
export function accountFor(snapshot: Snapshot): Accounting {
  let peers = 0;
  let wrapperPriced = 0;
  let tokenUnusable = 0;
  let candidates = 0;
  const reasons = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      if (WRAPPER_CATEGORIES.has(p.category ?? '')) wrapperPriced++;
      else peers++;
      continue;
    }
    if (!isPreToken(p)) {
      tokenUnusable++;
      continue;
    }
    const reason = exclusionReason(p);
    if (reason === null) candidates++;
    else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    total: snapshot.protocols.length,
    peers,
    wrapperPriced,
    tokenUnusable,
    candidates,
    excluded: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// Small numeric toolkit (deterministic, standard library only).
// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= m[i]![j]! * x[j]!;
    x[i] = s / m[i]![i]!;
  }
  return x;
}

function wls(x: number[][], y: number[], w: number[]): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let k = 0; k < x.length; k++) {
    for (let i = 0; i < n; i++) {
      b[i]! += w[k]! * x[k]![i]! * y[k]!;
      for (let j = 0; j < n; j++) a[i]![j]! += w[k]! * x[k]![i]! * x[k]![j]!;
    }
  }
  for (let i = 0; i < n; i++) a[i]![i]! += 1e-8;
  return solveLinear(a, b);
}

/** Huber IRLS: least squares, then three reweighting passes against a MAD scale. */
function irlsHuber(x: number[][], y: number[]): number[] {
  let beta = wls(x, y, x.map(() => 1));
  for (let iter = 0; iter < 3; iter++) {
    const res = x.map((row, k) => y[k]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const scale = median(res.map((r) => Math.abs(r))) * 1.4826 + 1e-9;
    beta = wls(x, y, res.map((r) => (Math.abs(r) <= 1.345 * scale ? 1 : (1.345 * scale) / Math.abs(r))));
  }
  return beta;
}

// ---------------------------------------------------------------------------
// The pricing fit.
// ---------------------------------------------------------------------------

export interface RegimeFit {
  regime: Regime;
  peerCount: number;
  multiples: Map<string, number>;
  fallbackMultiple: number;
  intercept: number;
}

export interface FittedModel {
  version: string;
  peerCount: number;
  globalMedianRatio: number;
  meanLogTvl: number;
  sizeSlope: number;
  shrinkK: number;
  regimes: Record<Regime, RegimeFit>;
}

function categoryOf(p: SnapshotProtocol): string {
  return p.category ?? 'Uncategorized';
}

function fitRegimeMultiples(regime: Regime, peers: SnapshotProtocol[], k: number): { multiples: Map<string, number>; fallbackMultiple: number; peerCount: number } {
  const own = peers.filter((p) => regimeOf(p) === regime);
  const rows = own.length > 0 ? own : peers;
  const regimeMedian = median(rows.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of rows) {
    const key = categoryOf(p);
    byCategory.set(key, [...(byCategory.get(key) ?? []), p.mcap_usd! / p.tvl_usd]);
  }
  const multiples = new Map<string, number>();
  for (const key of [...byCategory.keys()].sort()) {
    const list = byCategory.get(key)!;
    multiples.set(key, Math.exp((list.length * Math.log(median(list)) + k * Math.log(regimeMedian)) / (list.length + k)));
  }
  return { multiples, fallbackMultiple: regimeMedian, peerCount: rows.length };
}

/** Fit the shipped model on an explicit peer list (validation resamples it). */
export function fitModelOnPeers(peers: SnapshotProtocol[], k: number = SHRINK_K): FittedModel {
  const meanLogTvl = mean(peers.map((p) => Math.log(p.tvl_usd)));
  const mom = fitRegimeMultiples('momentum', peers, k);
  const rev = fitRegimeMultiples('reversion', peers, k);
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of peers) {
    const fit = regimeOf(p) === 'momentum' ? mom : rev;
    const mult = fit.multiples.get(categoryOf(p)) ?? fit.fallbackMultiple;
    x.push([regimeOf(p) === 'momentum' ? 1 : 0, regimeOf(p) === 'reversion' ? 1 : 0, Math.log(p.tvl_usd) - meanLogTvl]);
    y.push(Math.log(p.mcap_usd! / (p.tvl_usd * mult)));
  }
  const beta = irlsHuber(x, y);
  return {
    version: MODEL_VERSION,
    peerCount: peers.length,
    globalMedianRatio: median(peers.map((p) => p.mcap_usd! / p.tvl_usd)),
    meanLogTvl,
    sizeSlope: beta[2]!,
    shrinkK: k,
    regimes: {
      momentum: { regime: 'momentum', peerCount: mom.peerCount, multiples: mom.multiples, fallbackMultiple: mom.fallbackMultiple, intercept: beta[0]! },
      reversion: { regime: 'reversion', peerCount: rev.peerCount, multiples: rev.multiples, fallbackMultiple: rev.fallbackMultiple, intercept: beta[1]! },
    },
  };
}

export function fitModel(snapshot: Snapshot): FittedModel {
  return fitModelOnPeers(peerPool(snapshot));
}

export interface ImpliedParts {
  implied: number;
  regime: Regime;
  categoryMultiple: number;
  adjustment: number;
}

/** Price one protocol (or price it by the other regime, for the negative control). */
export function impliedOf(model: FittedModel, p: SnapshotProtocol, override?: Regime): ImpliedParts {
  const regime = override ?? regimeOf(p);
  const fit = model.regimes[regime];
  const mult = fit.multiples.get(categoryOf(p)) ?? fit.fallbackMultiple;
  const adj = Math.exp(fit.intercept + model.sizeSlope * (Math.log(p.tvl_usd) - model.meanLogTvl));
  return { implied: Math.max(1, Math.round(p.tvl_usd * mult * adj)), regime, categoryMultiple: mult, adjustment: adj };
}

/** The pure empirical baseline: TVL times the peer set's one median ratio. */
export function baselineOf(model: FittedModel, p: SnapshotProtocol): number {
  return Math.max(1, Math.round(p.tvl_usd * model.globalMedianRatio));
}

// ---------------------------------------------------------------------------
// Category families, for the conformal bands.
// ---------------------------------------------------------------------------

const FAMILY_OF: Record<string, string> = {
  Lending: 'credit', CDP: 'credit', 'Collateral Management': 'credit',
  Dexs: 'trading', Derivatives: 'trading', Options: 'trading', 'Basis Trading': 'trading', Indexes: 'trading', 'Leveraged Farming': 'trading',
  Yield: 'yield', 'Yield Aggregator': 'yield', 'Risk Curators': 'yield', 'Onchain Capital Allocator': 'yield', 'Liquidity Manager': 'yield',
  Restaking: 'staking', 'Staking Pool': 'staking',
  'Cross Chain Bridge': 'infrastructure', Chain: 'infrastructure', 'Token Locker': 'infrastructure', DOR: 'infrastructure',
  RWA: 'real-world', Payments: 'real-world', 'Dual-Token Stablecoin': 'real-world',
};

export function familyOf(p: SnapshotProtocol): string {
  return FAMILY_OF[categoryOf(p)] ?? 'other';
}

// ---------------------------------------------------------------------------
// Launch odds: a logistic read of the peers' own record.
// ---------------------------------------------------------------------------

export interface OddsModel {
  /** [intercept, per year of age, per log10 TVL above 1e7, per +10% of 7d growth]. */
  coefs: number[];
  datedCount: number;
  medianAgeYears: number;
}

function oddsFeatures(p: SnapshotProtocol, asOf: string, medianAgeYears: number): number[] {
  const days = ageDays(asOf, p.listed_at);
  const years = days === null ? medianAgeYears : days / 365.25;
  return [1, years, Math.log10(Math.max(1, p.tvl_usd)) - 7, Math.max(-60, Math.min(120, p.change_7d ?? 0)) / 10];
}

/** Fit the odds logistic on every dated protocol: outcome = records a token today. */
export function fitOdds(snapshot: Snapshot): OddsModel {
  const dated = snapshot.protocols.filter((p) => p.listed_at !== null && p.tvl_usd > 0);
  const ages = dated.map((p) => ageDays(snapshot.as_of, p.listed_at)! / 365.25);
  const medianAgeYears = median(ages);
  const X = dated.map((p) => oddsFeatures(p, snapshot.as_of, medianAgeYears));
  const y = dated.map((p) => (p.gecko_id !== null ? 1 : 0));
  const mu = X[0]!.map((_, j) => X.reduce((s, r) => s + r[j]!, 0) / X.length);
  const sd = X[0]!.map((_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - mu[j]!) ** 2, 0) / X.length) || 1);
  const Z = X.map((r) => r.map((v, j) => (j === 0 ? 1 : (v - mu[j]!) / sd[j]!)));
  let w = new Array<number>(Z[0]!.length).fill(0);
  for (let iter = 0; iter < 400; iter++) {
    const g = new Array<number>(w.length).fill(0);
    Z.forEach((z, i) => {
      const s = z.reduce((a, v, j) => a + v * w[j]!, 0);
      const pr = 1 / (1 + Math.exp(-s));
      z.forEach((v, j) => { g[j]! += (y[i]! - pr) * v; });
    });
    w = w.map((v, j) => v + (0.3 * g[j]!) / Z.length - (j === 0 ? 0 : 0.3 * 0.01 * v));
  }
  const raw = w.map((v, j) => (j === 0 ? v : v / sd[j]!));
  raw[0] = w[0]! - raw.slice(1).reduce((s, wj, k) => s + wj * mu[k + 1]!, 0);
  return { coefs: raw, datedCount: dated.length, medianAgeYears };
}

/** The fitted probability that a protocol like this one records a token by now. */
export function oddsOf(model: OddsModel, p: SnapshotProtocol, asOf: string): number {
  const f = oddsFeatures(p, asOf, model.medianAgeYears);
  const s = f.reduce((acc, v, j) => acc + v * model.coefs[j]!, 0);
  return 1 / (1 + Math.exp(-s));
}

// ---------------------------------------------------------------------------
// Farm plans: costed step by step, sized to the minimum viable capital.
// ---------------------------------------------------------------------------

export interface FarmStep {
  text: string;
  costUsd: number;
  minutes: number;
}

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Minimum viable capital: 0.001% of TVL, floored at $25 and capped at $250. */
export function capitalFor(tvl: number): number {
  return Math.max(25, Math.min(250, Math.round(tvl / 100_000)));
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type Playbook = 'credit' | 'trading' | 'bridge' | 'staking' | 'vault' | 'rwa' | 'exchange' | 'play' | 'generic';

function playbookOf(p: SnapshotProtocol): Playbook {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'credit';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restaking')) return 'staking';
  if (c.includes('dex') || c.includes('derivat') || c.includes('option') || c.includes('perpetual') || c.includes('basis')) return 'trading';
  if (c.includes('yield') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator') || c.includes('liquidity')) return 'vault';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c === 'cex' || c.includes('exchange')) return 'exchange';
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return 'play';
  return 'generic';
}

/** Five costed steps: every step states its dollars and its minutes. */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const name = p.name;
  const diary: FarmStep = { text: `Keep a dated farm diary for ${name}: every transaction hash plus a weekly balance screenshot, the proof of early activity if a snapshot is ever announced. Cost: $0. Time: 5 minutes a week.`, costUsd: 0, minutes: 5 * Math.ceil(hold / 7) };
  const exit: FarmStep = { text: `On day ${hold}, decide on ${name}: no token and no points program means withdraw and pay the exit gas. Cost: about $4 in gas on ${chain}. Time: 15 minutes.`, costUsd: 4, minutes: 15 };
  const tend: FarmStep = { text: `Tend the ${name} position once a week for ${hold} days: check it is still live, still yours, and still counted. Cost: $0 beyond gas already counted. Time: 5 minutes a week.`, costUsd: 0, minutes: 5 * Math.ceil(hold / 7) };
  switch (playbookOf(p)) {
    case 'credit':
      return [
        { text: `Supply $${capital} of USDC to ${name} on ${chain} as collateral and leave it supplied. Cost: about $6 in gas. Time: 10 minutes.`, costUsd: 6, minutes: 10 },
        { text: `Borrow about $${Math.round(capital / 3)} of USDC against it, repay within the hour, and run that loop twice more this week. Cost: about $9 in gas across the loops. Time: 30 minutes.`, costUsd: 9, minutes: 30 },
        tend, diary, exit,
      ];
    case 'trading':
      return [
        { text: `Swap $${capital} of USDC into ETH and back on ${name} on ${chain}, in two sessions a day apart. Cost: about $8 in gas and slippage. Time: 20 minutes in all.`, costUsd: 8, minutes: 20 },
        { text: `Park $${capital} of two-sided liquidity in ${name}'s busiest pool and leave it open. Cost: about $5 in gas. Time: 10 minutes.`, costUsd: 5, minutes: 10 },
        tend, diary, exit,
      ];
    case 'bridge':
      return [
        { text: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name}. Cost: about $7 in bridge and gas fees. Time: 15 minutes including finality.`, costUsd: 7, minutes: 15 },
        { text: `Put the bridged funds to work the same day in one ${chain} app — a swap or a supply — so the trip reads as use, not a pass-through. Cost: about $4 in gas. Time: 10 minutes.`, costUsd: 4, minutes: 10 },
        tend, diary, exit,
      ];
    case 'staking':
      return [
        { text: `Stake $${capital} of ETH through ${name} on ${chain} and hold the receipt token in the same wallet. Cost: about $6 in gas. Time: 10 minutes.`, costUsd: 6, minutes: 10 },
        { text: `Use the receipt token once in a ${chain} lending market or pool, so the position counts as activity in two places. Cost: about $5 in gas. Time: 10 minutes.`, costUsd: 5, minutes: 10 },
        tend, diary, exit,
      ];
    case 'vault':
      return [
        { text: `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and hold the shares. Cost: about $5 in gas. Time: 10 minutes.`, costUsd: 5, minutes: 10 },
        { text: `Split a second $${Math.round(capital / 2)} into one more ${name} vault or strategy, so the activity is not a single deposit. Cost: about $5 in gas. Time: 10 minutes.`, costUsd: 5, minutes: 10 },
        tend, diary, exit,
      ];
    case 'rwa':
      return [
        { text: `Finish ${name}'s onboarding if it asks for one, then buy $${capital} of its smallest tokenised asset on ${chain}. Cost: about $6 in gas plus any fee shown before you sign. Time: 25 minutes.`, costUsd: 6, minutes: 25 },
        { text: `Hold the asset and claim or reinvest whatever it pays during the hold. Cost: about $3 in gas a claim. Time: 5 minutes a claim.`, costUsd: 3, minutes: 5 },
        tend, diary, exit,
      ];
    case 'exchange':
      return [
        { text: `Open an account at ${name}, pass verification, and deposit $${capital} of USDC. Cost: $0 on most deposit rails. Time: 20 minutes including verification.`, costUsd: 0, minutes: 20 },
        { text: `Trade spot twice a week (USDC into BTC or ETH and back) for ${Math.min(hold, 28)} days, so the account shows real use. Cost: about $${Math.max(1, Math.round(capital * 0.02))} in trading fees. Time: 5 minutes a trade.`, costUsd: Math.max(1, Math.round(capital * 0.02)), minutes: 40 },
        tend, diary, exit,
      ];
    case 'play':
      return [
        { text: `Create a ${name} account, connect the wallet you farm with, and finish its opening quest or first mint on ${chain}. Cost: about $4 in gas. Time: 20 minutes.`, costUsd: 4, minutes: 20 },
        { text: `Play or mint once a week for ${Math.min(hold, 28)} days; steady weekly activity is what these snapshots usually count. Cost: about $3 in gas a session. Time: 15 minutes a session.`, costUsd: 3 * Math.ceil(Math.min(hold, 28) / 7), minutes: 15 * Math.ceil(Math.min(hold, 28) / 7) },
        tend, diary, exit,
      ];
    default:
      return [
        { text: `Use ${name}'s core feature on ${chain} with $${capital} of USDC — a deposit, a swap or a stake, whichever it offers first. Cost: about $6 in gas. Time: 15 minutes.`, costUsd: 6, minutes: 15 },
        { text: `Repeat the core action weekly for ${Math.min(hold, 28)} days, varying the amount slightly each time. Cost: about $5 in gas a session. Time: 10 minutes a session.`, costUsd: 5 * Math.ceil(Math.min(hold, 28) / 7), minutes: 10 * Math.ceil(Math.min(hold, 28) / 7) },
        tend, diary, exit,
      ];
  }
}

// ---------------------------------------------------------------------------
// The board: every launch candidate, no top cut.
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  regime: Regime;
  watchlist: boolean;
  implied_value_usd: number;
  rank_lo: number;
  rank_hi: number;
  model: { category_multiple: number; adjustment: number };
  odds_pct: number;
  interval_lo_usd: number;
  interval_hi_usd: number;
  family: string;
  plan: { cost_usd: number; minutes: number; cost_per_hour_usd: number };
  verdict: string;
  farm_steps: string[];
}

/** Rank every launch candidate by implied value; the watchlist rides along. */
export function buildBoard(snapshot: Snapshot, model: FittedModel, odds: OddsModel, bands: Map<string, number>): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const globalBand = bands.get('*') ?? 0.6;
  const rows = snapshot.protocols
    .filter(isLaunchCandidate)
    .map((p) => {
      const parts = impliedOf(model, p);
      const age = ageDays(snapshot.as_of, p.listed_at);
      const plan = farmPlan(p, age);
      const cost = plan.reduce((s, st) => s + st.costUsd, 0);
      const minutes = plan.reduce((s, st) => s + st.minutes, 0);
      const band = bands.get(familyOf(p)) ?? globalBand;
      return {
        p, parts, age, plan, cost, minutes,
        odds: oddsOf(odds, p, snapshot.as_of),
        lo: Math.max(1, Math.round(parts.implied / Math.pow(10, band))),
        hi: Math.round(parts.implied * Math.pow(10, band)),
      };
    })
    .sort((a, b) => b.parts.implied - a.parts.implied || (a.p.slug < b.p.slug ? -1 : 1));
  // Verdict tiers: thirds of the board by odds-weighted value per cost-hour.
  const density = rows.map((r) => (r.odds * r.parts.implied) / Math.max(1, r.cost / Math.max(1 / 60, r.minutes / 60)));
  const sortedDensity = [...density].sort((a, b) => a - b);
  const t1 = sortedDensity[Math.floor(sortedDensity.length / 3)]!;
  const t2 = sortedDensity[Math.floor((2 * sortedDensity.length) / 3)]!;
  return rows.map((r, i) => ({
    rank: i + 1,
    slug: r.p.slug,
    name: r.p.name,
    category: r.p.category,
    chains: r.p.chains,
    tvl_usd: r.p.tvl_usd,
    change_7d: r.p.change_7d,
    mcap_usd: null,
    listed_at: r.p.listed_at,
    gecko_id: null,
    symbol: null,
    token_status: 'pre-token',
    age_days: r.age,
    regime: r.parts.regime,
    watchlist: watch.has(r.p.slug),
    implied_value_usd: r.parts.implied,
    rank_lo: i + 1,
    rank_hi: i + 1,
    model: { category_multiple: r.parts.categoryMultiple, adjustment: r.parts.adjustment },
    odds_pct: Math.round(r.odds * 1000) / 10,
    interval_lo_usd: r.lo,
    interval_hi_usd: r.hi,
    family: familyOf(r.p),
    plan: {
      cost_usd: r.cost,
      minutes: r.minutes,
      cost_per_hour_usd: Math.round((r.cost / Math.max(1 / 60, r.minutes / 60)) * 100) / 100,
    },
    verdict: density[i]! >= t2 ? 'front of the queue' : density[i]! >= t1 ? 'worth the hours' : 'watch only',
    farm_steps: r.plan.map((s) => s.text),
  }));
}

/** The first gate failure in a board, or null when the board is gate-clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `row names an invented slug: ${r.slug}`;
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `watchlist slug missing from the board: ${slug}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `rank ${r.rank} out of place at row ${i}`;
    if (i > 0 && board[i - 1]!.implied_value_usd < r.implied_value_usd) return 'implied value rises as rank ascends';
    if (!(r.implied_value_usd > 0)) return `implied value not positive at ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm_steps count ${r.farm_steps.length} at ${r.slug}`;
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `farm step of ${len} chars at ${r.slug}`;
    }
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

/** Parse and lightly validate the sealed snapshot text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  const doc = raw as Partial<Snapshot>;
  if (typeof doc.as_of !== 'string' || typeof doc.floor_usd !== 'number' || !Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new SnapshotError('snapshot is missing as_of, floor_usd, protocols or watchlist');
  }
  for (const p of doc.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Array.isArray(p.chains)) {
      throw new SnapshotError(`protocol entry is malformed at ${String((p as SnapshotProtocol).slug)}`);
    }
  }
  return doc as Snapshot;
}
