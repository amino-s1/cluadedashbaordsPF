/**
 * "CocoNut v2" tab data builder: for every Tasheel customer with a
 * COMPLETED contract (Altitudestatus === 'Completed [C]' in
 * Acquisition_for_Loans_all_merged.csv), lists every ACTIVE competitor
 * loan reported to SIMAH whose product type is Personal Loan /
 * Microfinance / Consumer Durables Loan / Social Loan -- deliberately
 * excluding Buy Now Pay Later, Top-Up Loan, mobile-phone plans, credit
 * cards, mortgages, car leases, etc. even though those also appear as
 * SIMAH-reported credit instruments. Layout matches the user-supplied
 * reference workbook UCFS_vs_Competitors_2.xlsx ("Customer comparison"
 * sheet) column-for-column.
 *
 * Row grain: one row per (customer, competitor loan) -- if a customer has
 * loans with 2+ different lenders they ALL appear as separate rows, never
 * combined into one column/cell. A completed customer who WAS found in the
 * SIMAH archive but has NO active matching-product-type competitor loan
 * still gets exactly one row, with blank competitor fields (matches the
 * reference workbook's convention) -- this is different from a customer
 * never found in SIMAH at all, who we genuinely have no read on and so
 * don't include.
 *
 * Source of UCFS customer/loan details: Acquisition_for_Loans_all_merged.csv
 * -- the same underlying dataset Acquisition_Command_Dashboard.html itself
 * reads. A previous version of this script used a one-off MASTER CSV
 * export instead, but that file only covers whatever narrow window it
 * happened to be exported for (18,430 completed customers); Acquisition's
 * merged dataset goes back to 2025-10-06 and is kept current by every
 * daily merge (44,846 completed customers all-time, 98.1% civilId overlap
 * with MASTER's set when cross-checked) -- so it's used instead, per user
 * request not to be capped to MASTER's narrower population.
 *
 * Usage: node --max-old-space-size=8192 scripts/build_coconut_v2.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'SIMAH_Intelligence.html');
const ARCHIVE_DIR = path.join('C:', 'Users', 'Emad.Ayyash', 'OneDrive - tasheelfinance', 'Documents', 'EIA Work', 'AI-Work', 'SIMAH Qarar JSON');
// Switched from the MASTER export (18,430 completed customers, scoped to
// whatever window that one-off file happened to cover, Apr30-Aug30) to
// Acquisition_for_Loans_all_merged.csv -- the same underlying dataset
// Acquisition_Command_Dashboard.html itself reads, going back to
// 2025-10-06 and covering every daily merge since (44,846 completed
// customers all-time, verified 98.1% civilId overlap with MASTER's set
// when cross-checked earlier). User asked not to be capped to MASTER's
// narrower population.
const ACQ_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');

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

// civilId -> [{stagingId, nationality, itemValue, tenure, profitAmount, ucfsRate, salesCompletedDate, submitted}]
function buildCompletedMasterByCivil() {
  console.log('Reading', ACQ_CSV, 'for completed UCFS loan details…');
  const raw = fs.readFileSync(ACQ_CSV, 'utf-8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const idx = name => headers.indexOf(name);
  const iStatus = idx('Altitudestatus'), iStaging = idx('StagingID'), iCivil = idx('CivilID'),
    iNat = idx('NATIONALITY'), iItem = idx('ItemValue'), iTenure = idx('TENURE'),
    iProfit = idx('PROFIT_AMOUNT'), iSales = idx('SalesCompletedDate'), iSubmitted = idx('submitted'),
    iAltIncome = idx('AltitudeIncome'), iSmartFinance = idx('SmartFinance');
  const map = new Map();
  let completedCount = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = parseCsvLine(lines[i]);
    const status = vals[iStatus], sid = vals[iStaging], civ = (vals[iCivil] || '').trim();
    if (!sid || !civ) continue;
    if (status !== 'Completed [C]') continue;
    completedCount++;
    const itemValue = Math.round(Number(vals[iItem])) || null;
    const tenure = Number(vals[iTenure]) || null;
    const profitAmount = Math.round(Number(vals[iProfit])) || null;
    // Per user spec: UCFS profit rate = (ProfitAmount / ItemValue) / ApprovedTenure * 12
    // (verified against the reference workbook's own "Profit rate" column).
    let ucfsRate = null;
    if (itemValue > 0 && tenure > 0 && profitAmount != null) {
      ucfsRate = Math.round((profitAmount / itemValue) / tenure * 12 * 1000) / 10;
    }
    let arr = map.get(civ);
    if (!arr) { arr = []; map.set(civ, arr); }
    arr.push({
      stagingId: sid,
      nationality: vals[iNat] || '',
      itemValue, tenure, profitAmount, ucfsRate,
      salesCompletedDate: vals[iSales] || '',
      submitted: vals[iSubmitted] || (vals[iSales] || '').slice(0, 10),
      // altitudeIncome: raw AltitudeIncome column (SAR). smartFinance: the
      // SmartFinance column is blank for a normal underwriting path, or a
      // comma-joined list of exception reasons (e.g. "Cat C companies",
      // "Age 21 - 23") when the loan went through Smart Finance criteria --
      // classified per user spec as blank -> Normal, anything else -> Smart Finance.
      altitudeIncome: iAltIncome >= 0 ? (Math.round(Number(vals[iAltIncome])) || null) : null,
      smartFinance: (iSmartFinance >= 0 && (vals[iSmartFinance] || '').trim()) ? 'Smart Finance' : 'Normal'
    });
  }
  console.log(`  ${map.size.toLocaleString()} unique civilIds have >=1 completed loan (${completedCount.toLocaleString()} completed rows total)`);
  return map;
}

// Personal-finance product types only, per user spec -- deliberately
// excludes Buy Now Pay Later (the single largest SIMAH product type by
// volume), Top-Up Loan, Mobile Phone, Credit Card, Mortgage, Car Lease, etc.
const ALLOWED_PRODUCT_TYPES = new Set([
  'Personal Loan', 'Microfinance', 'Consumer Durables Loan', 'Social Loan'
]);
const COMPETITOR_CATEGORY = {
  'Tamara Finance Company': 'BNPL', 'AL RAJHI BANK': 'Bank', 'Tabby Finance Company': 'BNPL',
  'Emkan Company for Financing': 'NBFI', 'Saudi National Bank': 'Bank', 'STC Bank': 'Bank',
  'TAMAM Finance': 'NBFI', 'QUARA FINANCE': 'NBFI', 'ARAB NATIONAL BANK': 'Bank',
  'ABDUL LATIF JAMEEL': 'NBFI', 'Saudi Awwal Bank': 'Bank', 'IJARAH FINANCE': 'NBFI',
  'SAUDI FRANSI FINANCING AND LEASING COMPANY': 'NBFI', 'AMLAK': 'NBFI', 'RIYADH BANK': 'Bank',
  'SOCIAL DEVELOPMENT BANK': 'Bank', 'EMIRATES BANK': 'Bank', 'REAL ESTATE DEVELOPMENT FUND': 'Bank',
  'ALINMA BANK': 'Bank',
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
function competitorCategory(name) { return COMPETITOR_CATEGORY[(name || '').trim()] || 'Other'; }
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

async function main() {
  console.log('=== CocoNut v2: Completed UCFS loans (Acquisition CSV) x SIMAH active personal-finance competitor loans ===');
  const masterByCivil = buildCompletedMasterByCivil();

  // Newest-first so the seenCivil dedup below (a customer can appear in
  // multiple archived pulls) keeps each customer's MOST RECENT SIMAH
  // report -- the most current view of their active loans -- rather than
  // whichever pull happens to be processed first.
  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /\.csv$/i.test(f)).sort().reverse();
  console.log(`${files.length} archived SIMAH files to scan for matches (newest first)`);

  const rows = []; // {civilId(masked), stagingId, nationality, tasheelProduct, itemValue, approvedTenure, profitAmount, ucfsRate, salesCompletedDate, institution, category, competitorProductType, amount, installment, tenure, compProfitAmount, rate, issuedDate}
  let totalScanned = 0, checkedCustomers = 0, matchedCustomers = 0;
  const seenCivil = new Set(); // avoid double-processing the same civilId if it appears in >1 archive file
  for (const fn of files) {
    const fp = path.join(ARCHIVE_DIR, fn);
    console.log(`Reading ${fn}…`);
    const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let headers = null, idxJson = -1, n = 0;
    for await (const line of rl) {
      if (!headers) { headers = parseCsvLine(line); idxJson = headers.indexOf('JSON_Response'); continue; }
      try {
        const vals = parseCsvLine(line);
        const jsonStr = vals[idxJson];
        if (!jsonStr) continue;
        const rep = findReport(JSON.parse(jsonStr));
        if (!rep) continue;
        const civilId = rep.providedDemographicsInfo?.demIDNumber || rep.availableDemographicsInfo?.demIDNumber || null;
        if (!civilId) continue;
        totalScanned++;
        const masterLoans = masterByCivil.get(civilId);
        if (!masterLoans || !masterLoans.length) continue; // not a completed UCFS customer
        if (seenCivil.has(civilId)) continue; // already produced rows for this customer from an earlier (more recent, files sorted ascending... see note) file
        seenCivil.add(civilId);
        checkedCustomers++;

        // Most recent completed StagingID (by SalesCompletedDate) represents
        // "the" UCFS loan we compare against for this customer.
        const latestMaster = masterLoans.slice().sort((a, b) => (b.salesCompletedDate || '').localeCompare(a.salesCompletedDate || ''))[0];

        const cis = asArray(rep.creditInstrumentDetails);
        const perInst = {}; // "institution|productType" -> latest matching instrument
        cis.forEach(ci => {
          if (ci.ciStatus?.creditInstrumentStatusCode !== 'A') return; // active only
          const prodType = (ci.ciProductTypeDesc?.textEn || '').trim();
          if (!ALLOWED_PRODUCT_TYPES.has(prodType)) return; // personal-finance product types only
          const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
          if (cred.trim() === 'United Company for Financial Services') return; // UCFS is Tasheel itself, not a competitor
          const amount = Number(ci.ciLimit) || 0;
          const installment = Number(ci.ciInstallmentAmount) || 0;
          const tenureMonths = Number(ci.ciTenure) || 0;
          let annualRatePct = null, compProfitAmount = null;
          if (amount > 0 && tenureMonths > 0 && installment > 0) {
            // Competitor "Profit amount" = total repayment over the life of the
            // loan minus principal (installment x tenure - limit); "Profit rate"
            // = that profit annualized as a fraction of the limit -- verified
            // against the reference workbook (matches its own formula exactly).
            compProfitAmount = Math.round(installment * tenureMonths - amount);
            const flatRate = ((installment * tenureMonths / amount) - 1) * (12 / tenureMonths);
            if (isFinite(flatRate)) annualRatePct = Math.round(flatRate * 100 * 10) / 10;
          }
          const issuedDate = ci.ciIssuedDate || '';
          const d = parseDMY(issuedDate);
          const key = cred + '|' + prodType; // don't merge different product types from the same lender
          const existing = perInst[key];
          if (!existing || (d && (!existing.date || d > existing.date))) {
            perInst[key] = {
              institution: cred, category: competitorCategory(cred), competitorProductType: prodType,
              amount: Math.round(amount), installment: Math.round(installment) || null, tenure: tenureMonths || null,
              compProfitAmount, rate: annualRatePct, issuedDate, date: d
            };
          }
        });
        const instKeys = Object.keys(perInst);
        const baseRow = {
          civilId: civilId.slice(0, 4) + '****' + civilId.slice(-2),
          stagingId: latestMaster.stagingId,
          nationality: latestMaster.nationality,
          itemValue: latestMaster.itemValue,
          approvedTenure: latestMaster.tenure,
          profitAmount: latestMaster.profitAmount,
          ucfsRate: latestMaster.ucfsRate,
          salesCompletedDate: latestMaster.salesCompletedDate,
          submitted: latestMaster.submitted,
          altitudeIncome: latestMaster.altitudeIncome,
          smartFinance: latestMaster.smartFinance
        };
        if (!instKeys.length) {
          // Completed customer, checked against SIMAH, no active matching-
          // product-type competitor loan found -- still one row, blank
          // competitor fields (matches the reference workbook's convention).
          rows.push({ ...baseRow, institution: null, category: null, competitorProductType: null, amount: null, installment: null, tenure: null, compProfitAmount: null, rate: null, issuedDate: null });
        } else {
          matchedCustomers++;
          instKeys.forEach(key => {
            const l = perInst[key];
            rows.push({ ...baseRow, institution: l.institution, category: l.category, competitorProductType: l.competitorProductType, amount: l.amount, installment: l.installment, tenure: l.tenure, compProfitAmount: l.compProfitAmount, rate: l.rate, issuedDate: l.issuedDate });
          });
        }
        n++;
      } catch (e) { /* skip malformed row */ }
    }
    console.log(`  ${n} completed-customer matches found in this file`);
  }
  console.log(`Total: ${totalScanned.toLocaleString()} SIMAH records scanned, ${checkedCustomers.toLocaleString()} completed customers found in SIMAH (${matchedCustomers.toLocaleString()} with >=1 active personal-finance competitor loan), ${rows.length.toLocaleString()} output rows`);

  // By-competitor summary using AVERAGES (not medians), per user instruction.
  // Only rows that actually have a competitor loan count toward this.
  const byInst = {};
  rows.filter(r => r.institution).forEach(r => {
    const k = r.institution;
    if (!byInst[k]) byInst[k] = { institution: k, category: r.category, count: 0, itemValueSum: 0, itemValueN: 0, profitAmountSum: 0, profitAmountN: 0, amountSum: 0, installmentSum: 0, installmentN: 0, rateSum: 0, rateN: 0 };
    const b = byInst[k];
    b.count++;
    if (r.itemValue != null) { b.itemValueSum += r.itemValue; b.itemValueN++; }
    if (r.profitAmount != null) { b.profitAmountSum += r.profitAmount; b.profitAmountN++; }
    b.amountSum += r.amount;
    if (r.installment != null) { b.installmentSum += r.installment; b.installmentN++; }
    if (r.rate != null) { b.rateSum += r.rate; b.rateN++; }
  });
  const competitorAverages = Object.values(byInst).map(b => ({
    institution: b.institution, category: b.category, count: b.count,
    avgTasheelItemValue: b.itemValueN ? Math.round(b.itemValueSum / b.itemValueN) : null,
    avgTasheelProfitAmount: b.profitAmountN ? Math.round(b.profitAmountSum / b.profitAmountN) : null,
    avgCompetitorAmount: Math.round(b.amountSum / b.count),
    avgCompetitorInstallment: b.installmentN ? Math.round(b.installmentSum / b.installmentN) : null,
    avgCompetitorRate: b.rateN ? Math.round(b.rateSum / b.rateN * 10) / 10 : null
  })).sort((a, b) => b.count - a.count);

  console.log('By institution (avg competitor amount / avg rate):');
  competitorAverages.forEach(c => console.log(`  ${c.institution.padEnd(48)} n=${c.count} avgAmt=SAR ${c.avgCompetitorAmount} avgRate=${c.avgCompetitorRate}%`));

  const blob = `const COCONUT_V2_DATA = ${JSON.stringify({
    meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      source: path.basename(ACQ_CSV),
      completedCustomers: masterByCivil.size,
      checkedCustomers, matchedCustomers, archiveFiles: files.length,
      allowedProductTypes: [...ALLOWED_PRODUCT_TYPES]
    },
    rows, competitorAverages
  })};\n`;
  const startTag = 'const COCONUT_V2_DATA = ';
  const html = fs.readFileSync(HTML, 'utf-8');
  const s2 = html.indexOf(startTag);
  let newHtml;
  if (s2 !== -1) {
    const endMatch = /\};\r?\n/.exec(html.slice(s2));
    const e2 = s2 + endMatch.index + 1;
    newHtml = html.slice(0, s2) + blob + html.slice(e2);
    console.log('(replaced existing COCONUT_V2_DATA)');
  } else {
    const anchor = 'const SIMAH_ORIG';
    const ai = html.indexOf(anchor);
    if (ai === -1) { console.error('Could not find insertion anchor (const SIMAH_ORIG)'); process.exit(1); }
    newHtml = html.slice(0, ai) + blob + html.slice(ai);
    console.log('(inserted new COCONUT_V2_DATA)');
  }
  fs.writeFileSync(HTML, newHtml, 'utf-8');
  console.log('✅ Done.');
}
main();
