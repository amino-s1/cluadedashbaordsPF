/**
 * SMS Analyzer builder
 *
 * Source: SMS_Campaign_YYYY-MM-DD.xlsx (2 sheets):
 *   - "Raw Data": one row per application created via an SMS campaign link.
 *     Every row has a StagingID (`id`); `SubmittedToMaster` is only
 *     populated once the application actually got pushed to the master
 *     Acquisition system (many rows never make it that far -- they stay
 *     "Rejected"/"Deleted"/"Offered" at the staging level). `Status_In_Master`
 *     mirrors Acquisition_Command_Dashboard.html's Altitudestatus for rows
 *     that did reach master.
 *   - "Summary": a vendor-provided monthly rollup by campaign
 *     (SMS_delivered_month, Campaign_name, Total_submissions,
 *     Total_final_approvals, Total_bookings). Reproduced as-is for
 *     historical trend -- its own Total_bookings figure does NOT match a
 *     plain Status_In_Master==='Completed [C]' count on Raw Data (432 vs
 *     1299 for ABNB in August, confirmed 2026-09-15), almost certainly
 *     because bookings mature over weeks after an SMS send and this
 *     Summary was computed with more elapsed time than this fresh Raw Data
 *     export has had -- so the two tables are presented side by side, never
 *     forced to reconcile.
 *
 * Output: SMS_Analyzer.html (embeds SMS_DATA, all analysis client-side).
 *
 * Each export is a fresh FULL snapshot (Raw Data + Summary both cover
 * everything to date, same convention as the Acquisition/SIMAH daily
 * files) -- so processing is "last file wins", not additive. With no
 * argument, auto-discovers the newest SMS_Campaign_*.xlsx in
 * `downloadsDir` (pipeline.config.json) and archives it to
 * `smsArchiveDir` after a successful build, same pattern as
 * update_funnel.js / update_simah_from_qarar_csv.js.
 *
 * Usage: node scripts/build_sms_analyzer.js ["<path to SMS_Campaign_*.xlsx>"]
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'SMS_Analyzer.html');
const BOOKED_SET = new Set(['Completed [C]', 'Pending Final Approval']);
const NAME_PATTERN = /^SMS_Campaign_\d{4}-\d{2}-\d{2}\.xlsx$/i;

function findLatestInDownloads(downloadsDir) {
  if (!downloadsDir || !fs.existsSync(downloadsDir)) return null;
  const files = fs.readdirSync(downloadsDir).filter(f => NAME_PATTERN.test(f)).sort();
  return files.length ? path.join(downloadsDir, files[files.length - 1]) : null;
}

function archiveProcessedFile(processedPath) {
  let cfg;
  try { cfg = require('./pipeline_config.js').loadConfig(); }
  catch (e) { console.warn(`  (skipping archive -- ${e.message})`); return; }
  if (!cfg.smsArchiveDir) { console.warn('  (skipping archive -- smsArchiveDir not set in pipeline.config.json)'); return; }
  if (!fs.existsSync(cfg.smsArchiveDir)) fs.mkdirSync(cfg.smsArchiveDir, { recursive: true });
  const dest = path.join(cfg.smsArchiveDir, path.basename(processedPath));
  if (path.resolve(processedPath) === path.resolve(dest)) return; // already archived, re-run for testing
  try {
    fs.renameSync(processedPath, dest);
  } catch (e) {
    fs.copyFileSync(processedPath, dest);
    fs.unlinkSync(processedPath);
  }
  console.log(`Archived: ${path.basename(processedPath)} → ${path.basename(cfg.smsArchiveDir)}/`);
}

let filePath = process.argv[2];
if (!filePath) {
  let cfg;
  try { cfg = require('./pipeline_config.js').loadConfig(); }
  catch (e) {
    console.error('No file given and pipeline.config.json could not be loaded.');
    console.error('Either pass a file explicitly: node scripts/build_sms_analyzer.js "<path to SMS_Campaign_*.xlsx>"');
    console.error('or run: node scripts/setup_config.js');
    process.exit(1);
  }
  filePath = findLatestInDownloads(cfg.downloadsDir);
  if (!filePath) {
    console.log(`No SMS_Campaign_*.xlsx file found in ${cfg.downloadsDir}. Nothing to do.`);
    process.exit(0);
  }
} else if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}
const fileName = path.basename(filePath);
console.log(`Reading ${fileName}…`);

const wb = XLSX.readFile(filePath);
if (!wb.SheetNames.includes('Raw Data')) {
  console.error(`ERROR: expected a "Raw Data" sheet, found: ${wb.SheetNames.join(', ')}`);
  process.exit(1);
}
const raw = XLSX.utils.sheet_to_json(wb.Sheets['Raw Data'], { defval: '' });
console.log(`Parsed ${raw.length.toLocaleString()} raw rows`);

function excelSerialToYMD(serial) {
  if (typeof serial !== 'number') return null;
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function toYMD(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// --- Cross-reference against the live Acquisition dataset by StagingID
// (the `id` column here IS the Acquisition StagingID) -- per explicit
// request, to answer "did we send an SMS to this person, and what
// actually happened to their application" using the freshest available
// outcome, not just the snapshot frozen into this SMS export at pull
// time. Confirmed 2026-09-15: only ~65% of SMS rows match a StagingID in
// Acquisition (the rest never reached master, consistent with a blank
// SubmittedToMaster), and the live-matched booked count can come out
// LOWER than the export's own Status_In_Master count -- some
// applications that were booked when this SMS file was pulled have
// since reversed to Cancelled (see Acquisition_Command_Dashboard.html's
// "Booked, then Cancelled" KPI for the same phenomenon). Both the
// export's own snapshot status and the live cross-referenced status are
// kept per row so neither is silently discarded.
// Also builds a CivilID -> [applications] map in the same pass (sorted by
// submitted date), used by the bulk "SMS Sent" list files below -- those
// only carry CivilID + phone + send date, no StagingID, so they can only
// be cross-referenced by CivilID. A CivilID can have multiple
// applications over time, so each SMS-sent record is matched to the
// earliest application submitted ON OR AFTER that SMS's send date (the
// one plausibly caused by it), not just "any" application for that person.
function loadAcquisitionData() {
  const acqPath = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
  if (!fs.existsSync(acqPath)) {
    console.warn('  Acquisition_for_Loans_all_merged.csv not found -- skipping live cross-reference (submitted/booked will use only this SMS export\'s own snapshot fields; bulk SMS-sent files will show 0 matches).');
    return { stagingMap: null, civilIdMap: null };
  }
  console.log('Reading Acquisition_for_Loans_all_merged.csv for cross-reference…');
  const { readCsv } = require('./update_acquisition_dashboard.js');
  const acqRows = readCsv(acqPath);
  const stagingMap = new Map();
  const civilIdMap = new Map();
  acqRows.forEach(r => {
    const sid = String(r['StagingID'] || '').trim();
    if (sid) stagingMap.set(sid, r);
    const cid = String(r['CivilID'] || '').trim();
    if (!cid) return;
    if (!civilIdMap.has(cid)) civilIdMap.set(cid, []);
    civilIdMap.get(cid).push(r);
  });
  civilIdMap.forEach(list => list.sort((a, b) => (toYMD(a['submitted']) || '').localeCompare(toYMD(b['submitted']) || '')));
  console.log(`  ${acqRows.length.toLocaleString()} Acquisition rows -> ${stagingMap.size.toLocaleString()} unique StagingIDs, ${civilIdMap.size.toLocaleString()} unique CivilIDs`);
  return { stagingMap, civilIdMap };
}
const { stagingMap, civilIdMap } = loadAcquisitionData();

// For a CivilID + a reference date (e.g. SMS send date), find the best
// matching Acquisition application: the earliest one submitted on or
// after that date; if none qualify, fall back to the most recent
// application overall (still useful context, just not attributable to
// this specific SMS).
function bestAcqMatch(civilId, sinceDate) {
  const list = civilIdMap ? civilIdMap.get(civilId) : null;
  if (!list || !list.length) return { row: null, afterSms: false };
  if (sinceDate) {
    const after = list.find(r => (toYMD(r['submitted']) || '') >= sinceDate);
    if (after) return { row: after, afterSms: true };
  }
  return { row: list[list.length - 1], afterSms: false };
}

// --- Per-row enrichment + per-campaign breakdown ---
const campaigns = {};
const overall = { submitted: 0, submittedToMaster: 0, approved: 0, booked: 0, bookedAmount: 0, cancelled: 0, declined: 0 };
let matchedCount = 0;
const rowsOut = [];
raw.forEach(r => {
  const c = String(r.CampaignName || 'Unknown').trim() || 'Unknown';
  if (!campaigns[c]) campaigns[c] = { submitted: 0, submittedToMaster: 0, approved: 0, booked: 0, bookedAmount: 0, cancelled: 0, declined: 0, byDate: {}, statusBreakdown: {} };
  const b = campaigns[c];
  const staleStatus = String(r.Status_In_Master || '').trim();
  const staleAmount = parseFloat(r.Amount) || 0;
  const stagingId = String(r.id || '').trim();
  const civilId = String(r.CivilId || '').trim();
  const smsDate = excelSerialToYMD(r.SMS_Delivered_Date);

  const acq = stagingMap ? stagingMap.get(stagingId) : null;
  const matched = !!acq;
  if (matched) matchedCount++;
  // Live status wins when a match exists; fall back to this export's own
  // snapshot otherwise (e.g. still Sales Vetting, never reached master).
  const status = matched ? String(acq['Altitudestatus'] || '').trim() : staleStatus;
  const booked = BOOKED_SET.has(status);
  const amount = matched ? (parseFloat(acq['ItemValue']) || 0) : staleAmount;
  const submittedDate = matched ? toYMD(acq['submitted']) : (r.SubmittedToMaster ? excelSerialToYMD(r.SubmittedToMaster) : null);
  const bookedDate = booked ? (matched ? toYMD(acq['SalesCompletedDate']) : null) : null;

  b.submitted++; overall.submitted++;
  if (r.SubmittedToMaster) { b.submittedToMaster++; overall.submittedToMaster++; }
  if (r.FinalApprovalFlag === 'Y') { b.approved++; overall.approved++; }
  if (booked) { b.booked++; b.bookedAmount += amount; overall.booked++; overall.bookedAmount += amount; }
  if (status === 'Cancelled [X]') { b.cancelled++; overall.cancelled++; }
  if (status === 'Declined [D]') { b.declined++; overall.declined++; }

  if (smsDate) b.byDate[smsDate] = (b.byDate[smsDate] || 0) + 1;
  const stKey = status || '(not submitted to master)';
  b.statusBreakdown[stKey] = (b.statusBreakdown[stKey] || 0) + 1;

  // Deep-dive fields (added 2026-09-21): product, credit decision, staging stage,
  // final-approval flag, created date/hour and days from SMS delivery to creation.
  const cSerial = parseFloat(r.Created);
  const createdDate = cSerial ? excelSerialToYMD(Math.floor(cSerial)) : null;
  const createdHour = cSerial ? Math.floor((cSerial - Math.floor(cSerial)) * 24) : null;
  const lagDays = (createdDate && smsDate) ? Math.round((Date.parse(createdDate) - Date.parse(smsDate)) / 86400000) : null;
  rowsOut.push({
    civilId, stagingId, campaign: c, smsDate,
    matched, status, booked,
    submittedDate, bookedDate, amount,
    prod: String(r.LoanTypeDesc || '').trim(),
    dec: String(r.DE_Decision || '').trim(),
    stg: String(r.StagingStatus || '').trim(),
    fa: r.FinalApprovalFlag === 'Y',
    tm: !!r.SubmittedToMaster,
    created: createdDate, hr: createdHour, lag: lagDays,
  });
});

console.log('Per-campaign breakdown (live cross-referenced where matched):');
Object.entries(campaigns).forEach(([name, b]) => {
  console.log(`  ${name}: submitted=${b.submitted} toMaster=${b.submittedToMaster} approved=${b.approved} booked=${b.booked} (SAR ${Math.round(b.bookedAmount).toLocaleString()})`);
});
console.log(`Matched against live Acquisition data: ${matchedCount.toLocaleString()} / ${raw.length.toLocaleString()}`);

// --- Summary sheet (vendor monthly rollup, reproduced as-is) ---
let summaryTrend = [];
if (wb.SheetNames.includes('Summary')) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Summary'], { defval: '', header: 1 });
  const header = rows[0] || [];
  const idx = k => header.indexOf(k);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    summaryTrend.push({
      month: r[idx('SMS_delivered_month')],
      campaign: r[idx('Campaign_name')],
      duration: r[idx('Data_duration')],
      submissions: r[idx('Total_submissions')],
      approvals: r[idx('Total_final_approvals')],
      bookings: r[idx('Total_bookings')],
    });
  }
  summaryTrend.sort((a, b) => String(a.month).localeCompare(String(b.month)) || String(a.campaign).localeCompare(String(b.campaign)));
  console.log(`Summary sheet: ${summaryTrend.length} rows reproduced`);
}

const dateRange = (() => {
  let min = null, max = null;
  raw.forEach(r => {
    const d = excelSerialToYMD(r.SMS_Delivered_Date);
    if (!d) return;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  });
  return { min, max };
})();

// --- Bulk "SMS Sent" recipient-list files -- CivilID + phone + send date
// only, no application outcome (unlike the row-per-application file above,
// these are row-per-RECIPIENT, i.e. the true denominator: everyone an SMS
// actually went to, not just the ones who went on to apply). Kept as a
// SEPARATE section rather than merged into `campaigns` above, since the
// two have fundamentally different denominators and merging them under
// the same campaign name would misrepresent the smaller, application-level
// numbers as if they were rates over the full send list. Auto-discovers
// every xlsx in `smsSentListsDir` (pipeline.config.json) each run -- these
// files are a standing reference library, not consumed/archived like the
// daily application-level export, so they're always reprocessed fresh
// rather than moved. Given the volume (500K+ rows in a single file,
// confirmed 2026-09-15), only aggregate stats are embedded -- raw
// per-recipient rows (with real phone numbers) are never shipped to the
// client, unlike the smaller `rows` array above.
const CIVIL_ID_COLS = ['CivilID', 'CivilId', 'civilID', 'Civil ID'];
const PHONE_COLS = ['Mobile Phone', 'Mobile number', 'MobilePhone', 'Phone'];
const DATE_COLS = ['Date of SMS', 'Date'];
function firstPresentCol(row, candidates) {
  for (const c of candidates) if (row[c] !== undefined) return c;
  return null;
}
function campaignNameFromFilename(fname) {
  return fname.replace(/\.xlsx$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function processSmsSentFile(filePath) {
  const fname = path.basename(filePath);
  console.log(`Reading SMS-sent list ${fname}…`);
  const fwb = XLSX.readFile(filePath);
  const sheetName = fwb.SheetNames[0];
  const frows = XLSX.utils.sheet_to_json(fwb.Sheets[sheetName], { defval: '' });
  if (!frows.length) { console.warn(`  ${fname}: empty, skipping`); return null; }

  const cidCol = firstPresentCol(frows[0], CIVIL_ID_COLS);
  const dateCol = firstPresentCol(frows[0], DATE_COLS);
  if (!cidCol || !dateCol) {
    console.warn(`  ${fname}: couldn't find a CivilID/date column (columns: ${Object.keys(frows[0]).join(', ')}) -- skipping`);
    return null;
  }

  const stat = { smsSent: 0, uniqueRecipients: new Set(), matchedAny: 0, submitted: 0, booked: 0, bookedAmount: 0, byDate: {} };
  const bucket = d => stat.byDate[d] || (stat.byDate[d] = { smsSent: 0, matchedAny: 0, submitted: 0, booked: 0, bookedAmount: 0 });
  frows.forEach(r => {
    const civilId = String(r[cidCol] || '').trim();
    if (!civilId) return;
    const smsDate = excelSerialToYMD(r[dateCol]);
    stat.smsSent++;
    stat.uniqueRecipients.add(civilId);
    const db = smsDate ? bucket(smsDate) : null;
    if (db) db.smsSent++;

    const { row: acq, afterSms } = bestAcqMatch(civilId, smsDate);
    if (acq) { stat.matchedAny++; if (db) db.matchedAny++; }
    if (acq && afterSms) {
      stat.submitted++;
      if (db) db.submitted++;
      const status = String(acq['Altitudestatus'] || '').trim();
      if (BOOKED_SET.has(status)) {
        stat.booked++;
        stat.bookedAmount += parseFloat(acq['ItemValue']) || 0;
        if (db) { db.booked++; db.bookedAmount += parseFloat(acq['ItemValue']) || 0; }
      }
    }
  });

  const dates = Object.keys(stat.byDate).sort();
  console.log(`  ${fname}: ${stat.smsSent.toLocaleString()} sent, ${stat.matchedAny.toLocaleString()} matched any app, ${stat.submitted.toLocaleString()} submitted after SMS, ${stat.booked.toLocaleString()} booked (SAR ${Math.round(stat.bookedAmount).toLocaleString()})`);

  return {
    name: campaignNameFromFilename(fname),
    sourceFile: fname,
    smsSent: stat.smsSent,
    uniqueRecipients: stat.uniqueRecipients.size,
    matchedAny: stat.matchedAny,
    submitted: stat.submitted,
    booked: stat.booked,
    bookedAmount: stat.bookedAmount,
    dateMin: dates[0] || null,
    dateMax: dates[dates.length - 1] || null,
    byDate: stat.byDate,
  };
}

let smsSentCampaigns = [];
try {
  const cfg = require('./pipeline_config.js').loadConfig();
  if (cfg.smsSentListsDir && fs.existsSync(cfg.smsSentListsDir)) {
    const files = fs.readdirSync(cfg.smsSentListsDir).filter(f => /\.xlsx$/i.test(f));
    console.log(`Scanning smsSentListsDir (${files.length} xlsx file(s))…`);
    files.forEach(f => {
      const result = processSmsSentFile(path.join(cfg.smsSentListsDir, f));
      if (result) smsSentCampaigns.push(result);
    });
  }
} catch (e) {
  console.warn(`  (skipping SMS-sent list scan -- ${e.message})`);
}

const SMS_DATA = {
  meta: {
    sourceFile: fileName,
    generatedAt: new Date().toISOString(),
    totalRows: raw.length,
    deliveredMin: dateRange.min,
    deliveredMax: dateRange.max,
    matchedInAcquisition: matchedCount,
    hasLiveCrossReference: !!stagingMap,
  },
  overall,
  campaigns,
  summaryTrend,
  rows: rowsOut,
  smsSentCampaigns,
};

// --- Render page ---
const html = buildHtml(SMS_DATA);
// Write via temp-file + rename, not an in-place writeFileSync -- this
// OneDrive-synced folder has repeatedly (confirmed across multiple scripts,
// e.g. build_simah_datechunks.js) intermittently failed an in-place
// truncate with UNKNOWN/EPERM. A fresh temp file is a plain create, never
// a truncate of a synced file, so renaming over the target sidesteps it.
const tmpHtml = `${HTML_FILE}.tmp`;
fs.writeFileSync(tmpHtml, html, 'utf-8');
for (let attempt = 1; ; attempt++) {
  try { fs.renameSync(tmpHtml, HTML_FILE); break; }
  catch (e) {
    if (attempt >= 5) throw e;
    console.warn(`  rename attempt ${attempt} failed (${e.code}), retrying…`);
    const until = Date.now() + attempt * 500;
    while (Date.now() < until) { /* busy-wait: this script has no async loop */ }
  }
}
console.log(`✅ SMS_Analyzer.html written — ${Object.keys(campaigns).length} campaigns, ${raw.length.toLocaleString()} rows.`);
archiveProcessedFile(filePath);

