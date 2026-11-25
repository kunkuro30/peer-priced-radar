// Peer-Priced Radar (token-radar-01 entry, Node 22, standard library only).
//
// Pipeline: read the sealed snapshot, fit the pricing model on its peer set, grade
// that model on five holdout schemes plus a term-by-term ablation table, build the
// board (every launch candidate, each with a conformal interval, a launch-odds read
// and a costed farm verdict), attach bootstrap rank ranges, then write board.json,
// data.js, the dashboard, the screenshots and — last — dossier.json, whose bytes the
// scorer rebuilds and compares.
//
// Determinism is a design rule, not a hope: no clock reads (ages count from the
// snapshot's own as_of), no unseeded randomness (refits and folds use fixed seeds),
// no network. Two runs on the same snapshot write the same bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_ROWS,
  MODEL_VERSION,
  accountFor,
  boardIssue,
  buildBoard,
  fitModel,
  fitOdds,
  parseSnapshot,
  type RegimeFit,
  type Snapshot,
} from './lib/model.ts';
import { bootstrapRanks, validateModel } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`peer-priced radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot: Snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const model = fitModel(snapshot);
const odds = fitOdds(snapshot);
const validation = validateModel(snapshot, model);
const bands = new Map<string, number>(Object.entries(validation.bands));
let board = buildBoard(snapshot, model, odds, bands);
const ranges = bootstrapRanks(snapshot, board);
board = board.map((r) => {
  const range = ranges.get(r.slug);
  return range === undefined ? r : { ...r, rank_lo: range[0], rank_hi: range[1] };
});
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`peer-priced radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

function regimeJson(fit: RegimeFit): Record<string, unknown> {
  return {
    peer_count: fit.peerCount,
    fallback_multiple: fit.fallbackMultiple,
    intercept: fit.intercept,
    multiples: Object.fromEntries([...fit.multiples.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  };
}

const live = snapshot.protocols
  .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
  .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
  .slice(0, LIVE_ROWS)
  .map((p) => ({
    name: p.name,
    symbol: p.symbol,
    category: p.category,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    ratio: p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : null,
  }));

const radar = {
  version: MODEL_VERSION,
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  accounting: accountFor(snapshot),
  counts: {
    protocols: snapshot.protocols.length,
    peers: model.peerCount,
    watchlist: snapshot.watchlist.length,
    board: board.length,
  },
  model: {
    global_median_ratio: model.globalMedianRatio,
    mean_log_tvl: model.meanLogTvl,
    size_slope: model.sizeSlope,
    shrink_k: model.shrinkK,
    regimes: { momentum: regimeJson(model.regimes.momentum), reversion: regimeJson(model.regimes.reversion) },
    odds_coefs: odds.coefs,
    odds_dated: odds.datedCount,
  },
  validation,
  rows: board,
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`peer-priced radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`peer-priced radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const loo = validation.schemes[0]!;
const half = validation.schemes[1]!;
process.stdout.write(
  `peer-priced radar: ${snapshot.protocols.length} protocols accounted for, ${model.peerCount} peers, ${board.length} candidates boarded\n` +
    `peer-priced radar: leave-one-out ${loo.model} vs baseline ${loo.baseline} vs swapped control ${loo.control}; time split ${half.model} vs baseline ${half.baseline} vs control ${half.control}; worst miss ${loo.worst.name} x${loo.worst.factor} ${loo.worst.direction}\n` +
    `peer-priced radar: wrote board.json, data.js, dashboard/, screenshots/ (${shots.length} images) and dossier.json under ${out}\n`,
);
