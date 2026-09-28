#!/usr/bin/env node
/**
 * Merge SNB_Referral_*.csv daily exports into one cumulative dataset.
 *
 * Each daily export is a FULL cumulative snapshot going back to the first
 * referral (confirmed 2026-09-27: the 09-21 file's 1,689 rows are a strict
 * subset of the 09-26 file's 1,753 -- every ID carries forward). Status DOES
 * change for an existing ReferralId across files (36 of 1,689 changed
 * between the 09-21 and 09-26 pulls), so this is last-file-wins per
 * ReferralId, same convention as Acquisition_for_Loans -- NOT additive like
 * SIMAH. ReferralId is the correct dedupe key (confirmed unique within a
 * single file); ReferenceNumber is NOT unique -- 213 of 1,357 reference
 * numbers in the 09-26 file map to more than one ReferralId (re-referrals).
 *
 * Like merge_csv.js, this scans BOTH the project root and the archive
 * folder every run, so it always has memory of every file it has ever
 * processed, not just what happens to be in the root right now.
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./update_acquisition_dashboard.js');
const { loadConfig } = require('./pipeline_config.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'SNB_Referral_all_merged.csv');
const FILE_RE = /^SNB_Referral_(\d{4}-\d{2}-\d{2})\.csv$/i;

const config = loadConfig();
const archiveDir = config.snbReferralArchiveDir;

function findFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => FILE_RE.test(f))
    .map(f => ({ name: f, full: path.join(dir, f), date: f.match(FILE_RE)[1] }));
}

const rootFiles = findFiles(ROOT);
const archiveFiles = archiveDir ? findFiles(archiveDir) : [];
// De-dupe by date across root+archive (prefer root copy if somehow both exist)
const byDate = new Map();
archiveFiles.forEach(f => byDate.set(f.date, f));
rootFiles.forEach(f => byDate.set(f.date, f));
const files = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

if (!files.length) {
  console.log('No SNB_Referral_*.csv files found in the project root or archive folder. Nothing to do.');
  process.exit(0);
}

console.log(`Merging ${files.length} file(s) …`);
files.forEach(f => console.log(`  ${f.name}${f.full.startsWith(ROOT) ? '' : ' (archive)'}`));

const byId = new Map(); // ReferralId -> row, later file overwrites earlier
files.forEach(f => {
  const rows = readCsv(f.full);
  rows.forEach(r => { if (r.ReferralId) byId.set(r.ReferralId, r); });
  console.log(`  ${f.name}: ${rows.length.toLocaleString()} rows, total unique now ${byId.size.toLocaleString()}`);
});

const merged = [...byId.values()];
if (merged.length < 100) {
  console.error(`ERROR: only ${merged.length} rows after merge -- expected 1,000+. Stopping without writing, something is wrong.`);
  process.exit(1);
}

// Write out using the header from the first row (all files share the same columns)
const header = Object.keys(merged[0]);
const esc = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const lines = [header.join(',')];
merged.forEach(r => lines.push(header.map(h => esc(r[h])).join(',')));
fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf-8');
console.log(`\n✅ Wrote ${merged.length.toLocaleString()} rows to ${path.basename(OUT_FILE)}`);

// Archive every ROOT-sourced file (archive-sourced ones are left in place)
if (archiveDir) {
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  rootFiles.forEach(f => {
    const dest = path.join(archiveDir, f.name);
    if (path.resolve(f.full) === path.resolve(dest)) return;
    try {
      fs.renameSync(f.full, dest);
    } catch (e) {
      fs.copyFileSync(f.full, dest);
      fs.unlinkSync(f.full);
    }
    console.log(`  Archived: ${f.name} → ${path.basename(archiveDir)}/`);
  });
} else {
  console.warn('WARN: snbReferralArchiveDir not set in pipeline.config.json -- files left in the project root. Run node scripts/setup_config.js to set it.');
}