function buildHtml(data) {
  const dataJson = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tasheel · SMS Analyzer</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#eef1f7;--panel:#fff;--panel2:#f7f8fb;--line:rgba(30,45,75,.10);--line2:rgba(30,45,75,.17);
 --ink:#141c2b;--ink2:#3a475e;--muted:#5b6b83;--faint:#8493a8;
 --cyan:#0e9e90;--cyan-d:#0b7d72;--gold:#bd7d12;--gold-d:#9a6410;--violet:#6f5be0;--red:#c0392b;--green:#1c7d50;}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:radial-gradient(1200px 700px at 82% -12%,rgba(14,158,144,.10),transparent 60%),radial-gradient(1000px 600px at -5% 5%,rgba(189,125,18,.09),transparent 55%),var(--bg);
 color:var(--ink);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3,.disp{font-family:'Space Grotesk',sans-serif}
a{color:var(--cyan-d)}
header{padding:20px 26px;display:flex;align-items:center;gap:13px;justify-content:space-between;flex-wrap:wrap}
.hleft{display:flex;align-items:center;gap:13px}
.logo{width:38px;height:38px;border-radius:10px;position:relative;background:conic-gradient(from 210deg,var(--cyan),var(--gold),var(--cyan))}
.logo::after{content:"";position:absolute;inset:5px;border-radius:6px;background:#fff}
.logo::before{content:"↗";position:absolute;inset:0;display:grid;place-items:center;z-index:2;font-family:'Space Grotesk';font-weight:700;color:var(--cyan);font-size:18px}
.brand .t{font-family:'Space Grotesk';font-weight:700;font-size:17px}
.brand .s{font-size:10.5px;color:var(--muted);letter-spacing:.13em;text-transform:uppercase;margin-top:1px}
.home-link{font-size:12.5px;color:var(--muted);text-decoration:none;display:flex;align-items:center;gap:5px;font-weight:600}
.home-link:hover{color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:6px 26px 60px}
.hint{font-size:11.5px;color:var(--faint);margin:2px 0 20px}
.section{margin-bottom:34px}
.sec-h{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.sec-h h2{font-size:16px;margin:0}
.sec-h .n{font-size:10px;color:var(--faint);font-family:'JetBrains Mono'}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:0 2px 4px rgba(20,30,50,.03)}
.card .lab{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin-bottom:6px}
.card .big{font-size:24px;font-weight:700;font-family:'Space Grotesk'}
.card .sub{font-size:11px;color:var(--faint);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--panel);border-radius:12px;overflow:hidden;border:1px solid var(--line)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line)}
th{background:var(--panel2);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-family:'JetBrains Mono'}
.campname{font-weight:700;font-family:'Space Grotesk'}
.rate-good{color:var(--green);font-weight:700}
.rate-bad{color:var(--red);font-weight:700}
.bar-wrap{background:var(--panel2);border-radius:6px;height:6px;overflow:hidden;margin-top:6px}
.bar{height:100%;background:linear-gradient(90deg,var(--cyan),var(--cyan-d));border-radius:6px}
.foot{text-align:center;color:var(--faint);font-size:11px;font-family:'JetBrains Mono';padding:22px}
.tablewrap{overflow-x:auto}
.camp-block{margin-bottom:22px}
.camp-block:last-child{margin-bottom:0}
.camp-block h3{font-size:13px;margin:0 0 10px;font-family:'Space Grotesk';display:flex;align-items:center;gap:8px}
.camp-block h3 .n{font-size:10px;color:var(--faint);font-weight:400;font-family:'JetBrains Mono'}
.filters{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
.filter-row{display:flex;flex-wrap:wrap;gap:14px;align-items:end}
.filter-item{display:flex;flex-direction:column;gap:5px}
.filter-item label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.filter-item select,.filter-item input{padding:7px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);color:var(--ink);font-family:'Inter',sans-serif;font-size:12.5px}
.filter-item input[type="date"]{font-family:'JetBrains Mono'}
.filter-reset{padding:7px 14px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}
.filter-reset:hover{color:var(--ink);border-color:var(--line)}
.search-box{display:flex;flex-direction:column;gap:5px;flex:1;min-width:220px}
.results-row{display:flex;gap:14px;margin:16px 0}
.results-row .card{flex:1}
.match-badge{display:inline-block;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.03em}
.match-badge.live{background:rgba(28,125,80,.12);color:var(--green)}
.match-badge.stale{background:rgba(189,125,18,.12);color:var(--gold-d)}
.row-limit-note{font-size:11px;color:var(--faint);margin-top:8px}

