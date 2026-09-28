#!/usr/bin/env node
/**
 * Update Funnel_Analysis.html with Tawarruq_Funnel xlsx files.
 *
 * Usage:
 *   node scripts/update_funnel.js                         # auto-find new files in the Tawarruq Funnel folder
 *   node scripts/update_funnel.js path/to/file.xlsx       # process specific file(s)
 *   node scripts/update_funnel.js file1.xlsx file2.xlsx   # process multiple files
 *
 * Reads existing FUNNEL_DEFAULT from Funnel_Analysis.html, merges new days
 * (last file wins for a given date), and writes the updated dataset back.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadConfig } = require('./pipeline_config.js');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'Funnel_Analysis.html');
const cfg = loadConfig();

// Folder where daily Tawarruq_Funnel xlsx files are stored. Machine-specific
// -- see pipeline.config.json / setup_config.js.
const FUNNEL_FOLDER = path.resolve(cfg.funnelArchiveDir);

// Also check Downloads for newly dropped files
const DOWNLOADS = path.resolve(cfg.downloadsDir);

const JOURNEYS = ['New Customer', 'Existing Customer', 'BO (Tawarruq)', 'BO (Combo)', 'UI to BO'];

// ── Helpers ──

function canonStep(n) {
  n = String(n).trim();
  if (n === 'IVR' || n === 'IVR/ Approval Call Completed') return 'IVR_Completed';
  if (n === 'Sayeen_Count' || n === 'Emdha_Count' || n === 'Sayen/Emdha_Count') return 'Sayen_Emdha';
  return n;
}

function dateFromName(filename, rows) {
  const m = String(filename).match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Fallback: extract from UpdatedOn column (Excel serial number)
  for (const r of rows) {
    const v = r['UpdatedOn'];
    if (v != null) {
      if (typeof v === 'number') {
        // Excel serial date → JS Date
        const d = new Date((v - 25569) * 86400000);
        if (!isNaN(d)) return ymd(d);
      } else {
        const d = new Date(v);
        if (!isNaN(d)) return ymd(d);
      }
    }
  }
  return null;
}

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseXlsx(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false }); // keep serial numbers
  const out = { date: null, journeys: {} };

  wb.SheetNames.forEach(sn => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
    if (!out.date) out.date = dateFromName(path.basename(filePath), rows);

    const j = sn.trim();
    const dj = {};
    rows.forEach(r => {
      if (r['StepName'] == null) return;
      const s = canonStep(r['StepName']);
      const v = Number(r['Result']);
      if (!isNaN(v)) dj[s] = (dj[s] || 0) + v;
    });
    out.journeys[j] = dj;
  });

  return out;
}

// ── Find xlsx files to process ──

function findNewFiles(existingDates) {
  const files = [];
  const seen = new Set();

  // Check Tawarruq Funnel folder
  for (const folder of [FUNNEL_FOLDER, DOWNLOADS]) {
    if (!fs.existsSync(folder)) continue;
    const entries = fs.readdirSync(folder)
      .filter(f => /^Tawarruq_Funnel.*\.xlsx$/i.test(f))
      .sort();
    for (const f of entries) {
      // Extract date from filename
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const date = m[1];
      // Skip if we already have this date AND the file isn't newer
      if (seen.has(date)) continue;
      seen.add(date);
      files.push({ path: path.join(folder, f), date, name: f });
    }
  }

  return files;
}

// ── Main ──

console.log('Reading existing FUNNEL_DEFAULT from Funnel_Analysis.html …');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const fMatch = html.match(/const FUNNEL_DEFAULT\s*=\s*(\{[\s\S]*?\});\s*$/m);
if (!fMatch) {
  console.error('Could not find FUNNEL_DEFAULT in Funnel_Analysis.html');
  process.exit(1);
}

const existing = JSON.parse(fMatch[1]);
console.log('  Existing: %d dates (%s → %s)', existing.dates.length, existing.meta.min, existing.meta.max);

// Deep clone days
const days = JSON.parse(JSON.stringify(existing.days));

// Determine which files to process
let xlsxFiles = [];
if (process.argv.length > 2) {
  // Files specified on command line
  for (let i = 2; i < process.argv.length; i++) {
    const fp = path.isAbsolute(process.argv[i]) ? process.argv[i] : path.join(ROOT, process.argv[i]);
    if (fs.existsSync(fp)) {
      xlsxFiles.push({ path: fp, name: path.basename(fp) });
    } else {
      console.warn('  File not found: %s', process.argv[i]);
    }
  }
} else {
  // Auto-discover from Tawarruq Funnel folder + Downloads
  xlsxFiles = findNewFiles(new Set(existing.dates));
  if (xlsxFiles.length === 0) {
    console.log('  No new Tawarruq_Funnel xlsx files found.');
    console.log('  Checked: %s', FUNNEL_FOLDER);
    console.log('           %s', DOWNLOADS);
    process.exit(0);
  }
}

console.log('Processing %d file(s) …', xlsxFiles.length);

let added = 0, updated = 0;
for (const f of xlsxFiles) {
  try {
    const result = parseXlsx(f.path);
    if (!result.date) {
      console.warn('  SKIP (no date): %s', f.name);
      continue;
    }
    const isNew = !days[result.date];
    days[result.date] = days[result.date] || {};
    for (const j in result.journeys) {
      days[result.date][j] = result.journeys[j];
    }
    if (isNew) { added++; } else { updated++; }
    console.log('  %s %s → %d journeys', isNew ? '+' : '↻', result.date, Object.keys(result.journeys).length);
  } catch (err) {
    console.warn('  ERROR processing %s: %s', f.name, err.message);
  }
}

// Rebuild metadata
const dates = Object.keys(days).sort();
const newData = {
  meta: {
    min: dates[0],
    max: dates[dates.length - 1],
    nfiles: dates.length,
    name: dates.length + ' days (merged)'
  },
  dates,
  journeys: JOURNEYS,
  days
};

console.log('\n  Result: %d dates (%s → %s)', dates.length, newData.meta.min, newData.meta.max);
console.log('  Added: %d new, Updated: %d existing', added, updated);

// Inject into HTML
const newLine = 'const FUNNEL_DEFAULT = ' + JSON.stringify(newData) + ';';
const updatedHtml = html.replace(/const FUNNEL_DEFAULT\s*=\s*\{[\s\S]*?\};\s*$/m, newLine);

if (updatedHtml === html && added === 0 && updated === 0) {
  console.log('\nNo changes to write.');
  process.exit(0);
}

fs.writeFileSync(HTML_PATH, updatedHtml, 'utf8');
console.log('\n✅ Funnel_Analysis.html updated — %d days (%s → %s)', dates.length, newData.meta.min, newData.meta.max);

// Also copy the xlsx to the Tawarruq Funnel archive folder
for (const f of xlsxFiles) {
  const destFolder = FUNNEL_FOLDER;
  const destPath = path.join(destFolder, path.basename(f.path));
  if (f.path !== destPath && fs.existsSync(destFolder)) {
    try {
      fs.copyFileSync(f.path, destPath);
      console.log('  Archived: %s → Tawarruq Funnel/', path.basename(f.path));
    } catch (e) {
      // Non-fatal — folder might not be writable
    }
  }
}
