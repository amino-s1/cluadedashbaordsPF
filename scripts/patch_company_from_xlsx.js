#!/usr/bin/env node
/**
 * Patch corrupted Arabic `Company` values in Acquisition_for_Loans_all_merged.csv
 * using a clean-text source .xlsx export (Company/Arabic text survives intact in
 * the xlsx; it gets mangled somewhere in whatever step produces the CSV).
 *
 * Scope (see conversation 2026-09-12): this does NOT switch the pipeline to
 * ingest xlsx wholesale -- merge_csv.js's raw-line-per-StagingID architecture
 * stays as-is, and the xlsx exports we get are partial rolling windows, not
 * full history, so 100% backfill isn't possible from these files alone. This
 * only patches the StagingIDs a given xlsx happens to cover, whenever one is
 * supplied -- coverage grows incrementally over time, best-effort.
 *
 * Reads column A (StagingID) + column J (Company) directly out of the xlsx's
 * zipped sheet1.xml + sharedStrings.xml via streaming regex extraction --
 * NOT the xlsx.js full-workbook parser, which OOMs/crawls on files this size
 * (confirmed live: a 49MB/196K-row file took 15+ min and multiple GB before
 * being killed; this streaming approach does the same job in under a
 * minute).
 *
 * Usage: node scripts/patch_company_from_xlsx.js <path-to.xlsx> [merged-csv-path]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
const CORRUPTED_COMPANY_RE = /[�?]/;

const xlsxPath = process.argv[2];
const csvPath = process.argv[3] || DEFAULT_CSV;
if (!xlsxPath) {
  console.error('Usage: node scripts/patch_company_from_xlsx.js <path-to.xlsx> [merged-csv-path]');
  process.exit(1);
}
if (!fs.existsSync(xlsxPath)) { console.error('Not found:', xlsxPath); process.exit(1); }
if (!fs.existsSync(csvPath)) { console.error('Not found:', csvPath); process.exit(1); }

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// --- Step 1: pull sharedStrings.xml + sheet1.xml out of the xlsx zip ---
console.log('Extracting xlsx internals…');
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xlsx_patch_'));
const sstPath = path.join(tmpDir, 'sharedStrings.xml');
const r1 = spawnSync('unzip', ['-p', xlsxPath, 'xl/sharedStrings.xml'], { maxBuffer: 1024 * 1024 * 200 });
if (r1.status !== 0) { console.error('unzip sharedStrings.xml failed:', r1.stderr.toString()); process.exit(1); }
fs.writeFileSync(sstPath, r1.stdout);

console.log('Parsing sharedStrings.xml…');
const sstText = fs.readFileSync(sstPath, 'utf-8');
const sharedStrings = [];
{
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(sstText))) {
    const block = m[1];
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(block))) text += tm[1];
    sharedStrings.push(unescapeXml(text));
  }
}
console.log('  Shared strings:', sharedStrings.length);

// --- Step 2: read sheet1.xml in one shot, extract StagingID (col A) + Company (col J) per row ---
// (An earlier chunked-streaming version of this with a carry-buffer for
// boundary-spanning rows was DROPPED after it was caught producing more ID
// matches (227,957) than the xlsx actually has distinct StagingIDs
// (195,969) -- some rows were evidently being re-processed across chunk
// boundaries. A 383MB sheet1.xml comfortably fits in memory as one string
// (confirmed live, well under the heap budget), so there's no need to
// stream it at all -- this is simpler AND correct.)
function scanSheet(xlsxPath, sharedStrings) {
  console.log('  Reading sheet1.xml (single pass)…');
  const r = spawnSync('unzip', ['-p', xlsxPath, 'xl/worksheets/sheet1.xml'], { maxBuffer: 1024 * 1024 * 800 });
  if (r.status !== 0) throw new Error('unzip sheet1.xml failed: ' + r.stderr.toString());
  const sheetText = r.stdout.toString('utf-8');

  const patchMap = new Map(); // StagingID -> clean Company text
  let rowsScanned = 0;
  const rowRe = /<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellA_Re = /<c r="A\d+"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/;
  const cellA_Inline_Re = /<c r="A\d+"[^>]*t="str"[^>]*><v>([^<]*)<\/v><\/c>/;
  const cellJ_Re = /<c r="J\d+"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/;
  let rm;
  while ((rm = rowRe.exec(sheetText))) {
    const rowXml = rm[2];
    let stagingId = null;
    const am = cellA_Re.exec(rowXml);
    if (am) stagingId = sharedStrings[parseInt(am[1], 10)];
    else { const am2 = cellA_Inline_Re.exec(rowXml); if (am2) stagingId = am2[1]; }
    if (stagingId) {
      const jm = cellJ_Re.exec(rowXml);
      const company = jm ? (sharedStrings[parseInt(jm[1], 10)] || '').trim() : '';
      if (company) patchMap.set(stagingId.trim(), company);
      rowsScanned++;
    }
  }
  return { patchMap, rowsScanned };
}

function parseCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { result.push(cur); cur = ''; } else cur += c; }
  }
  result.push(cur);
  return result;
}
function csvField(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  console.log('Extracting StagingID + Company from sheet1.xml…');
  const { patchMap, rowsScanned } = scanSheet(xlsxPath, sharedStrings);
  console.log('  Rows scanned:', rowsScanned, '· StagingIDs with a Company value:', patchMap.size);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // --- Step 3: stream the merged CSV, patch corrupted Company fields in place ---
  console.log('Patching', path.basename(csvPath), '…');

  const text = fs.readFileSync(csvPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const headerCols = parseCsvLine(lines[0]);
  const companyIdx = headerCols.indexOf('Company');
  const stagingIdx = headerCols.indexOf('StagingID');
  if (companyIdx === -1 || stagingIdx === -1) {
    console.error('Could not find Company/StagingID columns in', csvPath);
    process.exit(1);
  }
  console.log('  Company column:', companyIdx, '· StagingID column:', stagingIdx);

  let patched = 0, checked = 0, skippedNoMatch = 0;
  const outLines = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const commaIdx = line.indexOf(',');
    const id = commaIdx > 0 ? line.slice(0, commaIdx) : line;
    const current = patchMap.get(id);
    if (current === undefined) { outLines.push(line); continue; }

    const vals = parseCsvLine(line);
    const existing = (vals[companyIdx] || '').trim();
    checked++;
    if (CORRUPTED_COMPANY_RE.test(existing)) {
      vals[companyIdx] = current;
      outLines.push(vals.map(csvField).join(','));
      patched++;
    } else {
      outLines.push(line); // already clean (or blank) -- leave as-is
      skippedNoMatch++;
    }
  }

  const outPath = csvPath; // in place; original is derivable from source files if needed
  const tmpOut = csvPath + '.patching.tmp';
  fs.writeFileSync(tmpOut, outLines.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpOut, outPath);

  console.log('\n✅ Done.');
  console.log('  StagingIDs matched between xlsx and CSV:', checked);
  console.log('  Corrupted Company values patched:', patched);
  console.log('  Already-clean/blank (left untouched):', skippedNoMatch);
}

main().catch(e => { console.error(e); process.exit(1); });