/* ===== v2 structure (2026-09-21): sticky bar, tabs, outcome hero ===== */
.top{position:sticky;top:0;z-index:30;background:rgba(238,241,247,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top-in{max-width:1180px;margin:0 auto;padding:12px 26px 8px;display:flex;align-items:center;gap:14px 22px;flex-wrap:wrap}
.top-in .hleft{flex:0 0 auto}
.top-src{flex:1 1 260px;font-size:11.5px;color:var(--muted);font-family:'JetBrains Mono';line-height:1.5}
.top-ctl{display:flex;align-items:center;gap:10px;margin-left:auto}
.top-ctl label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
.top-ctl select{padding:7px 12px;border:1px solid var(--line2);border-radius:9px;background:var(--panel);color:var(--ink);font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:13px;min-width:170px}
.top-ctl select:focus-visible,.tabs button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.tabs{max-width:1180px;margin:0 auto;padding:0 26px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{appearance:none;border:0;background:none;cursor:pointer;padding:10px 16px 11px;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:13.5px;color:var(--muted);border-bottom:2.5px solid transparent;white-space:nowrap}
.tabs button:hover{color:var(--ink)}
.tabs button.on{color:var(--ink);border-bottom-color:var(--cyan)}
.tabs button .cnt{font-family:'JetBrains Mono';font-size:10px;color:var(--faint);margin-left:6px}
.panel{display:none}.panel.on{display:block;animation:pfade .25s ease}
@keyframes pfade{from{opacity:.4;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.panel.on{animation:none}}
.hero{padding:22px 24px 20px;margin-bottom:22px;border-radius:16px}
.eyebrow{font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:700}
.hero-h{font-family:'Space Grotesk',sans-serif;font-size:27px;line-height:1.25;font-weight:600;margin:6px 0 16px;letter-spacing:-.01em}
.hero-h b{color:var(--cyan-d);font-weight:700}
.obar{display:flex;height:46px;border-radius:10px;overflow:hidden;background:var(--panel2);box-shadow:inset 0 0 0 1px var(--line)}
.oseg{display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono';font-size:11.5px;font-weight:700;color:#fff;min-width:2px;transition:filter .15s}
.oseg:hover{filter:brightness(1.08)}
.oseg.lt{color:var(--ink2)}
.olegend{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:12px}
.oleg{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink2)}
.oleg i{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
.oleg b{font-family:'JetBrains Mono';font-weight:700;color:var(--ink)}
.oleg span{color:var(--faint);font-family:'JetBrains Mono';font-size:11.5px}
.onote{margin:14px 0 0;font-size:12.5px;color:var(--muted);line-height:1.6}
.insights{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.insights li{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--cyan);border-radius:10px;padding:12px 16px;font-size:13.5px;line-height:1.6;color:var(--ink2)}
.insights li b{color:var(--ink)}
.insights li.warn{border-left-color:var(--gold)}
.panel .sec-h{margin-top:4px}
.vchart svg{width:100%;height:auto;display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px}
.vleg{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--ink2);margin:8px 2px 16px}
.vleg i{display:inline-block;width:18px;border-top:3px solid;vertical-align:middle;margin-right:6px}
main{padding-top:22px}
#ov-kpis{grid-template-columns:repeat(6,minmax(0,1fr))}
@media (max-width:1020px){#ov-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:560px){#ov-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
#ov-kpis .card .big{font-size:21px}
.hist-why{border:1px dashed var(--line2);border-radius:12px;padding:14px 18px;background:var(--panel2);font-size:13.5px;line-height:1.65;margin:0 0 18px;color:var(--ink2)}
.hist-why b{color:var(--ink)}
@media (max-width:640px){.hero-h{font-size:21px}.top-ctl{margin-left:0;width:100%}.top-ctl select{flex:1}.obar{height:40px}}
</style></head>
<body>
<div class="top">
  <div class="top-in">
    <div class="hleft">
      <div class="logo"></div>
      <div class="brand"><div class="t">SMS Analyzer</div><div class="s">Tasheel Finance · Campaign Performance</div></div>
    </div>
    <div class="top-src" id="source-hint"></div>
    <div class="top-ctl">
      <label for="dd-campaign">Campaign</label>
      <select id="dd-campaign"><option value="">All campaigns</option></select>
      <a class="home-link" href="index.html">← Home</a>
    </div>
  </div>
  <nav class="tabs" id="tabs" aria-label="Sections">
    <button type="button" data-tab="overview" class="on">Overview</button>
    <button type="button" data-tab="conversion">Conversion</button>
    <button type="button" data-tab="timing">Timing &amp; size</button>
    <button type="button" data-tab="sendlists" id="tab-btn-sendlists">Send lists</button>
    <button type="button" data-tab="history" id="tab-btn-history">Campaign history</button>
    <button type="button" data-tab="find">Find applications</button>
  </nav>
</div>
<main>

<section class="panel on" id="tab-overview">
  <div class="card hero">
    <div class="eyebrow">What happened to every application</div>
    <div class="hero-h" id="hero-h"></div>
    <div class="obar" id="outcome-bar" role="img" aria-label="Outcome of every application"></div>
    <div class="olegend" id="outcome-legend"></div>
    <p class="onote" id="outcome-note"></p>
  </div>
  <div class="kpis" id="ov-kpis" style="margin-bottom:26px"></div>
  <div class="section">
    <div class="sec-h"><h2>What stands out</h2><span class="n">worked out from the selected campaign</span></div>
    <ul class="insights" id="ov-insights"></ul>
  </div>
  <div class="section">
    <div class="sec-h"><h2>Campaigns side by side</h2><span class="n">applications created from SMS links · this export</span></div>
    <div class="tablewrap"><table id="campaign-table"></table></div>
  </div>
</section>

<section class="panel" id="tab-conversion">
  <div class="camp-block"><h3>Conversion funnel <span class="n">created → master → final approved → booked</span></h3><div id="dd-funnel"></div></div>
  <div class="camp-block"><h3>Product mix <span class="n">which loan type people apply for, and which one converts</span></h3><div id="dd-product"></div></div>
  <div class="camp-block"><h3>Credit decision <span class="n">the decision engine's verdict on each application</span></h3><div id="dd-decision"></div></div>
  <div class="camp-block"><h3>Where applications sit in staging <span class="n">StagingStatus</span></h3><div id="dd-stage"></div></div>
  <div class="camp-block"><h3>Final status <span class="n">live master status where matched, otherwise this export's snapshot</span></h3><div id="dd-status"></div></div>
</section>

<section class="panel" id="tab-timing">
  <div class="kpis" id="dd-kpis" style="margin-bottom:22px"></div>
  <div class="camp-block"><h3>Time to apply <span class="n">days from SMS delivery to application created</span></h3><div id="dd-lag"></div></div>
  <div class="camp-block"><h3>Time of day <span class="n">hour the application was created</span></h3><div id="dd-hour"></div></div>
  <div class="camp-block"><h3>Daily trend <span class="n">by application created date</span></h3><div id="dd-trend"></div></div>
  <div class="camp-block"><h3>Ticket size of booked loans <span class="n">amount is only recorded once a loan is allocated, so this covers booked loans only</span></h3><div id="dd-amount"></div></div>
</section>

<section class="panel" id="tab-sendlists">
<div class="section" id="sent-section">
  <div class="sec-h"><h2>SMS Sent Campaigns</h2><span class="n">true send lists · cross-referenced by Civil ID</span></div>
  <div class="hint">These campaigns cover every person an SMS actually went to (not just the ones who went on to apply) — a different, larger denominator than "Campaign performance" above. "Submitted" and "Booked" here require an Acquisition application matched by Civil ID and submitted on or after the SMS send date, so a coincidental unrelated earlier application doesn't get credited to the SMS. Aggregate only — with send lists this size, individual recipient rows (real phone numbers) aren't shipped to this page.</div>
  <div class="tablewrap"><table id="sent-campaign-table"></table></div>
</div>

</section>

<section class="panel" id="tab-history">
<div class="section" id="trend-section">
  <div class="sec-h"><h2>Campaign history by month</h2><span class="n">the vendor’s own monthly report · every wave, not just the latest</span></div>
  <p class="hist-why"><b>Why this tab exists.</b> Everything else on this page comes from the latest export, which holds only the current campaign wave. The SMS vendor also reports every earlier wave, month by month. This tab keeps that history so you can compare waves over time, and it checks the vendor’s numbers against this export.</p>
  <ul class="insights" id="hist-insights"></ul>
  <div class="camp-block"><h3>Volume by month <span class="n">vendor counts, all campaigns combined</span></h3><div id="vendor-chart"></div></div>
  <div class="camp-block"><h3>Vendor report vs this export <span class="n">latest wave, same campaign and month</span></h3><div class="tablewrap"><table id="hist-recon"></table></div></div>
  <div class="camp-block"><h3>Full monthly report <span class="n">as reported by the vendor, with the approval rate worked out</span></h3><div class="tablewrap"><table id="trend-table"></table></div></div>
</div>
</section>

<section class="panel" id="tab-find">
<div class="section">
  <div class="sec-h"><h2>Lookup &amp; filter</h2><span class="n">Submitted → Booked, sliced by campaign / SMS date / submitted date / booked date</span></div>
  <div class="hint" id="crossref-hint"></div>
  <div class="filters">
    <div class="filter-row">
      <div class="search-box">
        <label for="f-search">Civil ID lookup</label>
        <input type="text" id="f-search" placeholder="Type a full or partial Civil ID…">
      </div>
      <div class="filter-item">
        <label for="f-campaign">Campaign</label>
        <select id="f-campaign"><option value="">All campaigns</option></select>
      </div>
      <div class="filter-item">
        <label for="f-smsdate">SMS sent date</label>
        <select id="f-smsdate"><option value="">All dates</option></select>
      </div>
      <div class="filter-item"><label for="f-sub-from">Submitted date</label><input type="date" id="f-sub-from"></div>
      <div class="filter-item"><label for="f-book-from">Booked date</label><input type="date" id="f-book-from"></div>
      <button class="filter-reset" id="f-reset">Reset filters</button>
    </div>
  </div>
  <div class="results-row" id="filter-kpis"></div>
  <div class="hint">Note: "Submitted" here counts a Staging ID as submitted the moment it's found in the live Acquisition dataset (which only contains applications that reached master) — this can be higher than the "Submitted to Master" figure in the Overview section above, which relies only on this export's own snapshot flag and can be stale for applications that reached master after the SMS file was pulled.</div>
  <div class="tablewrap"><table id="filter-table"></table></div>
  <div class="row-limit-note" id="filter-row-note"></div>
</div>

</section>

</main>
<div class="foot">Built for <a href="https://www.linkedin.com/in/emadayyash" target="_blank">Emad Ayyash</a> · Tasheel Finance</div>
<script>
const SMS_DATA = ${dataJson};

function fmt(n){ return (n==null||isNaN(n))?'—':Math.round(n).toLocaleString(); }
function money(n){ return (n==null||isNaN(n))?'—':'SAR '+Math.round(n).toLocaleString(); }
function pct(n){ return (n==null||isNaN(n))?'—':n.toFixed(1)+'%'; }
function prettyMonth(m){
  const s=String(m); if(s.length!==6) return s;
  const y=s.slice(0,4), mo=parseInt(s.slice(4,6),10);
  const names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return names[mo-1]+' '+y;
}

// ===== Deep dive (added 2026-09-21): product, decision, stage, timing, ticket, trend =====
// Everything below is computed client-side from SMS_DATA.rows (the export's own
// columns: LoanTypeDesc, DE_Decision, StagingStatus, Created, Amount) plus the
// live/snapshot status already resolved per row. Booking rate = Booked / Created.
var DD_LAG=[['Same day',0,0],['1–3 days',1,3],['4–7 days',4,7],['8–14 days',8,14],['15–30 days',15,30],['Over 30 days',31,99999]];
var DD_AMT=[['No amount recorded',0,0],['Under SAR 10K',0.01,9999.99],['SAR 10K–25K',10000,24999.99],['SAR 25K–50K',25000,49999.99],['SAR 50K–100K',50000,99999.99],['SAR 100K and above',100000,1e12]];
function ddRows(){var c=document.getElementById('dd-campaign').value;return SMS_DATA.rows.filter(function(r){return !c||r.campaign===c;});}
function ddAgg(list){var o={n:list.length,tm:0,fa:0,bk:0,val:0};list.forEach(function(r){if(r.tm)o.tm++;if(r.fa)o.fa++;if(r.booked){o.bk++;o.val+=r.amount||0;}});return o;}
function ddBar(p,color){return '<div class="bar-wrap"><div class="bar" style="width:'+Math.max(0,Math.min(100,p)).toFixed(1)+'%'+(color?';background:'+color:'')+'"></div></div>';}
function ddBreakdown(rows,keyFn,label,order){
  var m={};rows.forEach(function(r){var k=keyFn(r);if(k==null)return;(m[k]||(m[k]=[])).push(r);});
  var keys=order||Object.keys(m).sort(function(a,b){return m[b].length-m[a].length;});
  keys=keys.filter(function(k){return m[k];});
  var tot=rows.length||1;
  var h='<tr><th>'+label+'</th><th class="num">Applications</th><th>Share</th><th class="num">To master</th><th class="num">Final approved</th><th class="num">Booked</th><th class="num">Booking rate</th><th class="num">Booked value</th><th class="num">Avg ticket</th></tr>';
  var b=keys.map(function(k){var a=ddAgg(m[k]);var rate=a.n?a.bk/a.n*100:0;
    return '<tr><td class="campname">'+k+'</td><td class="num">'+fmt(a.n)+'</td><td style="min-width:120px">'+pct(a.n/tot*100)+ddBar(a.n/tot*100)+'</td><td class="num">'+fmt(a.tm)+'</td><td class="num">'+fmt(a.fa)+'</td><td class="num">'+fmt(a.bk)+'</td><td class="num '+(rate>=10?'rate-good':(rate<3?'rate-bad':''))+'">'+pct(rate)+'</td><td class="num">'+money(a.val)+'</td><td class="num">'+(a.bk?money(a.val/a.bk):'—')+'</td></tr>';}).join('');
  return '<div class="tablewrap"><table>'+h+b+'</table></div>';
}
function ddFunnel(rows){
  var a=ddAgg(rows);var steps=[['Applications created',a.n],['Submitted to master',a.tm],['Final approved',a.fa],['Booked',a.bk]];
  return '<div class="tablewrap"><table><tr><th>Step</th><th class="num">Count</th><th class="num">% of created</th><th class="num">% of previous step</th><th>Drop-off</th></tr>'+
  steps.map(function(s,i){var pc=a.n?s[1]/a.n*100:0;var pp=i?(steps[i-1][1]?s[1]/steps[i-1][1]*100:0):100;
    return '<tr><td class="campname">'+s[0]+'</td><td class="num">'+fmt(s[1])+'</td><td class="num">'+pct(pc)+'</td><td class="num">'+(i?pct(pp):'—')+'</td><td style="min-width:200px">'+ddBar(pc)+'</td></tr>';}).join('')+'</table></div>';
}
function ddHourChart(rows){
  var c=[],b=[],h;for(h=0;h<24;h++){c.push(0);b.push(0);}
  rows.forEach(function(r){if(r.hr!=null){c[r.hr]++;if(r.booked)b[r.hr]++;}});
  var W=760,H=210,L=42,B=26,T=14,mx=Math.max.apply(null,c)||1,bw=(W-L-10)/24;
  var s='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto" role="img" aria-label="Applications by hour of day">';
  for(var k=0;k<=4;k++){var y=T+(H-T-B)*(1-k/4);s+='<line x1="'+L+'" x2="'+(W-10)+'" y1="'+y+'" y2="'+y+'" stroke="rgba(30,45,75,.10)"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="#8493a8">'+Math.round(mx*k/4)+'</text>';}
  for(h=0;h<24;h++){var x=L+h*bw+2,ha=(H-T-B)*c[h]/mx,hb=(H-T-B)*b[h]/mx;
    s+='<rect x="'+x.toFixed(1)+'" y="'+(H-B-ha).toFixed(1)+'" width="'+(bw-4).toFixed(1)+'" height="'+ha.toFixed(1)+'" fill="#0e9e90" opacity=".85"><title>'+h+':00 · '+c[h]+' applications · '+b[h]+' booked</title></rect>';
    s+='<rect x="'+x.toFixed(1)+'" y="'+(H-B-hb).toFixed(1)+'" width="'+(bw-4).toFixed(1)+'" height="'+hb.toFixed(1)+'" fill="#bd7d12"/>';
    if(h%3===0)s+='<text x="'+(x+(bw-4)/2).toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#8493a8">'+h+'h</text>';}
  return s+'</svg><div class="hint" style="margin:4px 0 0"><span style="color:#0e9e90">■</span> applications created · <span style="color:#bd7d12">■</span> of which booked · hour as recorded in the export (no timezone conversion)</div>';
}
function ddTrendChart(rows){
  var m={};rows.forEach(function(r){if(!r.created)return;var o=m[r.created]||(m[r.created]={n:0,b:0});o.n++;if(r.booked)o.b++;});
  var days=Object.keys(m).sort();if(!days.length)return '<p class="hint">No dated applications.</p>';
  var W=760,H=220,L=42,R=14,T=14,B=28,mx=1;days.forEach(function(d){if(m[d].n>mx)mx=m[d].n;});
  var X=function(i){return L+(days.length>1?i*(W-L-R)/(days.length-1):(W-L-R)/2);},Y=function(v){return T+(H-T-B)*(1-v/mx);};
  var s='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto" role="img" aria-label="Applications and bookings by created date">';
  for(var k=0;k<=4;k++){var y=Y(mx*k/4);s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="rgba(30,45,75,.10)"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="#8493a8">'+Math.round(mx*k/4)+'</text>';}
  var step=Math.max(1,Math.ceil(days.length/8));
  days.forEach(function(d,i){if(i%step===0||i===days.length-1)s+='<text x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10" fill="#8493a8">'+d.slice(5)+'</text>';});
  var p1='',p2='';days.forEach(function(d,i){p1+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(m[d].n).toFixed(1)+' ';p2+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(m[d].b).toFixed(1)+' ';});
  s+='<path d="'+p1+'" fill="none" stroke="#0e9e90" stroke-width="2.2"/><path d="'+p2+'" fill="none" stroke="#bd7d12" stroke-width="2.2" stroke-dasharray="6 4"/>';
  days.forEach(function(d,i){s+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(m[d].n).toFixed(1)+'" r="2.6" fill="#0e9e90"><title>'+d+' · '+m[d].n+' created · '+m[d].b+' booked</title></circle>';});
  return s+'</svg><div class="hint" style="margin:4px 0 0"><span style="color:#0e9e90">━</span> applications created per day · <span style="color:#bd7d12">┅</span> of which booked (by created date, so recent days are still maturing)</div>';
}
// Ticket size is shown for BOOKED loans only: the amount field is only populated once
// a loan is allocated (live ItemValue is 0 for everything else), so a booking rate per
// amount band would be circular.
function ddTicket(rows){
  var bk=rows.filter(function(r){return r.booked&&r.amount>0;});
  var totV=bk.reduce(function(s,r){return s+r.amount;},0)||1,totN=bk.length||1;
  var bands=DD_AMT.slice(1);
  var body=bands.map(function(b){var l=bk.filter(function(r){return r.amount>=b[1]&&r.amount<=b[2];});var v=l.reduce(function(s,r){return s+r.amount;},0);
    return '<tr><td class="campname">'+b[0]+'</td><td class="num">'+fmt(l.length)+'</td><td style="min-width:120px">'+pct(l.length/totN*100)+ddBar(l.length/totN*100)+'</td><td class="num">'+money(v)+'</td><td style="min-width:120px">'+pct(v/totV*100)+ddBar(v/totV*100,'#bd7d12')+'</td><td class="num">'+(l.length?money(v/l.length):'—')+'</td></tr>';}).join('');
  return '<div class="tablewrap"><table><tr><th>Ticket size</th><th class="num">Booked loans</th><th>Share of loans</th><th class="num">Booked value</th><th>Share of value</th><th class="num">Avg ticket</th></tr>'+body+'</table></div>';
}
function ddBand(bands,v){if(v==null||isNaN(v))return null;for(var i=0;i<bands.length;i++){if(v>=bands[i][1]&&v<=bands[i][2])return bands[i][0];}return null;}
function renderDeepDive(){
  var rows=ddRows(),a=ddAgg(rows);
  var lags=rows.map(function(r){return r.lag;}).filter(function(x){return x!=null&&x>=0;}).sort(function(x,y){return x-y;});
  var med=lags.length?lags[Math.floor(lags.length/2)]:null;
  var w7=lags.length?lags.filter(function(x){return x<=7;}).length/lags.length*100:null;
  var hrs=[];for(var h=0;h<24;h++)hrs.push(0);rows.forEach(function(r){if(r.hr!=null)hrs[r.hr]++;});
  var peak=hrs.indexOf(Math.max.apply(null,hrs));
  var kp=[['Applications',fmt(a.n),'in this selection'],['Median time to apply',med==null?'—':med+' days','SMS delivery → application'],['Applied within 7 days',pct(w7),'of applications'],['Avg booked ticket',a.bk?money(a.val/a.bk):'—','booked value ÷ booked'],['Peak hour',hrs[peak]?peak+':00':'—','most applications created']];
  document.getElementById('dd-kpis').innerHTML=kp.map(function(x){return '<div class="card"><div class="lab">'+x[0]+'</div><div class="big">'+x[1]+'</div><div class="sub">'+x[2]+'</div></div>';}).join('');
  document.getElementById('dd-funnel').innerHTML=ddFunnel(rows);
  document.getElementById('dd-product').innerHTML=ddBreakdown(rows,function(r){return r.prod||'(blank)';},'Product');
  document.getElementById('dd-decision').innerHTML=ddBreakdown(rows,function(r){return r.dec||'(blank)';},'Credit decision');
  document.getElementById('dd-stage').innerHTML=ddBreakdown(rows,function(r){return r.stg||'(blank)';},'Pipeline stage');
  document.getElementById('dd-status').innerHTML=ddBreakdown(rows,function(r){return r.status||'(not submitted to master)';},'Final status');
  document.getElementById('dd-lag').innerHTML=ddBreakdown(rows,function(r){return ddBand(DD_LAG,r.lag);},'Time to apply',DD_LAG.map(function(x){return x[0];}));
  document.getElementById('dd-hour').innerHTML=ddHourChart(rows);
  document.getElementById('dd-amount').innerHTML=ddTicket(rows);
  document.getElementById('dd-trend').innerHTML=ddTrendChart(rows);
}
(function(){var sel=document.getElementById('dd-campaign');Object.keys(SMS_DATA.campaigns).sort().forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c;sel.appendChild(o);});sel.addEventListener('change',renderAll);})();

function render(){
  const d = SMS_DATA;
  document.getElementById('source-hint').textContent =
    \`Source: \${d.meta.sourceFile} · \${fmt(d.meta.totalRows)} applications · SMS delivered \${d.meta.deliveredMin} → \${d.meta.deliveredMax}\`;

  // Campaign table
  const campNames = Object.keys(d.campaigns).sort((a,b)=>d.campaigns[b].submitted-d.campaigns[a].submitted);
  let maxSub = Math.max(...campNames.map(c=>d.campaigns[c].submitted), 1);
  let th = '<tr><th>Campaign</th><th class="num">Submitted</th><th class="num">To Master</th><th class="num">Approved</th><th class="num">Booked</th><th class="num">Booking Rate</th><th class="num">Booked Value</th><th>Volume</th></tr>';
  let rows = campNames.map(name=>{
    const b = d.campaigns[name];
    const r = b.submitted ? (b.booked/b.submitted*100) : 0;
    const rateCls = r>=10?'rate-good':(r<3?'rate-bad':'');
    const barPct = (b.submitted/maxSub*100).toFixed(1);
    return \`<tr>
      <td class="campname">\${name}</td>
      <td class="num">\${fmt(b.submitted)}</td>
      <td class="num">\${fmt(b.submittedToMaster)}</td>
      <td class="num">\${fmt(b.approved)}</td>
      <td class="num">\${fmt(b.booked)}</td>
      <td class="num \${rateCls}">\${pct(r)}</td>
      <td class="num">\${money(b.bookedAmount)}</td>
      <td><div class="bar-wrap"><div class="bar" style="width:\${barPct}%"></div></div></td>
    </tr>\`;
  }).join('');
  document.getElementById('campaign-table').innerHTML = th + rows;

  // Campaign history table (vendor Summary sheet) with the approval rate worked out
  if (d.summaryTrend && d.summaryTrend.length) {
    let th2 = '<tr><th>Month</th><th>Campaign</th><th>Wave dates</th><th class="num">Submissions</th><th class="num">Final approvals</th><th class="num">Approval rate</th><th class="num">Vendor bookings</th></tr>';
    let rows2 = d.summaryTrend.map(function(r){
      var ar = (+r.submissions) ? (+r.approvals)/(+r.submissions)*100 : null;
      return '<tr><td>'+prettyMonth(r.month)+'</td><td class="campname">'+r.campaign+'</td><td>'+r.duration+'</td><td class="num">'+fmt(r.submissions)+'</td><td class="num">'+fmt(r.approvals)+'</td><td class="num">'+(ar==null?'—':pct(ar))+'</td><td class="num">'+fmt(r.bookings)+'</td></tr>';
    }).join('');
    document.getElementById('trend-table').innerHTML = th2 + rows2;
  } else {
    document.getElementById('trend-section').style.display = 'none';
  }

  // SMS Sent Campaigns (bulk send lists, aggregate only)
  if (d.smsSentCampaigns && d.smsSentCampaigns.length) {
    let th3 = '<tr><th>Campaign</th><th>Source file</th><th class="num">SMS Sent</th><th class="num">Unique Recipients</th><th class="num">Matched Any App</th><th class="num">Submitted</th><th class="num">Booked</th><th class="num">Booking Rate</th><th class="num">Booked Value</th><th>Date Range</th></tr>';
    let rows3 = d.smsSentCampaigns.map(c=>{
      // Rate is Booked / Submitted (conversion of people who actually
      // applied), matching the Campaign performance table's convention --
      // NOT Booked / SMS Sent, which rounds to ~0.0% for every mass send
      // list regardless of how well it's actually converting.
      const r = c.submitted ? (c.booked/c.submitted*100) : 0;
      const rateCls = r>=10?'rate-good':(r<3?'rate-bad':'');
      return \`<tr>
        <td class="campname">\${c.name}</td>
        <td>\${c.sourceFile}</td>
        <td class="num">\${fmt(c.smsSent)}</td>
        <td class="num">\${fmt(c.uniqueRecipients)}</td>
        <td class="num">\${fmt(c.matchedAny)}</td>
        <td class="num">\${fmt(c.submitted)}</td>
        <td class="num">\${fmt(c.booked)}</td>
        <td class="num \${rateCls}">\${pct(r)}</td>
        <td class="num">\${money(c.bookedAmount)}</td>
        <td>\${c.dateMin||'—'}\${c.dateMax && c.dateMax!==c.dateMin ? ' → '+c.dateMax : ''}</td>
      </tr>\`;
    }).join('');
    document.getElementById('sent-campaign-table').innerHTML = th3 + rows3;
  } else {
    document.getElementById('sent-section').style.display = 'none';
  }

  initLookup(d);
}

// --- Lookup & filter: Civil ID search + Campaign/SMS date/Submitted date/
// Booked date filters over the per-application row data. "Submitted" here
// means the row reached the master Acquisition system at all (has a
// submittedDate); "Booked" uses the live cross-referenced status where a
// StagingID match exists, falling back to this export's own snapshot
// status otherwise -- each row carries a "matched" flag so the table can
// show which one it's using. ---
function initLookup(d){
  const rows = d.rows || [];
  document.getElementById('crossref-hint').textContent = d.meta.hasLiveCrossReference
    ? \`\${fmt(d.meta.matchedInAcquisition)} of \${fmt(d.meta.totalRows)} applications matched against the live Acquisition dataset by Staging ID -- those use the current status/date; unmatched rows (never reached master, or ID not found) fall back to this export's own snapshot fields.\`
    : \`Acquisition_for_Loans_all_merged.csv wasn't found at build time -- every row below uses only this export's own snapshot fields (no live cross-reference). Phone number lookup isn't available -- the source file has no phone column, only Civil ID.\`;

  const sentCampaigns = d.smsSentCampaigns || [];
  const campSel = document.getElementById('f-campaign');
  const appGroup = document.createElement('optgroup'); appGroup.label = 'Campaign performance (per-application)';
  [...new Set(rows.map(r=>r.campaign))].sort().forEach(c=>{
    const o=document.createElement('option'); o.value='app:'+c; o.textContent=c; appGroup.appendChild(o);
  });
  campSel.appendChild(appGroup);
  if (sentCampaigns.length) {
    const sentGroup = document.createElement('optgroup'); sentGroup.label = 'SMS Sent Campaigns (aggregate only)';
    sentCampaigns.forEach(c=>{
      const o=document.createElement('option'); o.value='sent:'+c.name; o.textContent=c.name; sentGroup.appendChild(o);
    });
    campSel.appendChild(sentGroup);
  }
  const smsSel = document.getElementById('f-smsdate');
  const appDates = [...new Set(rows.map(r=>r.smsDate).filter(Boolean))].sort();
  // The SMS Sent Date dropdown's available dates depend on which campaign
  // is selected -- the per-application campaigns and each SMS Sent
  // Campaign each have their own send date(s), so the option list is
  // rebuilt every time the campaign selection changes (see the 'change'
  // listener below), not just populated once at load.
  function refreshSmsDateOptions(campRaw){
    const prev = smsSel.value;
    smsSel.innerHTML = '<option value="">All dates</option>';
    let dates;
    if (campRaw.startsWith('sent:')) {
      const c = sentCampaigns.find(x => 'sent:'+x.name === campRaw);
      dates = c && c.byDate ? Object.keys(c.byDate).sort() : [];
    } else {
      dates = appDates;
    }
    dates.forEach(dt=>{
      const o=document.createElement('option'); o.value=dt; o.textContent=dt; smsSel.appendChild(o);
    });
    smsSel.value = dates.includes(prev) ? prev : '';
  }
  refreshSmsDateOptions('');

  const els = {
    search: document.getElementById('f-search'),
    campaign: document.getElementById('f-campaign'),
    smsdate: document.getElementById('f-smsdate'),
    subFrom: document.getElementById('f-sub-from'),
    bookFrom: document.getElementById('f-book-from'),
  };
  els.campaign.addEventListener('change', () => { refreshSmsDateOptions(els.campaign.value); apply(); });
  const ROW_CAP = 300;

  function apply(){
    const q = els.search.value.trim();
    const campRaw = els.campaign.value;
    const sms = els.smsdate.value;
    const subFrom = els.subFrom.value;
    const bookFrom = els.bookFrom.value;

    // A "sent:" campaign has no per-recipient rows embedded (privacy/size,
    // see the SMS Sent Campaigns section) -- show its aggregate instead of
    // trying to filter non-existent rows.
    if (campRaw.startsWith('sent:')) {
      const name = campRaw.slice(5);
      const c = sentCampaigns.find(x => x.name === name);
      // If a specific SMS Sent Date is picked, show that date's own
      // breakdown (tracked per-date in build_sms_analyzer.js) instead of
      // the campaign's all-time totals -- this is what actually makes the
      // date dropdown affect the numbers for these campaigns.
      const stats = (c && sms && c.byDate && c.byDate[sms]) ? c.byDate[sms] : c;
      // Rate is Booked / Submitted, same convention as the SMS Sent
      // Campaigns table -- Booked / SMS-Sent would round to ~0.0% here.
      const rate = stats && stats.submitted ? (stats.booked/stats.submitted*100) : 0;
      document.getElementById('filter-kpis').innerHTML = stats ? [
        ['SMS Sent', fmt(stats.smsSent)],
        ['Matched Any App', fmt(stats.matchedAny)],
        ['Submitted', fmt(stats.submitted)],
        ['Booked', fmt(stats.booked)+' ('+pct(rate)+')'],
        ['Booked value', money(stats.bookedAmount)],
      ].map(([lab,big])=>\`<div class="card"><div class="lab">\${lab}</div><div class="big">\${big}</div></div>\`).join('') : '';
      document.getElementById('filter-table').innerHTML =
        '<tr><td style="text-align:center;color:var(--faint)">Row-level lookup is not available for SMS Sent Campaigns (500K+ recipients in some files -- aggregate only, see the SMS Sent Campaigns section above). Civil ID search and the submitted/booked date filters only apply to Campaign performance campaigns -- the SMS Sent Date filter above does apply here.</td></tr>';
      document.getElementById('filter-row-note').textContent = '';
      return;
    }
    const camp = campRaw.startsWith('app:') ? campRaw.slice(4) : campRaw;

    const filtered = rows.filter(r=>{
      if (q && !(r.civilId && r.civilId.includes(q))) return false;
      if (camp && r.campaign !== camp) return false;
      if (sms && r.smsDate !== sms) return false;
      if (subFrom && (!r.submittedDate || r.submittedDate < subFrom)) return false;
      if (bookFrom && (!r.bookedDate || r.bookedDate < bookFrom)) return false;
      return true;
    });

    const submittedCount = filtered.filter(r=>r.submittedDate).length;
    const bookedCount = filtered.filter(r=>r.booked).length;
    const bookedAmount = filtered.filter(r=>r.booked).reduce((s,r)=>s+(r.amount||0),0);
    const rate = submittedCount ? (bookedCount/submittedCount*100) : 0;
    document.getElementById('filter-kpis').innerHTML = [
      ['Matching applications', fmt(filtered.length)],
      ['Submitted', fmt(submittedCount)],
      ['Booked', fmt(bookedCount)+' ('+pct(rate)+')'],
      ['Booked value', money(bookedAmount)],
    ].map(([lab,big])=>\`<div class="card"><div class="lab">\${lab}</div><div class="big">\${big}</div></div>\`).join('');

    const th = '<tr><th>Civil ID</th><th>Staging ID</th><th>Campaign</th><th>SMS Date</th><th>Submitted</th><th>Booked</th><th>Status</th></tr>';
    const bodyRows = filtered.slice(0, ROW_CAP).map(r=>\`<tr>
      <td>\${r.civilId||'—'}</td>
      <td>\${r.stagingId||'—'}</td>
      <td class="campname">\${r.campaign}</td>
      <td>\${r.smsDate||'—'}</td>
      <td>\${r.submittedDate||'—'}</td>
      <td>\${r.bookedDate||(r.booked?'yes':'—')}</td>
      <td>\${r.status||'—'} <span class="match-badge \${r.matched?'live':'stale'}">\${r.matched?'LIVE':'SNAPSHOT'}</span></td>
    </tr>\`).join('');
    document.getElementById('filter-table').innerHTML = filtered.length ? (th + bodyRows) : '<tr><td style="text-align:center;color:var(--faint)">No matching applications</td></tr>';
    document.getElementById('filter-row-note').textContent = filtered.length > ROW_CAP
      ? \`Showing first \${ROW_CAP} of \${fmt(filtered.length)} matching rows -- narrow the filters to see more specific results.\`
      : '';
  }

  Object.values(els).forEach(el => el.addEventListener('input', apply));
  document.getElementById('f-reset').addEventListener('click', ()=>{
    Object.values(els).forEach(el => el.value = '');
    apply();
  });
  apply();
}

render();
// ===== v2 structure (2026-09-21): overview, outcome bar, insights, vendor chart, tabs =====
var OUT_DEF=[['Booked','#0e9e90',0],['In progress','#6f5be0',0],['Declined','#c0392b',0],['Cancelled','#bd7d12',0],['Abandoned / lapsed','#8493a8',0],['Never reached master','#d3dae6',1]];
function ddLow(k){return String(k).toLowerCase().replace('simah','SIMAH');}
function ddOutcome(r){
  if(r.booked)return 'Booked';
  var s=r.status||'';
  if(!s)return 'Never reached master';
  if(s==='Declined [D]')return 'Declined';
  if(s==='Cancelled [X]'||s==='Withdrawn [W]')return 'Cancelled';
  if(s==='Abandoned [B]'||s==='Lapsed [L]'||s==='Incomplete [I]')return 'Abandoned / lapsed';
  return 'In progress';
}
function ddSel(){var c=document.getElementById('dd-campaign').value;return c||'all campaigns';}
function renderOutcome(rows){
  var n=rows.length,cnt={};OUT_DEF.forEach(function(o){cnt[o[0]]=0;});
  rows.forEach(function(r){cnt[ddOutcome(r)]++;});
  var bk=cnt['Booked'];
  document.getElementById('hero-h').innerHTML=n?'<b>'+fmt(bk)+' booked</b> out of '+fmt(n)+' applications from '+ddSel()+' ('+pct(bk/n*100)+')':'No applications in this selection.';
  var bar='',leg='';
  OUT_DEF.forEach(function(o){var c=cnt[o[0]];if(!c)return;var w=c/n*100;
    bar+='<div class="oseg'+(o[2]?' lt':'')+'" style="width:'+w.toFixed(2)+'%;background:'+o[1]+'" title="'+o[0]+': '+fmt(c)+' ('+pct(w)+')">'+(w>=7?fmt(c):'')+'</div>';
    leg+='<div class="oleg"><i style="background:'+o[1]+'"></i>'+o[0]+' <b>'+fmt(c)+'</b><span>'+pct(w)+'</span></div>';});
  document.getElementById('outcome-bar').innerHTML=bar;
  document.getElementById('outcome-legend').innerHTML=leg;
  var nr=rows.filter(function(r){return ddOutcome(r)==='Never reached master';});
  var note='';
  if(nr.length){var m={};nr.forEach(function(r){var k=r.dec||'no decision recorded';m[k]=(m[k]||0)+1;});
    var top=Object.keys(m).sort(function(a,b){return m[b]-m[a];}).slice(0,3).map(function(k){return fmt(m[k])+' '+ddLow(k);});
    note='<b>'+fmt(nr.length)+'</b> applications ('+pct(nr.length/n*100)+') never reached the master system. By credit decision: '+top.join(', ')+'.';}
  document.getElementById('outcome-note').innerHTML=note;
}
function renderOverviewKpis(rows){
  var a=ddAgg(rows),n=a.n||1;
  var k=[['Applications',fmt(a.n),'created from SMS links'],['Reached master',fmt(a.tm),pct(a.tm/n*100)+' of applications'],['Final approved',fmt(a.fa),pct(a.fa/n*100)+' of applications'],['Booked',fmt(a.bk),pct(a.bk/n*100)+' of applications'],['Booked value',money(a.val),'live value where matched'],['Average ticket',a.bk?money(a.val/a.bk):'—','per booked loan']];
  document.getElementById('ov-kpis').innerHTML=k.map(function(x){return '<div class="card"><div class="lab">'+x[0]+'</div><div class="big">'+x[1]+'</div><div class="sub">'+x[2]+'</div></div>';}).join('');
}
function ddGroupBy(rows,keyFn){var m={};rows.forEach(function(r){var k=keyFn(r);if(k==null||k==='')return;(m[k]||(m[k]=[])).push(r);});return m;}
function renderInsights(rows){
  var out=[],n=rows.length;
  if(n<30){document.getElementById('ov-insights').innerHTML='<li>Not enough applications in this selection to draw conclusions.</li>';return;}
  var byP=ddGroupBy(rows,function(r){return r.prod;});
  var ps=Object.keys(byP).filter(function(k){return byP[k].length>=30;}).map(function(k){var a=ddAgg(byP[k]);return {k:k,n:a.n,rate:a.bk/a.n*100};});
  if(ps.length>1){var big=ps.slice().sort(function(a,b){return b.n-a.n;})[0],best=ps.slice().sort(function(a,b){return b.rate-a.rate;})[0];
    if(big.k!==best.k&&big.rate<best.rate/2)out.push('<li class="warn"><b>'+big.k+'</b> is the biggest product at '+pct(big.n/n*100)+' of applications but books only <b>'+pct(big.rate)+'</b>, while <b>'+best.k+'</b> books <b>'+pct(best.rate)+'</b>.</li>');
    else out.push('<li><b>'+best.k+'</b> converts best at <b>'+pct(best.rate)+'</b> of its applications; '+big.k+' is the largest product at '+pct(big.n/n*100)+' of volume.</li>');}
  var nr=rows.filter(function(r){return ddOutcome(r)==='Never reached master';});
  if(nr.length){var m={};nr.forEach(function(r){var k=r.dec||'no decision recorded';m[k]=(m[k]||0)+1;});var ks=Object.keys(m).sort(function(a,b){return m[b]-m[a];});
    out.push('<li class="warn"><b>'+pct(nr.length/n*100)+'</b> of applications ('+fmt(nr.length)+') never reach master. The largest groups are <b>'+ddLow(ks[0])+'</b> ('+fmt(m[ks[0]])+')'+(ks[1]?' and <b>'+ddLow(ks[1])+'</b> ('+fmt(m[ks[1]])+')':'')+'.</li>');}
  var ap=rows.filter(function(r){return r.dec==='Approved';});
  if(ap.length>=30){var ab=ap.filter(function(r){return r.booked;}).length;
    out.push('<li>Only <b>'+pct(ab/ap.length*100)+'</b> of the '+fmt(ap.length)+' applications approved by the decision engine end up booked, so <b>'+fmt(ap.length-ab)+'</b> approved applications did not convert.</li>');}
  var lags=rows.map(function(r){return r.lag;}).filter(function(x){return x!=null&&x>=0;}).sort(function(x,y){return x-y;});
  if(lags.length>=30){var med=lags[Math.floor(lags.length/2)],w7=lags.filter(function(x){return x<=7;}).length/lags.length*100;
    out.push('<li>People take a median of <b>'+med+' days</b> from SMS delivery to application, and only <b>'+pct(w7)+'</b> apply within a week, so bookings keep maturing for weeks after a send.</li>');}
  var bk=rows.filter(function(r){return r.booked&&r.amount>0;});
  if(bk.length>=30){var tv=bk.reduce(function(s,r){return s+r.amount;},0),hi=bk.filter(function(r){return r.amount>=25000;}),hv=hi.reduce(function(s,r){return s+r.amount;},0);
    out.push('<li>Booked loans average <b>'+money(tv/bk.length)+'</b>. Loans of SAR 25K and above are <b>'+pct(hi.length/bk.length*100)+'</b> of booked loans but <b>'+pct(hv/tv*100)+'</b> of booked value.</li>');}
  document.getElementById('ov-insights').innerHTML=out.join('');
}
function renderVendorChart(){
  var t=SMS_DATA.summaryTrend||[];var el=document.getElementById('vendor-chart');if(!el)return;
  if(!t.length){el.innerHTML='';return;}
  var m={};t.forEach(function(r){var o=m[r.month]||(m[r.month]={s:0,a:0,b:0});o.s+=+r.submissions||0;o.a+=+r.approvals||0;o.b+=+r.bookings||0;});
  var ms=Object.keys(m).sort();var W=760,H=230,L=48,R=16,T=16,B=30,mx=1;
  ms.forEach(function(k){mx=Math.max(mx,m[k].s,m[k].a,m[k].b);});
  var X=function(i){return L+(ms.length>1?i*(W-L-R)/(ms.length-1):(W-L-R)/2);},Y=function(v){return T+(H-T-B)*(1-v/mx);};
  var s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Vendor monthly rollup">';
  for(var g=0;g<=4;g++){var y=Y(mx*g/4);s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="rgba(30,45,75,.10)"/><text x="'+(L-7)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="#8493a8">'+fmt(mx*g/4)+'</text>';}
  ms.forEach(function(k,i){s+='<text x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10" fill="#8493a8">'+prettyMonth(k)+'</text>';});
  var defs=[['s','Submissions','#0e9e90',''],['a','Final approvals','#6f5be0',''],['b','Bookings (vendor count)','#bd7d12','6 4']];
  defs.forEach(function(d){var p='';ms.forEach(function(k,i){p+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(m[k][d[0]]).toFixed(1)+' ';});
    s+='<path d="'+p+'" fill="none" stroke="'+d[2]+'" stroke-width="2.3"'+(d[3]?' stroke-dasharray="'+d[3]+'"':'')+'/>';
    ms.forEach(function(k,i){s+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(m[k][d[0]]).toFixed(1)+'" r="3" fill="'+d[2]+'"><title>'+d[1]+' · '+prettyMonth(k)+' · '+fmt(m[k][d[0]])+'</title></circle>';});});
  s+='</svg><div class="vleg">'+defs.map(function(d){return '<span><i style="border-color:'+d[2]+(d[3]?';border-top-style:dashed':'')+'"></i>'+d[1]+'</span>';}).join('')+'</div>';
  el.innerHTML='<div class="vchart">'+s+'</div>';
}
function ddYm(s){return String(s||'').split('-').join('').slice(0,6);}
function renderHistory(){
  var t=SMS_DATA.summaryTrend||[],box=document.getElementById('hist-insights');if(!box)return;
  var camps=SMS_DATA.campaigns,ym=ddYm(SMS_DATA.meta.deliveredMax),rec=[],ins=[];
  Object.keys(camps).forEach(function(c){var v=t.filter(function(r){return String(r.month)===ym&&r.campaign===c;})[0];if(!v)return;var e=camps[c];rec.push({c:c,wave:v.duration,vs:+v.submissions,va:+v.approvals,vb:+v.bookings,es:e.submitted,ea:e.approved,eb:e.booked});});
  var tbl=document.getElementById('hist-recon');
  if(rec.length){
    tbl.innerHTML='<tr><th>Campaign</th><th>Wave</th><th class="num">Submissions (vendor / export)</th><th class="num">Final approvals (vendor / export)</th><th class="num">Bookings (vendor / export)</th><th class="num">Vendor bookings ÷ export</th></tr>'+
      rec.map(function(x){return '<tr><td class="campname">'+x.c+'</td><td>'+x.wave+'</td><td class="num">'+fmt(x.vs)+' / '+fmt(x.es)+'</td><td class="num">'+fmt(x.va)+' / '+fmt(x.ea)+'</td><td class="num">'+fmt(x.vb)+' / '+fmt(x.eb)+'</td><td class="num '+(x.eb&&x.vb/x.eb>1.5?'rate-bad':'')+'">'+(x.eb?(x.vb/x.eb).toFixed(1)+'x':'—')+'</td></tr>';}).join('');
    var big=rec.slice().sort(function(a,b){return b.es-a.es;})[0];
    var sClose=Math.abs(big.vs-big.es)<=Math.max(5,big.es*0.02),aClose=Math.abs(big.va-big.ea)<=Math.max(3,big.ea*0.05);
    var ratio=big.eb?big.vb/big.eb:null;
    ins.push('<li'+(ratio&&ratio>1.5?' class="warn"':'')+'><b>Vendor report vs this export.</b> For the latest wave ('+big.c+', '+big.wave+') the vendor’s submissions and final approvals '+((sClose&&aClose)?'line up with this export':'differ from this export')+' ('+fmt(big.vs)+' vs '+fmt(big.es)+' submissions, '+fmt(big.va)+' vs '+fmt(big.ea)+' approvals). Bookings '+(ratio&&ratio>1.5?'do not: the vendor reports <b>'+fmt(big.vb)+'</b> against <b>'+fmt(big.eb)+'</b> booked in this export ('+ratio.toFixed(1)+'x).':'are close: '+fmt(big.vb)+' vs '+fmt(big.eb)+'.')+'</li>');
  }else{tbl.parentElement.parentElement.style.display='none';}
  var withA=t.filter(function(r){return +r.approvals>0;}),exc=withA.filter(function(r){return +r.bookings>+r.approvals;});
  if(exc.length){ins.push('<li class="warn"><b>Vendor bookings are a broader measure than ours.</b> In '+exc.length+' of '+withA.length+' vendor rows, bookings exceed final approvals. One funnel cannot book more loans than it approved, so the vendor is counting something wider than the Booked figure on the other tabs (for example, any booking by the same customers in the period). Confirm the definition with the vendor before quoting vendor booking rates. Use this tab for submission and approval trends.</li>');}
  Object.keys(camps).forEach(function(c){
    var rs=t.filter(function(r){return r.campaign===c&&+r.submissions>=100;}).sort(function(a,b){return String(a.month).localeCompare(String(b.month));});
    if(rs.length>=2){var a=rs[0],b=rs[rs.length-1],ra=a.approvals/a.submissions*100,rb=b.approvals/b.submissions*100,dv=(b.submissions-a.submissions)/a.submissions*100;
      ins.push('<li><b>'+c+'</b>, '+prettyMonth(a.month)+' to '+prettyMonth(b.month)+': submissions '+fmt(+a.submissions)+' → '+fmt(+b.submissions)+' ('+(dv>=0?'+':'')+dv.toFixed(1)+'%), final-approval rate '+pct(ra)+' → '+pct(rb)+'.</li>');}
  });
  var months={};t.forEach(function(r){if(+r.submissions>=100)months[r.month]=1;});
  var ks=Object.keys(months).sort();
  if(ks.length>=2){var miss=[],y=+ks[0].slice(0,4),m=+ks[0].slice(4),last=ks[ks.length-1];
    for(var i=0;i<24;i++){var key=String(y*100+m);if(key>last)break;if(!months[key])miss.push(prettyMonth(key));m++;if(m>12){m=1;y++;}}
    ins.push('<li>Waves of 100+ submissions ran in '+ks.map(prettyMonth).join(', ')+'.'+(miss.length?' No wave of that size appears for '+miss.join(', ')+'.':'')+'</li>');}
  box.innerHTML=ins.join('');
}
function renderAll(){var rows=ddRows();renderOutcome(rows);renderOverviewKpis(rows);renderInsights(rows);renderDeepDive();}
function ddShowTab(name){
  var ok=false;document.querySelectorAll('#tabs button').forEach(function(b){var on=b.dataset.tab===name&&b.style.display!=='none';if(on)ok=true;});
  if(!ok)name='overview';
  document.querySelectorAll('#tabs button').forEach(function(b){b.classList.toggle('on',b.dataset.tab===name);});
  document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('on',p.id==='tab-'+name);});
  if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);
  window.scrollTo(0,0);
}
(function(){
  document.querySelectorAll('#tabs button').forEach(function(b){b.addEventListener('click',function(){ddShowTab(b.dataset.tab);});});
  var st=document.getElementById('sent-section');if(st&&st.style.display==='none'){var bb=document.getElementById('tab-btn-sendlists');if(bb)bb.style.display='none';}
  var tr=document.getElementById('trend-section');if(tr&&tr.style.display==='none'){var bv=document.getElementById('tab-btn-history');if(bv)bv.style.display='none';}
  ddShowTab((location.hash||'').replace('#','')||'overview');
  renderVendorChart();
  renderHistory();
  renderAll();
})();

</script>
</body></html>
`;
}

module.exports = { buildHtml };
