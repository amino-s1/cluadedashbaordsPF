/**
 * Builds a small Acquisition-side cross-check for the Diagnostic tab's
 * Customer_Passed_PG_Dropped_Before_Registration deep-dive.
 *
 * That funnel step counts New-Customer visitors who passed PG screening but
 * never entered a Civil ID — i.e. they never became a "submitted
 * application" at all, so they have no CivilID/StagingID and are
 * structurally invisible to Acquisition_Command_Dashboard.html /
 * RAWSTORE (which only tracks submitted applications). The best available
 * cross-check is whether applications that DID get submitted show an
 * elevated abandonment-type status (Incomplete/Abandoned/Lapsed/
 * Withdrawn/Cancelled) on the same days — if that rate is also elevated,
 * the issue likely runs deeper than the PG gate; if not, it's isolated to
 * the pre-registration step specifically.
 *
 * Reads Altitudestatus per day from Acquisition_for_Loans_all_merged.csv
 * (the full merged file — richer than RAWSTORE's 4-bit flags, which don't
 * carry sub-statuses like Incomplete/Abandoned at all) and writes a small
 * per-day breakdown into Funnel_Analysis.html as `const DIAG_ABANDON`.
 *
 * Usage: node scripts/build_pgdrop_overlay.js [FROM] [TO]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const MERGED_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
const HTML_OUT = path.join(ROOT, 'Funnel_Analysis.html');

const DIAG_FROM = process.argv[2] || '2026-08-17';
const DIAG_TO = process.argv[3] || '2026-08-29';
const ABANDON_STATUSES = ['Incomplete [I]', 'Abandoned [B]', 'Lapsed [L]', 'Withdrawn [W]', 'Cancelled [X]'];

console.log('=== PG-drop / Acquisition abandonment cross-check builder ===');
console.log(`Window: ${DIAG_FROM} .. ${DIAG_TO}`);

if (!fs.existsSync(MERGED_CSV)) {
  console.error(`Not found: ${MERGED_CSV} — run scripts/merge_csv.js first.`);
  process.exit(1);
}

function parseCsvLine(line) {
  const r = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { r.push(cur); cur = ''; } else cur += c; }
  }
  r.push(cur);
  return r;
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(MERGED_CSV, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let headers = null, idxStatus = -1, idxSub = -1;
  const byDate = {};
  let n = 0, matched = 0;
  for await (const line of rl) {
    if (!headers) { headers = parseCsvLine(line); idxStatus = headers.indexOf('Altitudestatus'); idxSub = headers.indexOf('submitted'); continue; }
    n++;
    const vals = parseCsvLine(line);
    const sd = (vals[idxSub] || '').slice(0, 10);
    if (sd < DIAG_FROM || sd > DIAG_TO) continue;
    matched++;
    const st = vals[idxStatus] || 'Unknown';
    if (!byDate[sd]) byDate[sd] = {};
    byDate[sd][st] = (byDate[sd][st] || 0) + 1;
  }
  console.log(`  ${n.toLocaleString()} rows scanned, ${matched.toLocaleString()} submitted within the window`);

  const dates = Object.keys(byDate).sort();
  const byDay = {};
  dates.forEach(d => {
    const o = byDate[d];
    const total = Object.values(o).reduce((a, b) => a + b, 0);
    const abandon = ABANDON_STATUSES.reduce((s, k) => s + (o[k] || 0), 0);
    byDay[d] = { total, abandon, statuses: o };
  });

  const overlay = { meta: { from: DIAG_FROM, to: DIAG_TO, rows: matched, generatedAt: new Date().toISOString().slice(0, 10) }, abandonStatuses: ABANDON_STATUSES, dates, byDay };

  console.log('Splicing DIAG_ABANDON into Funnel_Analysis.html…');
  const html = fs.readFileSync(HTML_OUT, 'utf-8');
  const blob = `const DIAG_ABANDON = ${JSON.stringify(overlay)};\n`;
  const startTag = 'const DIAG_ABANDON = ';
  const si = html.indexOf(startTag);
  let newHtml;
  if (si !== -1) {
    const se = html.indexOf(';\n', si) + 2;
    newHtml = html.slice(0, si) + blob + html.slice(se);
    console.log('  (replaced existing DIAG_ABANDON)');
  } else {
    const anchor = 'const JOURNEYS=cD.journeys;';
    const ai = html.indexOf(anchor);
    if (ai === -1) { console.error('Could not find insertion anchor'); process.exit(1); }
    newHtml = html.slice(0, ai) + blob + html.slice(ai);
    console.log('  (inserted new DIAG_ABANDON)');
  }
  fs.writeFileSync(HTML_OUT, newHtml, 'utf-8');
  console.log('✅ Done.');
}
main();
