/**
 * Builds the Income / Smart-Finance / Source overlay for Funnel_Analysis.html's
 * Diagnostic tab, for a fixed date window (default 2026-08-17..2026-08-25).
 *
 * Why a separate overlay instead of reading the Funnel xlsx data: income,
 * nationality, employer type, Smart/Normal, and Online/Back-Office are all
 * Acquisition-system fields — the funnel export never carries them. This
 * script decodes Acquisition_Command_Dashboard.html's RAWSTORE (per-row
 * columnar data, so it supports a real cross-tab: income trend filtered by
 * a selected nationality AND employer type, not just independent
 * single-dimension totals) and writes a small aggregated slice into
 * Funnel_Analysis.html as `const DIAG_ACQ = {...}`.
 *
 * Usage: node scripts/build_diagnostic_overlay.js [FROM] [TO]
 *   (dates default to 2026-08-17 / 2026-08-25 to match the Diagnostic tab)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ACQ_FILE = path.join(ROOT, 'Acquisition_Command_Dashboard.html');
const HTML_OUT = path.join(ROOT, 'Funnel_Analysis.html');

const DIAG_FROM = process.argv[2] || '2026-08-17';
const DIAG_TO = process.argv[3] || '2026-08-25';

console.log('=== Diagnostic overlay builder ===');
console.log(`Window: ${DIAG_FROM} .. ${DIAG_TO}`);

console.log('Reading RAWSTORE from Acquisition_Command_Dashboard.html…');
const acqHtml = fs.readFileSync(ACQ_FILE, 'utf-8');
const marker = 'const RAWSTORE = ';
const mi = acqHtml.indexOf(marker);
if (mi === -1) { console.error('RAWSTORE not found'); process.exit(1); }
// CRLF-safe: the file's line endings can flip between LF and CRLF depending
// on which tool last touched it, so match either instead of a literal ';\n'.
const endMatch = /\};\r?\n/.exec(acqHtml.slice(mi));
if (!endMatch) { console.error('Could not find end of RAWSTORE statement'); process.exit(1); }
const me = mi + endMatch.index + 1; // +1 to include the closing brace
const rs = JSON.parse(acqHtml.slice(mi + marker.length, me));
console.log(`  ${rs.n.toLocaleString()} rows, ${rs.dates.length} dates (${rs.dates[0]} → ${rs.dates[rs.dates.length - 1]})`);

const buf = zlib.inflateSync(Buffer.from(rs.b64, 'base64'));
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const SIZE = { b: 1, h: 2, i: 4, d: 8 };
function readCol(name) {
  const h = rs.header[name], sz = SIZE[h.t], out = new Array(h.len);
  for (let i = 0; i < h.len; i++) {
    const o = h.off + i * sz;
    if (h.t === 'b') out[i] = dv.getUint8(o);
    else if (h.t === 'h') out[i] = dv.getUint16(o, true);
    else if (h.t === 'i') out[i] = dv.getUint32(o, true);
    else if (h.t === 'd') out[i] = dv.getFloat64(o, true);
  }
  return out;
}
const sday = readCol('sday'), flags = readCol('flags');
const income = readCol('income'), nationality = readCol('nationality'), employer = readCol('employer');
const smart = readCol('smart'), source = readCol('source');

const dates = rs.dates.filter(d => d >= DIAG_FROM && d <= DIAG_TO);
const dateIdxMap = {};
rs.dates.forEach((d, i) => { if (d >= DIAG_FROM && d <= DIAG_TO) dateIdxMap[i] = d; });

const byIncome = {}, bySmart = {}, bySource = {};
dates.forEach(d => { byIncome[d] = {}; bySmart[d] = {}; bySource[d] = {}; });

const bump = (obj, key, init, booked) => {
  if (!obj[key]) obj[key] = { sub: 0, init: 0, book: 0 };
  obj[key].sub++; obj[key].init += init; obj[key].book += booked;
};

let matched = 0;
for (let i = 0; i < rs.n; i++) {
  const d = dateIdxMap[sday[i]];
  if (!d) continue;
  matched++;
  const init = (flags[i] & 1) ? 1 : 0, booked = (flags[i] & 4) ? 1 : 0;
  const incL = rs.vocab.income[income[i]], natL = rs.vocab.nationality[nationality[i]], empL = rs.vocab.employer[employer[i]];
  const smL = rs.vocab.smart[smart[i]], srcL = rs.vocab.source[source[i]];

  const bi = byIncome[d];
  if (!bi[incL]) bi[incL] = {};
  if (!bi[incL][natL]) bi[incL][natL] = {};
  bump(bi[incL][natL], empL, init, booked);

  bump(bySmart[d], smL, init, booked);
  bump(bySource[d], srcL, init, booked);
}
console.log(`  ${matched.toLocaleString()} rows submitted within the window`);

const overlay = {
  meta: { from: DIAG_FROM, to: DIAG_TO, acqFile: rs.dates[rs.dates.length - 1], rows: matched, generatedAt: new Date().toISOString().slice(0, 10) },
  dates,
  vocab: { income: rs.vocab.income, nationality: rs.vocab.nationality, employer: rs.vocab.employer, smart: rs.vocab.smart, source: rs.vocab.source },
  byIncome, bySmart, bySource
};

console.log('Splicing DIAG_ACQ into Funnel_Analysis.html…');
const html = fs.readFileSync(HTML_OUT, 'utf-8');
const blob = `const DIAG_ACQ = ${JSON.stringify(overlay)};\n`;
const startTag = 'const DIAG_ACQ = ';
const si = html.indexOf(startTag);
let newHtml;
if (si !== -1) {
  const se = html.indexOf(';\n', si) + 2;
  newHtml = html.slice(0, si) + blob + html.slice(se);
  console.log('  (replaced existing DIAG_ACQ)');
} else {
  // Insert right after FUNNEL_DEFAULT's closing line, before the JOURNEYS const.
  const anchor = 'const JOURNEYS=cD.journeys;';
  const ai = html.indexOf(anchor);
  if (ai === -1) { console.error('Could not find insertion anchor'); process.exit(1); }
  newHtml = html.slice(0, ai) + blob + html.slice(ai);
  console.log('  (inserted new DIAG_ACQ)');
}
fs.writeFileSync(HTML_OUT, newHtml, 'utf-8');
console.log('✅ Done.');
