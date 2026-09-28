/**
 * One-off patch: add stagingId to the 353 records from the last merge batch
 * (JSON SIMAH/combined_output 2026-08-08.txt) without re-running the full
 * merge (which would double-count them, since they're already in SIMAH_DATA).
 *
 * The original 1,881-record batch's raw source file isn't available anymore,
 * so those records keep stagingId:'' — documented limitation, not a bug.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HTML_OUT = path.join(ROOT, 'SIMAH_Intelligence.html');
const COMBINED_FILE = path.join(ROOT, 'JSON SIMAH', 'combined_output 2026-08-08.txt');
const BATCH_SIZE = 353;

// --- reuse extractFeatures/readCsv/findLatestAcqFile by re-requiring the source text ---
const pipelineSrc = fs.readFileSync(path.join(__dirname, 'update_simah_from_combined.js'), 'utf-8');
// Extract just the function definitions we need via a sandboxed eval (no MAIN execution)
const vm = require('vm');
// process.argv[2] must point to a real, existing file — the pipeline script has
// an early exit-guard checking fs.existsSync(argv[2]) before any function defs.
// Since vm.runInContext shares this process, process.exit() there would kill us too.
const sandbox = { module: {}, require, console, __dirname, __filename: __filename, process: { argv: ['node', 'x', COMBINED_FILE], exit: () => { throw new Error('pipeline guard tripped — argv[2] check failed'); } } };
vm.createContext(sandbox);
// Strip the MAIN section (everything after the '// ═══ MAIN ═══' marker) so it doesn't try to run/exit.
const mainMarker = pipelineSrc.indexOf("// ═══════════════════════ MAIN ═══════════════════════");
const fnOnly = pipelineSrc.slice(0, mainMarker) + '\nmodule.exports = { extractFeatures, readCsv, findLatestAcqFile, buildAggregates };';
vm.runInContext(fnOnly, sandbox, { filename: 'update_simah_from_combined.js' });
const { extractFeatures, readCsv, findLatestAcqFile, buildAggregates } = sandbox.module.exports;

console.log('Reprocessing', COMBINED_FILE, 'to extract stagingId…');
const lines = fs.readFileSync(COMBINED_FILE, 'utf-8').split(/\r?\n/).filter(l => l.trim());
const features = [];
lines.forEach(line => {
  try {
    const rep = JSON.parse(line);
    const f = extractFeatures(rep);
    if (f.civilId) features.push(f);
  } catch (e) { /* ignore, matches original run's error tolerance */ }
});
console.log('  extracted', features.length, 'features (expected', BATCH_SIZE, ')');

const acqFile = findLatestAcqFile();
let acqMap = {};
if (acqFile) {
  const rows = readCsv(path.join(ROOT, acqFile));
  rows.forEach(r => { if (r.CivilID) acqMap[r.CivilID] = r; });
  console.log('  using', acqFile, '-', Object.keys(acqMap).length, 'CivilIDs');
}

const newAgg = buildAggregates(features, acqMap);
const withStagingId = newAgg.rawRecords.filter(r => r.stagingId).length;
console.log('  ', withStagingId, 'of', newAgg.rawRecords.length, 'new records have a matched StagingID');

// --- Load current SIMAH_DATA, splice the last BATCH_SIZE rawRecords with the reprocessed versions ---
const html = fs.readFileSync(HTML_OUT, 'utf-8');
const marker = 'const SIMAH_DATA = {';
const startIdx = html.indexOf(marker);
if (startIdx === -1) { console.error('SIMAH_DATA marker not found'); process.exit(1); }
let depth = 0, endIdx = startIdx + marker.length - 1;
for (let i = endIdx; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}
if (html[endIdx] === ';') endIdx++;
const existing = JSON.parse(html.slice(startIdx + marker.length - 1, html[endIdx - 1] === ';' ? endIdx - 1 : endIdx));

if (existing.rawRecords.length < BATCH_SIZE) {
  console.error('existing rawRecords shorter than batch size — aborting to avoid corrupting data');
  process.exit(1);
}
const cut = existing.rawRecords.length - BATCH_SIZE;
const kept = existing.rawRecords.slice(0, cut).map(r => ({ ...r, stagingId: r.stagingId || '' })); // schema consistency
const replaced = existing.rawRecords.slice(cut); // sanity check only
existing.rawRecords = [...kept, ...newAgg.rawRecords];

console.log('  patched rawRecords: kept', kept.length, 'unchanged, replaced last', replaced.length, 'with stagingId-enabled versions');

const dataLine = `const SIMAH_DATA = ${JSON.stringify(existing)};`;
const updated = html.slice(0, startIdx) + dataLine + html.slice(endIdx);
fs.writeFileSync(HTML_OUT, updated, 'utf-8');
console.log('Done.');
