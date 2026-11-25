// Peer-Priced Radar dashboard: renders window.RADAR (written by main.ts beside this
// file's parent directory as ../data.js in the output tree, dashboard/ is copied next
// to it). No network, no state beyond the row the reader opens.
(function () {
  var R = window.RADAR;
  if (!R) return;
  var $ = function (id) { return document.getElementById(id); };
  var fmt$ = function (v) {
    if (v === null || v === undefined) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var loo = R.validation.schemes[0], half = R.validation.schemes[1];
  var acct = R.accounting;
  $('ver').textContent = '· ' + R.version + ' · snapshot ' + R.as_of;
  $('headline').textContent = 'All ' + acct.total + ' protocols accounted for. LOO ' + loo.model + ', time-split ' + half.model + ' — against ' + loo.baseline + ' / ' + half.baseline + ' for a flat median, and the age slope the old model trusted is gone: both holdouts voted it out.';
  $('subline').textContent = 'A launch radar that prices pre-token protocols from the snapshot\u2019s own trading peers — two regimes, shrunk category medians, one pooled size slope — and shows its grades, its rejected terms, its conformal bands and its worst miss before it shows a single price. Source: ' + R.source + '.';

  var kpis = [
    [acct.total, 'protocols in the snapshot — every one accounted for below', 'hot'],
    [R.counts.peers, 'trading peers the model learned from', ''],
    [R.counts.board, 'launch candidates boarded — no top cut', 'hot'],
    [loo.model, 'leave-one-out error (baseline ' + loo.baseline + ', control ' + loo.control + ')', 'good'],
    [half.model, 'time-split error (baseline ' + half.baseline + ', control ' + half.control + ')', 'good'],
    ['x' + loo.worst.factor, 'worst single miss: ' + loo.worst.name + ', priced ' + loo.worst.direction + ' — named, not smoothed', 'bad'],
    [Math.round(loo.within2x * 100) + '%', 'of peers priced within a factor of two (LOO)', ''],
    [R.validation.odds.brier + ' / ' + R.validation.odds.brierBase, 'launch-odds Brier vs base rate, held out (AUC ' + R.validation.odds.auc + ')', '']
  ];
  $('kpi').innerHTML = kpis.map(function (k) {
    return '<div class="kpi ' + k[2] + '"><div class="n ' + (k[2] === 'good' ? 'good' : k[2] === 'bad' ? 'bad' : '') + '">' + esc(k[0]) + '</div><div class="l">' + esc(k[1]) + '</div></div>';
  }).join('');

  var sh = '<tr><th>Holdout scheme</th><th>This model</th><th>Flat-median baseline</th><th>Regime-swapped control</th><th>Within 2x</th><th>Worst miss</th></tr>';
  $('schemes').innerHTML = sh + R.validation.schemes.map(function (s) {
    return '<tr><td>' + esc(s.scheme) + '</td><td class="num win">' + s.model + '</td><td class="num">' + s.baseline + '</td><td class="num">' + s.control + '</td><td class="num">' + Math.round(s.within2x * 100) + '%</td><td>' + esc(s.worst.name) + ' x' + s.worst.factor + ' ' + s.worst.direction + '</td></tr>';
  }).join('');

  var ah = '<tr><th>Term offered</th><th>LOO</th><th>Time split</th><th>Verdict</th></tr>';
  $('ablations').innerHTML = ah + R.validation.ablations.map(function (a) {
    return '<tr><td>' + esc(a.term) + '</td><td class="num">' + a.loo + '</td><td class="num">' + a.half + '</td><td>' + esc(a.verdict) + '</td></tr>';
  }).join('');

  var oc = R.model.odds_coefs;
  $('oddsline').textContent = 'Launch odds are a logistic read of the peers\u2019 own record over ' + R.model.odds_dated + ' dated protocols (records-a-token by now, on age, size, growth; coefficients ' + oc.map(function (c) { return Math.round(c * 1000) / 1000; }).join(', ') + '). On this snapshot the token share of dated protocols rises with age — 8% under a year to 34% at 3–5 years — so the odds rise with age here; the falling-with-age curve other radars print was tested against this record and is not in it. Intervals are conformal: each family\u2019s band is the 80th percentile of its own leave-one-out misses.';

  var chips = [
    [acct.peers, 'priced as peers'],
    [acct.wrapperPriced, 'priced as wrappers (underlying-asset tokens)'],
    [acct.tokenUnusable, 'record a token but no usable price pair'],
    [acct.candidates, 'boarded as launch candidates']
  ];
  acct.excluded.forEach(function (e) { chips.push([e.count, 'set aside — ' + e.reason]); });
  $('accounting').innerHTML = chips.map(function (c) { return '<span class="chip"><b>' + c[0] + '</b> ' + esc(c[1]) + '</span>'; }).join('') +
    '<p class="note">The buckets sum to ' + acct.total + '. A protocol is set aside only for a named reason, counted above — never silently dropped.</p>';

  $('boardtitle').textContent = 'The board — all ' + R.counts.board + ' candidates, ranked by implied value';
  var rows = R.rows;
  function tagV(v) { return v === 'front of the queue' ? 'front' : v === 'worth the hours' ? 'worth' : 'watch'; }
  function render() {
    var q = ($('q').value || '').toLowerCase();
    var fr = $('fregime').value, fv = $('fverdict').value, wl = $('fwl').checked;
    var list = rows.filter(function (r) {
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      if (fr && r.regime !== fr) return false;
      if (fv && r.verdict !== fv) return false;
      if (wl && !r.watchlist) return false;
      return true;
    });
    var head = '<tr><th>#</th><th>Protocol</th><th class="hideS">Category</th><th>TVL</th><th class="hideS">7d</th><th>Implied value</th><th class="hideS">Conformal band</th><th class="hideS">Odds</th><th>Rank range</th><th>Verdict ($/hr-costed)</th></tr>';
    $('board').innerHTML = head + list.slice(0, 400).map(function (r) {
      return '<tr class="row" data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td><td>' + esc(r.name) + (r.watchlist ? ' ★' : '') + '<br><span style="color:var(--dim)">' + esc(r.slug) + '</span></td><td class="hideS">' + esc(r.category || '—') + '</td><td class="num">' + fmt$(r.tvl_usd) + '</td><td class="hideS num">' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d + '%') + ' <span class="tag ' + (r.regime === 'momentum' ? 'mom' : 'rev') + '">' + (r.regime === 'momentum' ? 'MOM' : 'REV') + '</span></td><td class="num"><b>' + fmt$(r.implied_value_usd) + '</b></td><td class="hideS num">' + fmt$(r.interval_lo_usd) + ' – ' + fmt$(r.interval_hi_usd) + '</td><td class="hideS num">' + r.odds_pct + '%</td><td class="num">' + r.rank_lo + '–' + r.rank_hi + '</td><td><span class="tag ' + tagV(r.verdict) + '">' + esc(r.verdict) + '</span><br><span style="color:var(--dim)">plan $' + r.plan.cost_usd + ' · ' + r.plan.minutes + ' min · $' + r.plan.cost_per_hour_usd + '/hr</span></td></tr>';
    }).join('');
    $('boardnote').textContent = 'Showing ' + Math.min(list.length, 400) + ' of ' + list.length + ' rows. ★ = on the house watchlist (TVL at or above the $50M floor). Rank ranges come from ' + '120 bootstrap refits of the peer set. Click a row for its arithmetic, interval, odds and farm plan.';
    Array.prototype.forEach.call(document.querySelectorAll('tr.row'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }
  function openDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var d = $('detail');
    d.hidden = false;
    d.innerHTML = '<button class="close" id="dclose">Close</button><h2>' + esc(r.name) + '</h2>' +
      '<div style="color:var(--dim)">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + ' · ' + esc(r.family) + ' family · ' + (r.watchlist ? 'house watchlist' : 'below the watchlist floor') + '</div>' +
      '<dl class="kv">' +
      '<dt>Rank</dt><dd>#' + r.rank + ' (range ' + r.rank_lo + '–' + r.rank_hi + ')</dd>' +
      '<dt>TVL</dt><dd>' + fmt$(r.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + (r.change_7d === null ? '—' : r.change_7d + '%') + ' → ' + r.regime + '</dd>' +
      '<dt>Category multiple</dt><dd>x' + (Math.round(r.model.category_multiple * 1000) / 1000) + ' (' + r.regime + ' peers, shrunk K=4.5)</dd>' +
      '<dt>Size adjustment</dt><dd>x' + (Math.round(r.model.adjustment * 1000) / 1000) + '</dd>' +
      '<dt>Implied value</dt><dd>' + fmt$(r.implied_value_usd) + '</dd>' +
      '<dt>Conformal band</dt><dd>' + fmt$(r.interval_lo_usd) + ' – ' + fmt$(r.interval_hi_usd) + '</dd>' +
      '<dt>Launch odds</dt><dd>' + r.odds_pct + '% of like peers already trade</dd>' +
      '<dt>Age</dt><dd>' + (r.age_days === null ? 'unreported' : r.age_days + ' days') + '</dd>' +
      '<dt>Farm plan</dt><dd>$' + r.plan.cost_usd + ' · ' + r.plan.minutes + ' min · $' + r.plan.cost_per_hour_usd + '/hr</dd>' +
      '<dt>Verdict</dt><dd>' + esc(r.verdict) + '</dd>' +
      '</dl><h3>Farm plan, costed step by step</h3>' +
      r.farm_steps.map(function (s) { return '<div class="step">' + esc(s) + '</div>'; }).join('');
    $('dclose').addEventListener('click', function () { d.hidden = true; });
  }
  ['q', 'fregime', 'fverdict', 'fwl'].forEach(function (id) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  });
  render();

  var lh = '<tr><th>Protocol</th><th>Symbol</th><th class="hideS">Category</th><th>TVL</th><th>Market cap</th><th class="hideS">Cap / TVL</th></tr>';
  $('live').innerHTML = lh + R.live.map(function (p) {
    return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.symbol || '—') + '</td><td class="hideS">' + esc(p.category || '—') + '</td><td class="num">' + fmt$(p.tvl_usd) + '</td><td class="num">' + fmt$(p.mcap_usd) + '</td><td class="hideS num">' + (p.ratio === null ? '—' : 'x' + (Math.round(p.ratio * 100) / 100)) + '</td></tr>';
  }).join('');

  $('foot').textContent = 'peer-priced-5 · fitted only on the sealed snapshot (' + R.as_of + ') · deterministic: two runs write the same bytes · the board gate re-checks every row before anything is written.';

  var params = new URLSearchParams(location.search);
  if (params.get('detail')) openDetail(params.get('detail'));
  if (params.get('verdict')) { $('fverdict').value = params.get('verdict'); render(); }
})();
