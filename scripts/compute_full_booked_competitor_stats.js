/**
 * One-off, uncapped answer to "how many booked-with-UCFS applications also
 * have an active competitor loan, by company" — SIMAH_Intelligence.html's
 * embedded rawRecords is capped at 10,000 entries (most-recent-submitted
 * first), which currently only spans ~6 days, badly undercounting a
 * "per month" question. This streams every archived SIMAH_Qarar_JSON file
 * (no cap), keeps only the most-recently-submitted pull per customer
 * across ALL of them, and aggregates — without holding full CSV text or
 * full rawRecords objects in memory (streaming, aggregate-only).
 *
 * Usage: node scripts/compute_full_booked_competitor_stats.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join('C:', 'Users', 'Emad.Ayyash', 'OneDrive - tasheelfinance', 'Documents', 'EIA Work', 'AI-Work', 'SIMAH Qarar JSON');

const COMPETITOR_CATEGORY = {
  'Tamara Finance Company': 'BNPL', 'AL RAJHI BANK': 'Bank', 'Tabby Finance Company': 'BNPL',
  'Emkan Company for Financing': 'NBFI', 'Saudi National Bank': 'Bank', 'STC Bank': 'Bank',
  'TAMAM Finance': 'NBFI', 'QUARA FINANCE': 'NBFI', 'ARAB NATIONAL BANK': 'Bank',
  'ABDUL LATIF JAMEEL': 'NBFI', 'Saudi Awwal Bank': 'Bank', 'IJARAH FINANCE': 'NBFI',
  'SAUDI FRANSI FINANCING AND LEASING COMPANY': 'NBFI', 'AMLAK': 'NBFI', 'RIYADH BANK': 'Bank',
  'SOCIAL DEVELOPMENT BANK': 'Bank', 'EMIRATES BANK': 'Bank', 'REAL ESTATE DEVELOPMENT FUND': 'Bank',
  'ALINMA BANK': 'Bank',
  // Added after user question "why can't I see Madfu and other" — these
  // real banks/finance companies were present in raw SIMAH data but missing
  // from this hand-curated allowlist, so their loans were silently dropped
  // from every competitor view. Telecoms, car-rental, retail, HR, and
  // government-commission entities that also appear in SIMAH data are
  // deliberately still excluded here — they report credit facilities too,
  // but aren't personal-loan competitors.
  'MADFU Ltd': 'BNPL',
  'BANK ALJAZIRA': 'Bank', 'BANK AL BILAD': 'Bank', 'BANQUE SAUDI FRANSI': 'Bank',
  'GULF INTERNATIONAL BANK': 'Bank', 'THE SAUDI INVESTMENT BANK': 'Bank',
  'D360 Bank': 'Bank', 'FIRST ABU DHABI BANK': 'Bank',
  'AGRICULTURAL DEVELOPMENT FUND': 'Bank', 'ANB INVEST': 'Bank', 'NCB CAPITAL': 'Bank',
  'ALBilad investment Company': 'Bank',
  'NAYIFAT FINANCE COMPANY': 'NBFI', 'AL YUSR INSTALLMENT CO': 'NBFI', 'Tamweel Aloula': 'NBFI',
  'NATIONAL FINANCE COMPANY': 'NBFI', 'TAAJEER FINANCE': 'NBFI', 'RAYA FINANCING': 'NBFI',
  'SAUDI FINANCE COMPANY': 'NBFI', 'Sanad Finance Company': 'NBFI', 'NATIONAL FINANCE HOUSE': 'NBFI',
  'AL JABR FINANCING CORPORATION': 'NBFI', 'OSOUL MODERN FINANCE CO LTD': 'NBFI',
  'DERAYAH FINANCIAL COMPANY': 'NBFI', 'SHL Finance Company': 'NBFI',
  'MASAR ALNUMOU FINANCE COMPANY': 'NBFI', 'BIDAYA FINANCE COMPANY': 'NBFI',
  'Modern Integrated Solutions Financing Company': 'NBFI', 'Tokilat Finance Company': 'NBFI',
  'LOAN FOR FINANCE': 'NBFI', 'Eitmed Finance Company': 'NBFI', 'Tamwily International Company': 'NBFI',
  'TAAJEER COMPANY': 'NBFI', 'TAAJEER GULF CO': 'NBFI', 'DAR AL TAMLEEK': 'NBFI',
  'DAR ALETIMAN ALSAUDI INSTALLMENT': 'NBFI', 'MORABAHA MARENA': 'NBFI',
  'MATAJR INSTALLMENT COMPANY': 'NBFI', 'NAMA United Financing': 'NBFI', 'TAMKEEN INSTALLMENT CO': 'NBFI',
  'Alan Khaleejia Microfinancing Company': 'NBFI', 'SEWLAH FOR TRADING AND INSTALLMENT': 'NBFI',
  'SULFAH': 'NBFI', 'Seulah al awla': 'NBFI', 'MONEYMOON': 'NBFI', 'GO Money': 'NBFI',
  'MOHOUR EL TEMKIN': 'NBFI', 'EL ALOW FINNACIAL CO RIZE': 'NBFI', 'Fuel Finance': 'NBFI',
  'Alpha Arabia Finance': 'NBFI'
};

function competitorCategory(name) { return COMPETITOR_CATEGORY[(name || '').trim()] || null; }

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
function findReport(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (Array.isArray(obj)) { for (const item of obj) { const r = findReport(item, depth + 1); if (r) return r; } return null; }
  if (obj.providedDemographicsInfo || obj.availableDemographicsInfo) return obj;
  for (const k of Object.keys(obj)) { const v = obj[k]; if (v && typeof v === 'object') { const r = findReport(v, depth + 1); if (r) return r; } }
  return null;
}
function asArray(x) { if (x == null) return []; return Array.isArray(x) ? x : [x]; }

function findLatestAcqFile() {
  // Prefer the merged dataset over any single dated snapshot -- see the
  // matching comment in update_simah_from_qarar_csv.js for why.
  if (fs.existsSync(path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv'))) return 'Acquisition_for_Loans_all_merged.csv';
  return fs.readdirSync(ROOT).filter(f => /^Acquisition_for_Loans_\d{4}-\d{2}-\d{2}\.csv$/i.test(f)).sort().pop();
}

const BOOKED = new Set(['Completed [C]', 'Pending Final Approval']);

async function main() {
  console.log('=== Full (uncapped) booked-with-active-competitor-loan count ===');
  const acqFile = findLatestAcqFile();
  console.log(`Reading ${acqFile}…`);
  const acqRows = readline.createInterface({ input: fs.createReadStream(path.join(ROOT, acqFile), { encoding: 'utf-8' }), crlfDelay: Infinity });
  const acqMap = new Map();
  let acqHeaders = null, idxCiv = -1, idxStatus = -1, idxSubmitted = -1;
  for await (const line of acqRows) {
    if (!acqHeaders) {
      acqHeaders = parseCsvLine(line);
      idxCiv = acqHeaders.indexOf('CivilID'); idxStatus = acqHeaders.indexOf('Altitudestatus'); idxSubmitted = acqHeaders.indexOf('submitted');
      continue;
    }
    const vals = parseCsvLine(line);
    const civ = vals[idxCiv];
    if (!civ) continue;
    acqMap.set(civ, { status: vals[idxStatus] || '', submitted: vals[idxSubmitted] || '' });
  }
  console.log(`  ${acqMap.size.toLocaleString()} unique CivilIDs in Acquisition`);

  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /\.csv$/i.test(f)).sort();
  console.log(`${files.length} archived SIMAH files to process`);

  // customer (civilId) -> { submitted, booked, competitorLoans:[{institution,category,status,issuedDate}] }
  const byCustomer = new Map();
  let totalRows = 0, totalErrs = 0;

  for (const fn of files) {
    const fp = path.join(ARCHIVE_DIR, fn);
    console.log(`Reading ${fn}…`);
    const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let headers = null, idxJson = -1;
    let n = 0, errs = 0;
    for await (const line of rl) {
      if (!headers) { headers = parseCsvLine(line); idxJson = headers.indexOf('JSON_Response'); continue; }
      try {
        const vals = parseCsvLine(line);
        const jsonStr = vals[idxJson];
        if (!jsonStr) { errs++; continue; }
        const wrapper = JSON.parse(jsonStr);
        const rep = findReport(wrapper);
        if (!rep) { errs++; continue; }
        const civilId = rep.providedDemographicsInfo?.demIDNumber || rep.availableDemographicsInfo?.demIDNumber || null;
        if (!civilId) { errs++; continue; }
        const acq = acqMap.get(civilId);
        const booked = acq ? BOOKED.has(acq.status) : false;
        const submitted = acq?.submitted || '';

        const cis = asArray(rep.creditInstrumentDetails);
        const competitorLoans = [];
        cis.forEach(ci => {
          const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
          const cat = competitorCategory(cred);
          if (cat !== 'NBFI' && cat !== 'BNPL' && cat !== 'Bank') return;
          const statusCode = ci.ciStatus?.creditInstrumentStatusCode || '';
          const status = statusCode === 'A' ? 'Active' : (statusCode === 'C' ? 'Closed' : (statusCode === 'W' ? 'Written-off' : (statusCode === 'S' ? 'Suspended' : 'Unknown')));
          competitorLoans.push({ institution: cred, category: cat, status, issuedDate: ci.ciIssuedDate || '' });
        });

        const existing = byCustomer.get(civilId);
        // Keep whichever pull has the latest 'submitted' date (empty/unmatched loses to any matched one; among matched, later submitted wins; among unmatched, last-seen wins as a fallback).
        if (!existing || (submitted && (!existing.submitted || submitted > existing.submitted))) {
          byCustomer.set(civilId, { submitted, booked, competitorLoans });
        }
        n++;
      } catch (e) { errs++; }
    }
    totalRows += n; totalErrs += errs;
    console.log(`  ${n} extracted, ${errs} errors`);
  }
  console.log(`Total: ${totalRows.toLocaleString()} extracted, ${totalErrs.toLocaleString()} errors, ${byCustomer.size.toLocaleString()} unique customers`);

  function parseDMY(s) { const p = (s || '').split('/'); return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]) : null; }

  const byInst = {};
  let bookedCount = 0, bookedWithActiveCompetitor = 0;
  byCustomer.forEach(c => {
    if (!c.booked) return;
    bookedCount++;
    const perInst = {};
    c.competitorLoans.forEach(l => {
      if (l.status !== 'Active') return;
      const d = parseDMY(l.issuedDate);
      const ex = perInst[l.institution];
      if (!ex || (d && (!ex.date || d > ex.date))) perInst[l.institution] = { category: l.category, date: d };
    });
    if (Object.keys(perInst).length) bookedWithActiveCompetitor++;
    Object.entries(perInst).forEach(([inst, p]) => {
      if (!byInst[inst]) byInst[inst] = { institution: inst, category: p.category, count: 0 };
      byInst[inst].count++;
    });
  });

  console.log('');
  console.log(`Total booked (matched Acquisition outcome Completed/Pending Final Approval) customers found in the ${files.length}-day archive: ${bookedCount.toLocaleString()}`);
  console.log(`...of those, have >=1 ACTIVE competitor loan: ${bookedWithActiveCompetitor.toLocaleString()} (${(100 * bookedWithActiveCompetitor / bookedCount).toFixed(1)}%)`);
  console.log('');
  console.log('By company:');
  Object.values(byInst).sort((a, b) => b.count - a.count).forEach(c => {
    console.log(`  ${c.institution.padEnd(48)} ${c.category.padEnd(6)} ${c.count}`);
  });
}
main();
