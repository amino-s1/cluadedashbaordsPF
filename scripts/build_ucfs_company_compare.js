/**
 * For each competitor company in SIMAH_Intelligence.html's Competitors List
 * (Banks + NBFI), find the customers who booked with UCFS AND had an ACTIVE
 * loan at that company, then pull UCFS's OWN booked terms for those exact
 * same customers straight from the Acquisition system (ItemValue = ticket
 * size, PROFIT_RATE = the real profit rate on their UCFS contract) — a
 * genuine apples-to-apples comparison, not the SIMAH self-reported proxy
 * used for the Buy-Out Conversions benchmark bubble.
 *
 * Sources from the FULL archived SIMAH history (streams every
 * SIMAH_Qarar_JSON_*.csv in the archive folder, not SIMAH_Intelligence.
 * html's embedded rawRecords, which is capped at 10,000 entries and can be
 * as narrow as ~6 days once daily volume fills it) — same uncapped
 * approach as scripts/compute_full_booked_competitor_stats.js.
 *
 * Join key: computed here directly from each row's own Acquisition match
 * (StagingID), not from rawRecords' masked civilId.
 *
 * Usage: node scripts/build_ucfs_company_compare.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'SIMAH_Intelligence.html');
const MERGED_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
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

function excelRate(nper, pmt, pv, fv, type, guess) {
  fv = fv || 0; type = type || 0; guess = (guess == null) ? 0.1 : guess;
  const MAX_ITER = 128, PRECISION = 1e-8;
  function calcY(r) {
    if (Math.abs(r) < PRECISION) return pv * (1 + nper * r) + pmt * (1 + r * type) * nper + fv;
    const term = Math.pow(1 + r, nper);
    return pv * term + pmt * (1 / r + type) * (term - 1) + fv;
  }
  let x0 = 0, y0 = calcY(0), x1 = guess, y1 = calcY(guess), i = 0, rate = x1;
  while (Math.abs(y1 - y0) > PRECISION && i < MAX_ITER) {
    rate = (y1 * x0 - y0 * x1) / (y1 - y0);
    if (Math.abs(rate) < PRECISION) rate += 1e-5;
    x0 = x1; y0 = y1; x1 = rate; y1 = calcY(rate); i++;
  }
  return isFinite(rate) ? rate : null;
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
function findReport(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (Array.isArray(obj)) { for (const item of obj) { const r = findReport(item, depth + 1); if (r) return r; } return null; }
  if (obj.providedDemographicsInfo || obj.availableDemographicsInfo) return obj;
  for (const k of Object.keys(obj)) { const v = obj[k]; if (v && typeof v === 'object') { const r = findReport(v, depth + 1); if (r) return r; } }
  return null;
}
function asArray(x) { if (x == null) return []; return Array.isArray(x) ? x : [x]; }
function parseDMY(s) { const p = (s || '').split('/'); return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]) : null; }
function findLatestAcqFile() {
  // Prefer the merged dataset over any single dated snapshot -- see the
  // matching comment in update_simah_from_qarar_csv.js for why.
  if (fs.existsSync(MERGED_CSV)) return path.basename(MERGED_CSV);
  return fs.readdirSync(ROOT).filter(f => /^Acquisition_for_Loans_\d{4}-\d{2}-\d{2}\.csv$/i.test(f)).sort().pop();
}
const BOOKED = new Set(['Completed [C]', 'Pending Final Approval']);

async function main() {
  console.log('=== UCFS vs. each company (Banks + NBFI) builder — full archive ===');

  const acqFile = findLatestAcqFile();
  console.log(`Reading ${acqFile}…`);
  const acqRl = readline.createInterface({ input: fs.createReadStream(path.join(ROOT, acqFile), { encoding: 'utf-8' }), crlfDelay: Infinity });
  const acqMap = new Map(); // CivilID -> {status, submitted, stagingId}
  let acqHeaders = null, idxCiv = -1, idxStatus = -1, idxSubmitted = -1, idxStaging = -1;
  for await (const line of acqRl) {
    if (!acqHeaders) {
      acqHeaders = parseCsvLine(line);
      idxCiv = acqHeaders.indexOf('CivilID'); idxStatus = acqHeaders.indexOf('Altitudestatus');
      idxSubmitted = acqHeaders.indexOf('submitted'); idxStaging = acqHeaders.indexOf('StagingID');
      continue;
    }
    const vals = parseCsvLine(line);
    const civ = vals[idxCiv];
    if (!civ) continue;
    acqMap.set(civ, { status: vals[idxStatus] || '', submitted: vals[idxSubmitted] || '', stagingId: vals[idxStaging] || '' });
  }
  console.log(`  ${acqMap.size.toLocaleString()} unique CivilIDs in Acquisition`);

  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /\.csv$/i.test(f)).sort();
  console.log(`${files.length} archived SIMAH files to process`);

  // customer (civilId) -> { submitted, booked, stagingId, competitorLoans:[...] }
  const byCustomer = new Map();
  for (const fn of files) {
    const fp = path.join(ARCHIVE_DIR, fn);
    console.log(`Reading ${fn}…`);
    const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let headers = null, idxJson = -1, n = 0, errs = 0;
    for await (const line of rl) {
      if (!headers) { headers = parseCsvLine(line); idxJson = headers.indexOf('JSON_Response'); continue; }
      try {
        const vals = parseCsvLine(line);
        const jsonStr = vals[idxJson];
        if (!jsonStr) { errs++; continue; }
        const rep = findReport(JSON.parse(jsonStr));
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
          if (cat !== 'NBFI' && cat !== 'Bank') return; // BNPL excluded — Competitors List scope is Banks + NBFI only
          const statusCode = ci.ciStatus?.creditInstrumentStatusCode || '';
          if (statusCode !== 'A') return; // active only, for this comparison
          const amount = Number(ci.ciLimit) || 0;
          const installment = Number(ci.ciInstallmentAmount) || 0;
          const tenureMonths = Number(ci.ciTenure) || 0;
          let annualRatePct = null;
          if (amount > 0 && tenureMonths > 0 && installment > 0) {
            const monthlyRate = excelRate(tenureMonths, -installment, amount);
            if (monthlyRate != null && isFinite(monthlyRate)) annualRatePct = Math.round(monthlyRate * 12 * 1000) / 10;
          }
          competitorLoans.push({ institution: cred, category: cat, amount: Math.round(amount), annualRatePct, issuedDate: ci.ciIssuedDate || '' });
        });

        const existing = byCustomer.get(civilId);
        if (!existing || (submitted && (!existing.submitted || submitted > existing.submitted))) {
          byCustomer.set(civilId, { submitted, booked, stagingId: acq?.stagingId || '', competitorLoans });
        }
        n++;
      } catch (e) { errs++; }
    }
    console.log(`  ${n} extracted, ${errs} errors`);
  }
  console.log(`Total unique customers: ${byCustomer.size.toLocaleString()}`);

  // Per company: {category, count, rateSum, rateN, amountSum, amountN, stagingIds:Set}
  const byInst = {};
  byCustomer.forEach(c => {
    if (!c.booked || !c.stagingId) return;
    const perCustInst = {};
    c.competitorLoans.forEach(l => {
      const d = parseDMY(l.issuedDate);
      const existing = perCustInst[l.institution];
      if (!existing || (d && (!existing.date || d > existing.date))) {
        perCustInst[l.institution] = { category: l.category, rate: (l.annualRatePct != null && l.annualRatePct >= 0) ? l.annualRatePct : null, amount: (l.amount > 0) ? l.amount : null, date: d };
      }
    });
    Object.entries(perCustInst).forEach(([inst, p]) => {
      if (!byInst[inst]) byInst[inst] = { institution: inst, category: p.category, count: 0, rateSum: 0, rateN: 0, amountSum: 0, amountN: 0, stagingIds: new Set() };
      const b = byInst[inst];
      b.count++;
      if (p.rate != null) { b.rateSum += p.rate; b.rateN++; }
      if (p.amount != null) { b.amountSum += p.amount; b.amountN++; }
      b.stagingIds.add(c.stagingId);
    });
  });
  const companies = Object.values(byInst);
  console.log(`${companies.length} companies (Bank+NBFI) with booked-with-UCFS customers (active loans)`);

  const stagingToCompanies = new Map();
  companies.forEach(c => c.stagingIds.forEach(sid => {
    if (!stagingToCompanies.has(sid)) stagingToCompanies.set(sid, []);
    stagingToCompanies.get(sid).push(c.institution);
  }));
  console.log(`${stagingToCompanies.size} unique StagingIDs to look up in Acquisition for UCFS's own booked terms`);

  console.log('Streaming Acquisition_for_Loans_all_merged.csv for UCFS ticket/rate…');
  const rl2 = readline.createInterface({ input: fs.createReadStream(MERGED_CSV, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let headers2 = null, idxStaging2 = -1, idxStatus2 = -1, idxItemValue = -1, idxProfitRate = -1;
  const ucfsByInst = {};
  let n2 = 0, matched = 0;
  for await (const line of rl2) {
    if (!headers2) {
      headers2 = parseCsvLine(line);
      idxStaging2 = headers2.indexOf('StagingID'); idxStatus2 = headers2.indexOf('Altitudestatus');
      idxItemValue = headers2.indexOf('ItemValue'); idxProfitRate = headers2.indexOf('PROFIT_RATE');
      continue;
    }
    n2++;
    const sid = line.slice(0, line.indexOf(','));
    if (!stagingToCompanies.has(sid)) continue;
    const vals = parseCsvLine(line);
    if (!BOOKED.has(vals[idxStatus2] || '')) continue;
    const val = parseFloat(vals[idxItemValue]);
    const rate = parseFloat(vals[idxProfitRate]) * 100; // decimal fraction -> percent
    stagingToCompanies.get(sid).forEach(inst => {
      if (!ucfsByInst[inst]) ucfsByInst[inst] = { valSum: 0, valN: 0, rateSum: 0, rateN: 0 };
      const u = ucfsByInst[inst];
      if (!isNaN(val) && val > 0) { u.valSum += val; u.valN++; }
      if (!isNaN(rate)) { u.rateSum += rate; u.rateN++; }
    });
    matched++;
  }
  console.log(`  ${n2.toLocaleString()} rows scanned, ${matched.toLocaleString()} matched rows contributed`);

  const result = companies.map(c => {
    const u = ucfsByInst[c.institution] || { valSum: 0, valN: 0, rateSum: 0, rateN: 0 };
    return {
      institution: c.institution, category: c.category, count: c.count,
      companyAvgTicket: c.amountN ? Math.round(c.amountSum / c.amountN) : null,
      companyAvgRate: c.rateN ? Math.round(c.rateSum / c.rateN * 10) / 10 : null,
      ucfsAvgTicket: u.valN ? Math.round(u.valSum / u.valN) : null,
      ucfsAvgRate: u.rateN ? Math.round(u.rateSum / u.rateN * 10) / 10 : null,
      ucfsN: u.valN
    };
  }).filter(c => c.ucfsN > 0).sort((a, b) => b.count - a.count);

  console.log('Results:');
  result.forEach(r => console.log(`  ${r.institution} (${r.category}): ${r.count} cust, company avg ticket SAR ${r.companyAvgTicket}/rate ${r.companyAvgRate}% vs UCFS avg ticket SAR ${r.ucfsAvgTicket}/rate ${r.ucfsAvgRate}%`));

  const blob = `const UCFS_VS_COMPANY = ${JSON.stringify({ meta: { generatedAt: new Date().toISOString().slice(0, 10), archiveFiles: files.length }, companies: result })};\n`;
  const startTag = 'const UCFS_VS_COMPANY = ';
  const html2 = fs.readFileSync(HTML, 'utf-8');
  const s2 = html2.indexOf(startTag);
  let newHtml;
  if (s2 !== -1) {
    const endMatch = /\};\r?\n/.exec(html2.slice(s2));
    const e2 = s2 + endMatch.index + 1;
    newHtml = html2.slice(0, s2) + blob + html2.slice(e2);
    console.log('(replaced existing UCFS_VS_COMPANY)');
  } else {
    const anchor = 'const SIMAH_ORIG';
    const ai = html2.indexOf(anchor);
    if (ai === -1) { console.error('Could not find insertion anchor (const SIMAH_ORIG)'); process.exit(1); }
    newHtml = html2.slice(0, ai) + blob + html2.slice(ai);
    console.log('(inserted new UCFS_VS_COMPANY)');
  }
  fs.writeFileSync(HTML, newHtml, 'utf-8');
  console.log('✅ Done.');
}
main();
