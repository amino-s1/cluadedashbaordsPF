/**
 * Converts the JSONL SIMAH export (one full report JSON object per line,
 * no CSV wrapper -- e.g. "JSON SIMAH/simahjson_output_2026-01-01_2026-08-30.txt",
 * ~24GB, 400,030 records) into per-day CSV files matching the EXACT format
 * every existing pipeline script already expects (header row
 * "Response_Date,JSON_Response,Analytics_Report_Date", one row per report),
 * written into the "SIMAH Qarar JSON" archive folder as
 * "SIMAH_Qarar_JSON_YYYY-MM-DD.csv" -- so update_simah_from_qarar_csv.js,
 * backfill_simah_rawrecords.js, build_simah_datechunks.js,
 * build_coconut_matches.js, build_coconut_v2.js, build_ucfs_company_compare.js
 * all keep working completely unchanged, just against a much wider archive.
 *
 * By DEFAULT only writes dates that don't already have a CSV in the archive
 * (safe -- extends coverage backward without touching already-verified
 * days). Pass --overwrite to regenerate every date from this source
 * instead, including ones that already exist.
 *
 * Bucketing date = the report's own top-level "reportDate" field
 * (DD/MM/YYYY in the source), converted to YYYY-MM-DD. This is the closest
 * available proxy for "Response_Date"/"Analytics_Report_Date" -- the
 * original wrapped-CSV archive carried those as separate pull-metadata
 * columns that this raw JSONL export doesn't have; using the report's own
 * date for both is what every downstream date-bucketing/date-filter
 * already assumes in practice for the existing archive too.
 *
 * Streams the whole 24GB file exactly once via readline -- never loads it
 * into memory. Output CSV rows are written incrementally via one open
 * write stream per date (dates span ~240 days -- a small, fixed number of
 * concurrent file handles).
 *
 * Usage: node --max-old-space-size=4096 scripts/convert_simah_jsonl_to_daily_csv.js [--overwrite]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'JSON SIMAH', 'simahjson_output_2026-01-01_2026-08-30.txt');
const ARCHIVE_DIR = path.join('C:', 'Users', 'Emad.Ayyash', 'OneDrive - tasheelfinance', 'Documents', 'EIA Work', 'AI-Work', 'SIMAH Qarar JSON');
const OVERWRITE = process.argv.includes('--overwrite');

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
// "31/01/2026" -> "2026-01-31"
function toYMD(dmy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((dmy || '').trim());
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

async function main() {
  console.log('=== Converting JSONL SIMAH export to daily CSVs ===');
  console.log('Source:', SOURCE);
  console.log('Mode:', OVERWRITE ? 'OVERWRITE existing dates too' : 'skip dates that already have a CSV (safe/additive)');

  const existingDates = new Set(
    fs.readdirSync(ARCHIVE_DIR)
      .filter(f => /^SIMAH_Qarar_JSON_\d{4}-\d{2}-\d{2}\.csv$/i.test(f))
      .map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1])
  );
  console.log(`${existingDates.size} dates already archived.`);

  const streams = new Map(); // date -> {stream, count, skip}
  function getStream(date) {
    let s = streams.get(date);
    if (s) return s;
    const skip = !OVERWRITE && existingDates.has(date);
    if (skip) { s = { stream: null, count: 0, skip: true }; streams.set(date, s); return s; }
    const fp = path.join(ARCHIVE_DIR, `SIMAH_Qarar_JSON_${date}.csv`);
    const stream = fs.createWriteStream(fp, { encoding: 'utf-8' });
    stream.write('Response_Date,JSON_Response,Analytics_Report_Date\n');
    s = { stream, count: 0, skip: false };
    streams.set(date, s);
    return s;
  }

  const rl = readline.createInterface({ input: fs.createReadStream(SOURCE, { encoding: 'utf-8', highWaterMark: 1024 * 1024 }), crlfDelay: Infinity });
  let n = 0, written = 0, skipped = 0, parseErrs = 0, noDate = 0;
  const t0 = Date.now();
  for await (const line of rl) {
    if (!line.trim()) continue;
    n++;
    if (n % 25000 === 0) console.log(`  ... ${n.toLocaleString()} lines (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
    let obj;
    try { obj = JSON.parse(line); } catch (e) { parseErrs++; continue; }
    const date = toYMD(obj.reportDate || obj.reportDetails?.reportDate);
    if (!date) { noDate++; continue; }
    const s = getStream(date);
    if (s.skip) { skipped++; continue; }
    s.stream.write(csvEscape(date) + ',' + csvEscape(line) + ',' + csvEscape(date) + '\n');
    s.count++;
    written++;
  }
  console.log(`Done reading. ${n.toLocaleString()} lines, ${written.toLocaleString()} written, ${skipped.toLocaleString()} skipped (already archived), ${parseErrs.toLocaleString()} parse errors, ${noDate.toLocaleString()} no date.`);

  await Promise.all([...streams.values()].filter(s => s.stream).map(s => new Promise(res => s.stream.end(res))));

  const newDates = [...streams.entries()].filter(([, s]) => s.stream && s.count > 0).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`Wrote ${newDates.length} new date files:`);
  newDates.forEach(([d, s]) => console.log(`  ${d}: ${s.count.toLocaleString()} records`));
  console.log('✅ Done.');
}
main();
