#!/usr/bin/env node
/**
 * Build SNB_Overview.html from SNB_Referral_all_merged.csv -- a fresh,
 * self-contained dashboard for SNB branch referrals (NOT the Acquisition
 * data any more; replaced 2026-09-27 per explicit request + confirmation
 * that the old Acquisition-based clone, including its Customer Info and
 * New change tabs, should be fully replaced by this).
 *
 * Data is small (~1,750 rows, 11 columns) compared to the Acquisition
 * pipeline's 850K+ rows, so the whole row-level dataset is embedded
 * directly -- no RAWSTORE columnar compression needed here.
 *
 * Added 2026-09-27: cross-references every referral against
 * Acquisition_for_Loans_all_merged.csv by CivilID, to answer "did this
 * referral actually turn into a loan application, and how far did it get."
 * Since a CivilID can have several Acquisition rows (35% do, confirmed
 * 2026-09-27) and there's no direct foreign key tying a specific
 * application back to a specific referral, this takes the FURTHEST stage
 * reached across ANY of that CivilID's applications -- simple, defensible,
 * and avoids a fragile date-proximity guess. This does mean an unrelated
 * older/newer application by the same person could be credited to a
 * referral it had nothing to do with; the dashboard discloses this
 * plainly rather than overclaiming precision. Requires
 * --max-old-space-size=16384 (same as update_acquisition_dashboard.js)
 * to load the 850K+ row Acquisition file; degrades gracefully (skips the
 * funnel section) if that file isn't present in the project root.
 *
 * Usage: node scripts/build_snb_referral_overview.js [path-to-merged-csv]
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./update_acquisition_dashboard.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_HTML = path.join(ROOT, 'SNB_Overview.html');
const DEFAULT_CSV = path.join(ROOT, 'SNB_Referral_all_merged.csv');
const ACQ_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
const filePath = process.argv[2] || DEFAULT_CSV;

if (!fs.existsSync(filePath)) {
  console.error(`ERROR: ${filePath} not found. Run scripts/merge_snb_referral.js first.`);
  process.exit(1);
}

console.log(`Reading ${path.basename(filePath)}…`);
const raw = readCsv(filePath);
console.log(`Parsed ${raw.length.toLocaleString()} rows`);

// ---- Cross-reference by CivilID against the Acquisition pipeline --------
// Stage ladder (furthest reached wins): 0 none · 1 Applied (any row) ·
// 2 Submitted to Master (Altitudestatus populated) · 3 Approved
// (FinalApprovalFlag='Y') · 4 Booked (booked='1'). All three flags were
// checked against real distinct-value tallies before use (2026-09-27):
// booked is a clean 0/1 (54,278 of 878,853), FinalApprovalFlag Y=62,012 is
// a superset of booked as expected, Altitudestatus is blank for the 73%
// of rows that never reached the master system at all.
const STAGE_LABEL = ['Not applied', 'Applied', 'Submitted to master', 'Approved', 'Booked'];
let civilToStage = null;
let acqMeta = null;
if (fs.existsSync(ACQ_CSV)) {
  console.log(`Cross-referencing against ${path.basename(ACQ_CSV)}…`);
  const acqRows = readCsv(ACQ_CSV);
  civilToStage = new Map();
  acqRows.forEach(r => {
    const civ = String(r['CivilID'] || '').trim();
    if (!civ) return;
    let stage = 1;
    if (String(r['Altitudestatus'] || '').trim() !== '') stage = 2;
    if (String(r['FinalApprovalFlag'] || '').trim() === 'Y') stage = 3;
    const isBooked = String(r['booked'] || '').trim() === '1';
    if (isBooked) stage = 4;
    const declined = String(r['Altitudestatus'] || '').trim() === 'Declined [D]';
    // ItemValue is the established booked-loan-amount field (same one
    // buildJourneyTrends() sums for the Acquisition dashboard's own booking
    // totals) -- confirmed populated for 54,277 of 54,278 booked rows.
    // Summed across every booked row for this CivilID, not just the one
    // that set the max stage, in case the same person has more than one
    // booked loan on record.
    const bookedAmount = isBooked ? (parseFloat(r['ItemValue']) || 0) : 0;
    const prev = civilToStage.get(civ);
    if (!prev) {
      civilToStage.set(civ, { stage, declined, bookedAmount });
    } else {
      if (stage > prev.stage) prev.stage = stage;
      if (declined) prev.declined = true;
      prev.bookedAmount += bookedAmount;
    }
  });
  acqMeta = { total: acqRows.length, distinctCivilIds: civilToStage.size };
  console.log(`  ${acqRows.length.toLocaleString()} acquisition rows → ${civilToStage.size.toLocaleString()} distinct Civil IDs`);
} else {
  console.warn(`WARN: ${path.basename(ACQ_CSV)} not found -- building without the application-funnel cross-reference.`);
}

function parseJsonish(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function toDateParts(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { date: null, time: null };
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

const rows = raw.map(r => {
  const { date, time } = toDateParts(r['SnbCreated']);
  const branchObj = parseJsonish(r['SnbBranch']);
  const productObj = parseJsonish(r['ProductType']);
  const amt = parseFloat(r['Amount']);
  const civilId = r['CivilId'] || '';
  const acq = civilToStage ? civilToStage.get(String(civilId).trim()) : null;
  return {
    id: r['ReferralId'] || '',
    ref: r['ReferenceNumber'] || '',
    civilId,
    mobile: r['MobileNumber'] || '',
    amount: isNaN(amt) ? null : amt,
    status: r['Status'] || '',
    created: date,
    createdTime: time,
    name: (r['CustomerName_en'] || '').trim() || (r['CustomerName_ar'] || '').trim(),
    branch: branchObj ? branchObj.En : (r['SnbBranch'] || ''),
    product: productObj ? productObj.En : (r['ProductType'] || ''),
    appStage: acq ? acq.stage : 0,
    appDeclined: acq ? !!acq.declined : false,
    bookedAmount: acq ? (acq.bookedAmount || 0) : 0,
  };
}).filter(r => r.id);

const dates = rows.map(r => r.created).filter(Boolean).sort();
// Full date+time (not just date) of the newest referral, for a precise
// "pending >24h" calculation client-side -- added 2026-09-27 per explicit
// request. String comparison works since every timestamp is the same
// 'YYYY-MM-DD HH:MM' shape.
const maxDateTime = rows.map(r => r.created && r.createdTime ? `${r.created} ${r.createdTime}` : null).filter(Boolean).sort().slice(-1)[0] || null;
const statusTally = {};
rows.forEach(r => { statusTally[r.status] = (statusTally[r.status] || 0) + 1; });
console.log('Status breakdown:', statusTally);

const productSet = new Set(rows.map(r => r.product).filter(Boolean));
const branchSet = new Set(rows.map(r => r.branch).filter(Boolean));
console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]} | ${branchSet.size} branches | products: ${[...productSet].join(', ')}`);

const matchedCount = rows.filter(r => r.appStage > 0).length;
console.log(`Matched to an Acquisition application: ${matchedCount.toLocaleString()} / ${rows.length.toLocaleString()}`);

const data = {
  meta: {
    total: rows.length,
    min: dates[0] || null,
    max: dates[dates.length - 1] || null,
    maxDateTime,
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    sourceFile: path.basename(filePath),
    acq: acqMeta ? { ...acqMeta, matched: matchedCount, stageLabels: STAGE_LABEL } : null,
  },
  rows,
};

const html = buildHtml(data);
fs.writeFileSync(OUT_HTML, html, 'utf-8');
console.log(`✅ ${path.basename(OUT_HTML)} written — ${rows.length.toLocaleString()} referrals, ${dates[0]} → ${dates[dates.length - 1]}.`);

function buildHtml(d) {
  const dataJson = JSON.stringify(d);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tasheel · SNB Overview</title>
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
.sec-h{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.sec-h h2{font-size:16px;margin:0}
.sec-h .n{font-size:10px;color:var(--faint);font-family:'JetBrains Mono'}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:0 2px 4px rgba(20,30,50,.03)}
.card .lab{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin-bottom:6px}
.card .big{font-size:24px;font-weight:700;font-family:'Space Grotesk'}
.card .sub{font-size:11px;color:var(--faint);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--panel);border-radius:12px;overflow:hidden;border:1px solid var(--line)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line)}
th{background:var(--panel2);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;cursor:pointer;user-select:none}
th:hover{color:var(--ink)}
th.sorted::after{content:" ▾";color:var(--cyan-d)}
th.sorted.asc::after{content:" ▴"}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-family:'JetBrains Mono'}
.rate-good{color:var(--green);font-weight:700}
.rate-bad{color:var(--red);font-weight:700}
.status-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700}
.status-Approved{background:rgba(28,125,80,.12);color:var(--green)}
.status-Declined{background:rgba(192,57,43,.12);color:var(--red)}
.status-Processing{background:rgba(111,91,224,.12);color:var(--violet)}
.status-Lapsed{background:rgba(189,125,18,.12);color:var(--gold-d)}
.foot{text-align:center;color:var(--faint);font-size:11px;font-family:'JetBrains Mono';padding:22px}
.tablewrap{overflow-x:auto;max-height:520px;overflow-y:auto}
.tablewrap table{border-radius:0}
.tablewrap thead th{position:sticky;top:0;z-index:1}
.filters{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:18px}
.filter-row{display:flex;flex-wrap:wrap;gap:14px;align-items:end}
.filter-item{display:flex;flex-direction:column;gap:5px}
.filter-item label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.filter-item select,.filter-item input{padding:7px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);color:var(--ink);font-family:'Inter',sans-serif;font-size:12.5px}
.presets{display:flex;gap:6px}
.presets button{appearance:none;border:1px solid var(--line2);background:var(--panel2);color:var(--ink2);font-size:11.5px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:'Inter',sans-serif}
.presets button.on{background:var(--cyan);color:#fff;border-color:var(--cyan)}
.search-box{display:flex;flex-direction:column;gap:5px;flex:1;min-width:220px}
.btn-reset{padding:7px 14px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}
.btn-reset:hover{color:var(--ink);border-color:var(--line)}
.vchart svg{width:100%;height:auto;display:block}
.vleg{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--ink2);margin:8px 2px 4px}
.vleg i{display:inline-block;width:18px;border-top:3px solid;vertical-align:middle;margin-right:6px}
.row-limit-note{font-size:11px;color:var(--faint);margin-top:8px}
.caveat{background:rgba(189,125,18,.08);border:1px solid rgba(189,125,18,.28);border-radius:12px;padding:12px 16px;font-size:12px;color:var(--ink2);margin-bottom:16px;line-height:1.55}
.caveat b{color:var(--gold-d)}
.funnel-wrap{display:flex;flex-direction:column;padding:6px 4px;max-width:640px;margin:0 auto}
.fstage-row{display:flex;align-items:center;gap:14px;height:40px}
.fstage-bar{flex:0 1 auto;height:34px;min-width:18px;max-width:42%;border-radius:8px;transition:width .4s ease}
.fstage-info{display:flex;align-items:baseline;gap:9px;white-space:nowrap;overflow:hidden;min-width:0}
.fstage-info .fname{font-family:'Inter',sans-serif;font-size:13px;font-weight:600;color:var(--ink)}
.fstage-info .fcount{font-family:'JetBrains Mono';font-weight:700;font-size:15px;color:var(--ink2)}
.fconn{height:22px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11.5px;font-family:'JetBrains Mono';padding-left:2px}
.fconn .pct{color:var(--ink);font-weight:700}
.fconn .drop-bad{color:var(--red)}
.funnel-side{display:flex;justify-content:center;gap:26px;margin-top:14px;flex-wrap:wrap}
.funnel-side .fs-item{text-align:center}
.funnel-side .fs-n{font-family:'Space Grotesk';font-weight:700;font-size:19px}
.funnel-side .fs-l{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}}
</style></head>
<body>
<header>
  <div class="hleft">
    <div class="logo"></div>
    <div class="brand"><div class="t">SNB Overview</div><div class="s">Tasheel Finance · SNB Branch Referrals</div></div>
  </div>
  <a class="home-link" href="index.html">← Home</a>
</header>
<main>
<div class="hint" id="source-hint"></div>

<div class="filters">
  <div class="filter-row">
    <div class="filter-item"><label>From</label><input type="date" id="f-from"></div>
    <div class="filter-item"><label>To</label><input type="date" id="f-to"></div>
    <div class="filter-item"><label>Range</label><div class="presets" id="presets">
      <button data-r="all" class="on">All</button>
      <button data-r="30d">Last 30 days</button>
      <button data-r="7d">Last 7 days</button>
      <button data-r="mtd">This month</button>
    </div></div>
    <button class="btn-reset" id="f-reset">Reset</button>
  </div>
</div>

<div class="section">
  <div class="sec-h"><h2>Summary</h2><span class="n" id="summary-hint"></span></div>
  <div class="kpis" id="kpis"></div>
</div>

<div class="section">
  <div class="sec-h"><h2>Referrals by day</h2><span class="n">created date · total vs approved</span></div>
  <div class="vchart" id="trend-chart"></div>
  <div class="vleg" id="trend-legend"></div>
</div>

<div class="section">
  <div class="sec-h"><h2>Status breakdown</h2></div>
  <div class="tablewrap"><table id="status-table"></table></div>
</div>

<div class="section">
  <div class="sec-h"><h2>Branches</h2><span class="n" id="branch-count"></span></div>
  <div class="hint">Sorted by referral volume by default — click a column header to re-sort.</div>
  <div class="tablewrap"><table id="branch-table"></table></div>
</div>

<div class="section" id="funnel-section">
  <div class="sec-h"><h2>Application funnel</h2><span class="n">cross-checked against Acquisition data by Civil ID</span></div>
  <div class="caveat" id="funnel-caveat"></div>
  <div class="funnel-wrap" id="funnel-viz"></div>
  <div class="funnel-side" id="funnel-side"></div>
</div>

<div class="section" id="funnel-trend-section">
  <div class="sec-h"><h2>Funnel trend</h2><span class="n">weekly referral cohorts · conversion rate at each stage</span></div>
  <div class="hint">Recent weeks will look weaker than they really are — an application takes time to move through the funnel, so the newest cohorts haven't had a chance to mature yet.</div>
  <div class="vchart" id="funnel-trend-chart"></div>
  <div class="vleg" id="funnel-trend-legend"></div>
</div>

<div class="section">
  <div class="sec-h"><h2>Lookup &amp; filter</h2><span class="n" id="lookup-count"></span></div>
  <div class="filters">
    <div class="filter-row">
      <div class="search-box">
        <label for="l-search">Search</label>
        <input type="text" id="l-search" placeholder="Civil ID, Reference Number, Referral ID, name, or mobile…">
      </div>
      <div class="filter-item"><label>Status</label><select id="l-status"><option value="">All statuses</option></select></div>
      <div class="filter-item"><label>Branch</label><select id="l-branch"><option value="">All branches</option></select></div>
      <button class="btn-reset" id="l-reset">Reset</button>
    </div>
  </div>
  <div class="tablewrap"><table id="lookup-table"></table></div>
  <div class="row-limit-note" id="lookup-note"></div>
</div>

</main>
<div class="foot">Built for <a href="https://www.linkedin.com/in/emadayyash" target="_blank">Emad Ayyash</a> · Tasheel Finance</div>
<script>
const SNB_DATA = ${dataJson};
const STATUS_ORDER=['Approved','Processing','Declined','Lapsed'];
const STATUS_COLOR={Approved:'#1c7d50',Processing:'#6f5be0',Declined:'#c0392b',Lapsed:'#bd7d12'};

function fmt(n){ return (n==null||isNaN(n))?'—':Math.round(n).toLocaleString(); }
function money(n){ return (n==null||isNaN(n))?'—':'SAR '+Math.round(n).toLocaleString(); }
function pct(n){ return (n==null||isNaN(n))?'—':n.toFixed(1)+'%'; }
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

let FROM=null, TO=null;
function inRange(r){ return (!FROM||r.created>=FROM) && (!TO||r.created<=TO); }
function filteredRows(){ return SNB_DATA.rows.filter(inRange); }

function addDays(ymd,n){ const d=new Date(ymd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }

function applyPreset(r){
  const mn=SNB_DATA.meta.min, mx=SNB_DATA.meta.max;
  if(r==='all'){FROM=null;TO=null;}
  else if(r==='30d'){FROM=addDays(mx,-29);TO=mx;}
  else if(r==='7d'){FROM=addDays(mx,-6);TO=mx;}
  else if(r==='mtd'){const d=new Date(mx+'T00:00:00Z');FROM=mx.slice(0,8)+'01';TO=mx;}
  document.getElementById('f-from').value=FROM||mn;
  document.getElementById('f-to').value=TO||mx;
  document.querySelectorAll('#presets button').forEach(b=>b.classList.toggle('on',b.dataset.r===r));
  renderAll();
}
document.querySelectorAll('#presets button').forEach(b=>b.addEventListener('click',()=>applyPreset(b.dataset.r)));
document.getElementById('f-from').addEventListener('change',()=>{FROM=document.getElementById('f-from').value||null;document.querySelectorAll('#presets button').forEach(x=>x.classList.remove('on'));renderAll();});
document.getElementById('f-to').addEventListener('change',()=>{TO=document.getElementById('f-to').value||null;document.querySelectorAll('#presets button').forEach(x=>x.classList.remove('on'));renderAll();});
document.getElementById('f-reset').addEventListener('click',()=>applyPreset('all'));

const MS_24H=24*3600*1000;
function totalBookedLoanAmount(rows){
  // Dedupe by CivilID -- bookedAmount is a property of the person/application,
  // not the referral event, so a re-referred customer (multiple referral rows,
  // same CivilID) must only be counted once, or their loan value would be
  // double-counted for every extra referral record they have.
  const seen=new Map();
  rows.forEach(r=>{ if(r.civilId && !seen.has(r.civilId)) seen.set(r.civilId,r.bookedAmount||0); });
  let total=0; seen.forEach(v=>total+=v);
  return total;
}
function pendingOver24h(rows){
  if(!SNB_DATA.meta.maxDateTime) return null;
  const now=new Date(SNB_DATA.meta.maxDateTime.replace(' ','T')+'Z').getTime();
  return rows.filter(r=>{
    if(r.status!=='Processing'||!r.created||!r.createdTime) return false;
    const t=new Date((r.created+' '+r.createdTime).replace(' ','T')+'Z').getTime();
    return (now-t)>=MS_24H;
  }).length;
}
function renderKpis(rows){
  const n=rows.length;
  const byStatus={};STATUS_ORDER.forEach(s=>byStatus[s]=0);
  rows.forEach(r=>{byStatus[r.status]=(byStatus[r.status]||0)+1;});
  const approvedVal=rows.filter(r=>r.status==='Approved').reduce((s,r)=>s+(r.amount||0),0);
  const cards=[
    ['Total referrals',fmt(n),'in selected range'],
    ['Approved',fmt(byStatus.Approved||0),pct(n?byStatus.Approved/n*100:0)+' of total · '+money(approvedVal)],
    ['Declined',fmt(byStatus.Declined||0),pct(n?byStatus.Declined/n*100:0)+' of total'],
    ['Processing',fmt(byStatus.Processing||0),pct(n?byStatus.Processing/n*100:0)+' of total'],
    ['Lapsed',fmt(byStatus.Lapsed||0),pct(n?byStatus.Lapsed/n*100:0)+' of total'],
  ];
  if(SNB_DATA.meta.acq){
    cards.push(['Total booked loan amount',money(totalBookedLoanAmount(rows)),'from referrals whose application was booked (Acquisition cross-reference)']);
  }
  const p24=pendingOver24h(rows);
  if(p24!=null){
    cards.push(['Pending >24h',fmt(p24),(byStatus.Processing?pct(p24/byStatus.Processing*100)+' of Processing':'—')+' still waiting a day on']);
  }
  document.getElementById('kpis').innerHTML=cards.map(x=>'<div class="card"><div class="lab">'+x[0]+'</div><div class="big">'+x[1]+'</div><div class="sub">'+x[2]+'</div></div>').join('');
}

function renderTrend(rows){
  const byDate={};
  rows.forEach(r=>{ if(!r.created)return; const o=byDate[r.created]||(byDate[r.created]={n:0,a:0}); o.n++; if(r.status==='Approved')o.a++; });
  const days=Object.keys(byDate).sort();
  if(!days.length){document.getElementById('trend-chart').innerHTML='<p class="hint">No data in this range.</p>';document.getElementById('trend-legend').innerHTML='';return;}
  const W=940,H=260,L=46,R=16,T=16,B=28,mx=Math.max.apply(null,days.map(d=>byDate[d].n))||1;
  const X=i=>L+(days.length>1?i*(W-L-R)/(days.length-1):(W-L-R)/2), Y=v=>T+(H-T-B)*(1-v/mx);
  let g='';
  for(let k=0;k<=4;k++){const v=mx*k/4,y=Y(v);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="rgba(30,45,75,.10)"/><text x="'+(L-7)+'" y="'+(y+4)+'" text-anchor="end" font-size="10.5" fill="#8493a8">'+fmt(v)+'</text>';}
  const step=Math.max(1,Math.ceil(days.length/10));
  days.forEach((d,i)=>{if(i%step===0||i===days.length-1)g+='<text x="'+X(i)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10.5" fill="#8493a8">'+d.slice(5)+'</text>';});
  let p1='',p2='';
  days.forEach((d,i)=>{p1+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(byDate[d].n).toFixed(1)+' ';p2+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(byDate[d].a).toFixed(1)+' ';});
  g+='<path d="'+p1+'" fill="none" stroke="#0e9e90" stroke-width="2.3"/>';
  g+='<path d="'+p2+'" fill="none" stroke="#1c7d50" stroke-width="2.3" stroke-dasharray="6 4"/>';
  days.forEach((d,i)=>{g+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(byDate[d].n).toFixed(1)+'" r="2.8" fill="#0e9e90"><title>'+d+' · '+byDate[d].n+' referrals, '+byDate[d].a+' approved</title></circle>';});
  document.getElementById('trend-chart').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Referrals by day">'+g+'</svg>';
  document.getElementById('trend-legend').innerHTML='<span><i style="border-color:#0e9e90"></i>Total referrals</span><span><i style="border-color:#1c7d50;border-top-style:dashed"></i>Approved</span>';
}

function renderStatusTable(rows){
  const n=rows.length;
  const byStatus={};STATUS_ORDER.forEach(s=>byStatus[s]={n:0,val:0});
  rows.forEach(r=>{const b=byStatus[r.status]||(byStatus[r.status]={n:0,val:0});b.n++;b.val+=r.amount||0;});
  let h='<tr><th>Status</th><th class="num">Referrals</th><th class="num">Share</th><th class="num">Total amount</th></tr>';
  Object.keys(byStatus).forEach(s=>{const b=byStatus[s];h+='<tr><td><span class="status-pill status-'+esc(s)+'">'+esc(s)+'</span></td><td class="num">'+fmt(b.n)+'</td><td class="num">'+pct(n?b.n/n*100:0)+'</td><td class="num">'+money(b.val)+'</td></tr>';});
  document.getElementById('status-table').innerHTML=h;
}

let BRANCH_SORT={col:'n',dir:-1};
function branchStats(rows){
  const m={};
  rows.forEach(r=>{ if(!r.branch)return; const b=m[r.branch]||(m[r.branch]={n:0,approved:0,val:0}); b.n++; if(r.status==='Approved'){b.approved++;b.val+=r.amount||0;} });
  return Object.entries(m).map(([name,b])=>({name,n:b.n,approved:b.approved,rate:b.n?b.approved/b.n*100:0,val:b.val}));
}
function renderBranches(rows){
  const stats=branchStats(rows);
  document.getElementById('branch-count').textContent=stats.length+' branches';
  const col=BRANCH_SORT.col,dir=BRANCH_SORT.dir;
  stats.sort((a,b)=>(a[col]<b[col]?-1:a[col]>b[col]?1:0)*dir);
  let h='<tr>'+
    '<th data-col="name">Branch</th>'+
    '<th class="num" data-col="n">Referrals</th>'+
    '<th class="num" data-col="approved">Approved</th>'+
    '<th class="num" data-col="rate">Approval rate</th>'+
    '<th class="num" data-col="val">Approved value</th></tr>';
  stats.forEach(b=>{const cls=b.rate>=15?'rate-good':(b.rate<3?'rate-bad':'');
    h+='<tr><td>'+esc(b.name)+'</td><td class="num">'+fmt(b.n)+'</td><td class="num">'+fmt(b.approved)+'</td><td class="num '+cls+'">'+pct(b.rate)+'</td><td class="num">'+money(b.val)+'</td></tr>';});
  const table=document.getElementById('branch-table');
  table.innerHTML=h;
  table.querySelectorAll('th').forEach(th=>{
    if(th.dataset.col===BRANCH_SORT.col){th.classList.add('sorted');if(BRANCH_SORT.dir===1)th.classList.add('asc');}
    th.addEventListener('click',()=>{
      if(BRANCH_SORT.col===th.dataset.col)BRANCH_SORT.dir*=-1; else {BRANCH_SORT.col=th.dataset.col;BRANCH_SORT.dir=-1;}
      renderBranches(filteredRows());
    });
  });
}

const STAGE_COLOR=['#8493a8','#6f5be0','#0e9e90','#0b7d72','#1c7d50'];
function stageLabel(n){ const L=(SNB_DATA.meta.acq&&SNB_DATA.meta.acq.stageLabels)||['Not applied','Applied','Submitted to master','Approved','Booked']; return L[n]||L[0]; }

function renderFunnel(rows){
  const acq=SNB_DATA.meta.acq;
  const cav=document.getElementById('funnel-caveat');
  if(!acq){
    cav.innerHTML='<b>Application funnel unavailable.</b> This build did not have Acquisition_for_Loans_all_merged.csv available to cross-reference against, so referral outcomes past "Referred" cannot be shown. Re-run the build script with that file present in the project root.';
    document.getElementById('funnel-viz').innerHTML='';
    document.getElementById('funnel-side').innerHTML='';
    document.getElementById('funnel-trend-chart').innerHTML='';
    document.getElementById('funnel-trend-legend').innerHTML='';
    return;
  }
  cav.innerHTML='<b>How this is built:</b> each referral is matched to Acquisition applications by Civil ID, and credited with the FURTHEST stage reached by ANY application under that Civil ID. There is no direct link between a specific referral and a specific application in the source data, so an unrelated application by the same person (before or after this referral) can be credited here — treat this as "did this person go on to apply and how far did they get," not a strict causal attribution. Cross-referenced against '+fmt(acq.total)+' Acquisition rows ('+fmt(acq.distinctCivilIds)+' distinct Civil IDs).';

  const n=rows.length;
  const counts=[0,0,0,0,0]; // count reaching AT LEAST stage i
  let declined=0;
  rows.forEach(r=>{
    for(let s=0;s<=r.appStage;s++) counts[s]++;
    if(r.appDeclined) declined++;
  });
  counts[0]=n; // "Referred" stage = everyone
  const labels=['Referred','Applied','Submitted to master','Approved','Booked'];
  const max=Math.max(counts[0],1);
  let h='';
  labels.forEach((lab,i)=>{
    const w=Math.max(5,counts[i]/max*42);
    h+='<div class="fstage-row"><div class="fstage-bar" style="width:'+w.toFixed(1)+'%;background:linear-gradient(90deg,'+STAGE_COLOR[i]+','+STAGE_COLOR[i]+'cc)"></div><div class="fstage-info"><span class="fname">'+lab+'</span><span class="fcount">'+fmt(counts[i])+'</span></div></div>';
    if(i<labels.length-1){
      const conv=counts[i]?(100*counts[i+1]/counts[i]):0;
      const bad=conv<10;
      h+='<div class="fconn"><span>↓</span><span class="pct'+(bad?' drop-bad':'')+'">'+conv.toFixed(1)+'%</span><span>of previous stage</span></div>';
    }
  });
  document.getElementById('funnel-viz').innerHTML=h;
  document.getElementById('funnel-side').innerHTML=
    '<div class="fs-item"><div class="fs-n">'+pct(n?counts[1]/n*100:0)+'</div><div class="fs-l">Applied, overall</div></div>'+
    '<div class="fs-item"><div class="fs-n">'+pct(counts[1]?counts[4]/counts[1]*100:0)+'</div><div class="fs-l">Applied → Booked</div></div>'+
    '<div class="fs-item"><div class="fs-n">'+fmt(declined)+'</div><div class="fs-l">Declined outright</div></div>'+
    '<div class="fs-item"><div class="fs-n">'+pct(n?declined/n*100:0)+'</div><div class="fs-l">Of all referrals</div></div>';
}

function isoWeekStart(ymd){
  const d=new Date(ymd+'T00:00:00Z');
  const day=(d.getUTCDay()+6)%7; // Mon=0
  d.setUTCDate(d.getUTCDate()-day);
  return d.toISOString().slice(0,10);
}
function renderFunnelTrend(rows){
  if(!SNB_DATA.meta.acq){ return; }
  const byWeek={};
  rows.forEach(r=>{
    if(!r.created) return;
    const wk=isoWeekStart(r.created);
    const o=byWeek[wk]||(byWeek[wk]={n:0,applied:0,submitted:0,approved:0,booked:0});
    o.n++;
    if(r.appStage>=1)o.applied++;
    if(r.appStage>=2)o.submitted++;
    if(r.appStage>=3)o.approved++;
    if(r.appStage>=4)o.booked++;
  });
  const weeks=Object.keys(byWeek).sort();
  if(!weeks.length){document.getElementById('funnel-trend-chart').innerHTML='<p class="hint">No data in this range.</p>';document.getElementById('funnel-trend-legend').innerHTML='';return;}
  const SERIES=[['applied','#6f5be0'],['submitted','#0e9e90'],['approved','#0b7d72'],['booked','#1c7d50']];
  const W=940,H=260,L=42,R=16,T=16,B=28;
  const X=i=>L+(weeks.length>1?i*(W-L-R)/(weeks.length-1):(W-L-R)/2), Y=v=>T+(H-T-B)*(1-v/100);
  let g='';
  for(let k=0;k<=4;k++){const v=25*k,y=Y(v);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="rgba(30,45,75,.10)"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="#8493a8">'+v+'%</text>';}
  const step=Math.max(1,Math.ceil(weeks.length/10));
  weeks.forEach((w,i)=>{if(i%step===0||i===weeks.length-1)g+='<text x="'+X(i)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10" fill="#8493a8">'+w.slice(5)+'</text>';});
  SERIES.forEach(([key,col])=>{
    let p='';
    weeks.forEach((w,i)=>{ const o=byWeek[w]; const rate=o.n?o[key]/o.n*100:0; p+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(rate).toFixed(1)+' '; });
    g+='<path d="'+p+'" fill="none" stroke="'+col+'" stroke-width="2.2"/>';
    weeks.forEach((w,i)=>{ const o=byWeek[w]; const rate=o.n?o[key]/o.n*100:0; g+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(rate).toFixed(1)+'" r="2.4" fill="'+col+'"><title>'+w+' · '+key+' '+rate.toFixed(1)+'% ('+o[key]+'/'+o.n+')</title></circle>'; });
  });
  document.getElementById('funnel-trend-chart').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Funnel trend by weekly cohort">'+g+'</svg>';
  document.getElementById('funnel-trend-legend').innerHTML=SERIES.map(([key,col])=>'<span><i style="border-color:'+col+'"></i>'+key.charAt(0).toUpperCase()+key.slice(1)+' rate</span>').join('');
}

const LOOKUP_CAP=300;
function renderLookup(){
  const rows=filteredRows();
  const q=(document.getElementById('l-search').value||'').trim().toLowerCase();
  const st=document.getElementById('l-status').value;
  const br=document.getElementById('l-branch').value;
  const matches=rows.filter(r=>{
    if(st&&r.status!==st)return false;
    if(br&&r.branch!==br)return false;
    if(q){
      const hay=(r.civilId+' '+r.ref+' '+r.id+' '+r.name+' '+r.mobile).toLowerCase();
      if(!hay.includes(q))return false;
    }
    return true;
  });
  document.getElementById('lookup-count').textContent=fmt(matches.length)+' of '+fmt(rows.length)+' shown';
  let h='<tr><th>Referral ID</th><th>Reference</th><th>Civil ID</th><th>Name</th><th>Mobile</th><th>Branch</th><th>Status</th><th class="num">Amount</th><th>Created</th><th>Application status</th></tr>';
  matches.slice(0,LOOKUP_CAP).forEach(r=>{
    const appLab=stageLabel(r.appStage)+(r.appDeclined?' (declined)':'');
    h+='<tr><td>'+esc(r.id)+'</td><td>'+esc(r.ref)+'</td><td>'+esc(r.civilId)+'</td><td>'+esc(r.name||'—')+'</td><td>'+esc(r.mobile||'—')+'</td><td>'+esc(r.branch)+'</td><td><span class="status-pill status-'+esc(r.status)+'">'+esc(r.status)+'</span></td><td class="num">'+(r.amount?money(r.amount):'—')+'</td><td>'+esc(r.created||'—')+(r.createdTime?' '+r.createdTime:'')+'</td><td>'+esc(appLab)+'</td></tr>';
  });
  document.getElementById('lookup-table').innerHTML=matches.length?h:'<tr><td style="text-align:center;color:var(--faint)">No matching referrals.</td></tr>';
  document.getElementById('lookup-note').textContent=matches.length>LOOKUP_CAP?('Showing first '+LOOKUP_CAP+' of '+fmt(matches.length)+' matching rows -- narrow the filters to see more specific results.'):'';
}
function initLookup(){
  const statuses=[...new Set(SNB_DATA.rows.map(r=>r.status))].sort();
  const sel=document.getElementById('l-status');
  statuses.forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;sel.appendChild(o);});
  const branches=[...new Set(SNB_DATA.rows.map(r=>r.branch))].filter(Boolean).sort();
  const bsel=document.getElementById('l-branch');
  branches.forEach(b=>{const o=document.createElement('option');o.value=b;o.textContent=b;bsel.appendChild(o);});
  document.getElementById('l-search').addEventListener('input',renderLookup);
  sel.addEventListener('change',renderLookup);
  bsel.addEventListener('change',renderLookup);
  document.getElementById('l-reset').addEventListener('click',()=>{document.getElementById('l-search').value='';sel.value='';bsel.value='';renderLookup();});
}

function renderAll(){
  const rows=filteredRows();
  document.getElementById('summary-hint').textContent=(FROM||SNB_DATA.meta.min)+' → '+(TO||SNB_DATA.meta.max);
  renderKpis(rows);
  renderTrend(rows);
  renderStatusTable(rows);
  renderFunnel(rows);
  renderFunnelTrend(rows);
  renderBranches(rows);
  renderLookup();
}

function render(){
  const m=SNB_DATA.meta;
  document.getElementById('source-hint').textContent=
    'Source: '+m.sourceFile+' · '+fmt(m.total)+' referrals · '+m.min+' → '+m.max+' · generated '+m.generatedAt;
  document.getElementById('f-from').min=document.getElementById('f-to').min=m.min;
  document.getElementById('f-from').max=document.getElementById('f-to').max=m.max;
  document.getElementById('f-from').value=m.min;
  document.getElementById('f-to').value=m.max;
  initLookup();
  renderAll();
}
render();
</script>
</body></html>
`;
}
