/**
 * Update SIMAH_Intelligence.html from a "SIMAH_Qarar_JSON_*.csv" export
 * (columns: Response_Date, JSON_Response, Analytics_Report_Date — one row
 * per SIMAH report, JSON_Response holds {message,isSuccess,data:{...report}}).
 *
 * Usage: node scripts/update_simah_from_qarar_csv.js <path-to-csv> [--replace]
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./pipeline_config.js');

const ROOT = path.resolve(__dirname, '..');
const HTML_OUT = path.join(ROOT, 'SIMAH_Intelligence.html');
const CSV_FILE = process.argv[2];
const cfg = loadConfig();
// This pipeline is ADDITIVE (mergeAggregates sums, not overwrites/dedupes) —
// re-running the same file would silently double-count reports. Once a merge
// succeeds, the source file is MOVED (not copied) out of Downloads into this
// archive folder so it can never be picked up and reprocessed by accident.
// Machine-specific -- see pipeline.config.json / setup_config.js.
const SIMAH_ARCHIVE_FOLDER = cfg.simahArchiveDir;

// User-specified competitor classification (BNPL / NBFI / Bank). Names are
// matched trimmed — several appear with trailing spaces in real SIMAH data.
const COMPETITOR_CATEGORY = {
  'Tamara Finance Company': 'BNPL',
  // 'United Company for Financial Services' (UCFS) is Tasheel itself, not a
  // competitor — deliberately left out of this map so competitorCategory()
  // returns null for it and it's excluded from every competitor-exposure
  // table/chart (Competitor Loan Exposure, Buy-Out Opportunities, Avg Active
  // Loan Amount, Active Loans by Institution).
  'AL RAJHI BANK': 'Bank',
  'Tabby Finance Company': 'BNPL',
  'Emkan Company for Financing': 'NBFI',
  'Saudi National Bank': 'Bank',
  'STC Bank': 'Bank',
  'TAMAM Finance': 'NBFI',
  'QUARA FINANCE': 'NBFI',
  'ARAB NATIONAL BANK': 'Bank',
  'ABDUL LATIF JAMEEL': 'NBFI',
  'Saudi Awwal Bank': 'Bank',
  'IJARAH FINANCE': 'NBFI',
  'SAUDI FRANSI FINANCING AND LEASING COMPANY': 'NBFI',
  'AMLAK': 'NBFI',
  'RIYADH BANK': 'Bank',
  'SOCIAL DEVELOPMENT BANK': 'Bank',
  'EMIRATES BANK': 'Bank',
  'REAL ESTATE DEVELOPMENT FUND': 'Bank',
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

// Excel RATE(nper, pmt, pv, [fv], [type], [guess]) — solves for the periodic
// interest rate of an ordinary annuity via the secant method (same approach
// Excel itself uses). No closed-form solution exists for this equation.
function excelRate(nper, pmt, pv, fv, type, guess) {
  fv = fv || 0; type = type || 0;
  guess = (guess == null) ? 0.1 : guess;
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
    x0 = x1; y0 = y1;
    x1 = rate; y1 = calcY(rate);
    i++;
  }
  return isFinite(rate) ? rate : null;
}

if (!CSV_FILE || !fs.existsSync(CSV_FILE)) {
  console.error('Usage: node scripts/update_simah_from_qarar_csv.js <SIMAH_Qarar_JSON_*.csv> [--replace]');
  process.exit(1);
}

// --- CSV parsing (RFC4180-ish, handles quoted fields with embedded commas/quotes) ---
function parseCsvLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = vals[j] ?? '';
    rows.push(obj);
  }
  return rows;
}

// Reports arrive in at least two wrapper shapes in this export:
//   1) {message, isSuccess, data:[reportObj]}                       — direct bureau pull
//   2) {status, requestType, commandType, responseData:{Results:{   — DecisionSmart run
//        ExecuteDecisionSmartResult:{..., BureauResult:{root:{array:
//          {message, isSuccess, data: reportObj}}}}}}}
// Rather than hardcode both paths, recursively search for the object that has
// the bureau-report signature (providedDemographicsInfo/availableDemographicsInfo).
// DecisionSmart records that never attached a bureau report (no BureauResult key)
// legitimately have no report to find — they're skipped, not a parsing bug.
function findReport(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) { const r = findReport(item, depth + 1); if (r) return r; }
    return null;
  }
  if (obj.providedDemographicsInfo || obj.availableDemographicsInfo) return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') { const r = findReport(v, depth + 1); if (r) return r; }
  }
  return null;
}

// Some report sections (score, prevEnquiries, creditInstrumentDetails, employers,
// personalDefaults/primaryDefaults) come back as a bare object instead of a
// single-element array when there's exactly one entry — normalize defensively.
function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function extractFeatures(rep) {
  const f = {};
  const demId = rep.providedDemographicsInfo?.demIDNumber ||
                rep.availableDemographicsInfo?.demIDNumber || null;
  f.civilId = demId;

  const avail = rep.availableDemographicsInfo || {};
  f.gender = rep.providedDemographicsInfo?.demGender || avail.demGender || 'Unknown';
  f.nationality = avail.demNationality?.couNameEN ||
                  rep.providedDemographicsInfo?.demNationality?.couNameEN || 'Unknown';
  f.city = avail.demCustomerCity || '';
  f.simahIncome = parseFloat(avail.demTotalMonthlyIncome) || 0;
  f.maritalStatus = avail.demMaritalStatus?.statusNameEN || 'Unknown';

  const name = rep.providedDemographicsInfo?.demCustomerName ||
               avail.demCustomerName || '';
  f.name = name;

  const sc = asArray(rep.score)[0];
  f.score = sc ? sc.score : null;
  f.scoreCard = sc?.scoreCard?.scoreCardDescEn || '';
  f.scoreReasons = (sc?.reasonCodes || []).map(r => r.scoreReasonCodeName);
  f.scoreReasonTexts = (sc?.reasonCodes || []).map(r => r.scoreReasonCodeDescEn);

  const si = rep.summaryInfo || {};
  f.activeCreditInstruments = si.summActiveCreditInstruments || 0;
  f.totalLimits = si.summTotalLimits || 0;
  f.totalLiabilities = si.summTotalLiablilites || 0;
  f.utilization = f.totalLimits > 0 ? Math.round((f.totalLiabilities / f.totalLimits) * 100) : 0;
  f.totalDefaults = si.summTotalDefaults || 0;
  f.activeDefaults = si.summDefaults || 0;
  f.currentDelinquent = si.summCurrentDelinquentBalance || 0;
  f.totalEnquiries = si.summPreviousEnquires || 0;
  f.enquiriesThisMonth = si.summPreviousEnquiresThisMonth || 0;

  const reportDate = parseDate(rep.reportDate);
  const enqs = asArray(rep.prevEnquiries);
  let enq30 = 0, enq60 = 0, enq90 = 0, enq180 = 0;
  const competitors = {};
  const enqProducts = {};
  const enqByYear = {};
  const enqByMonth = {};
  const enqByMember = {};
  const enqByProduct = {};
  const enqByType = {};
  enqs.forEach(e => {
    const ed = parseDate(e.prevEnqDate);
    if (reportDate && ed) {
      const diffDays = (reportDate - ed) / 864e5;
      if (diffDays <= 30) enq30++;
      if (diffDays <= 60) enq60++;
      if (diffDays <= 90) enq90++;
      if (diffDays <= 180) enq180++;
    }
    const member = e.prevEnqEnquirer?.memberNameEN || 'Unknown';
    competitors[member] = (competitors[member] || 0) + 1;
    const prod = e.prevEnqProductTypeDesc?.textEn || 'Unknown';
    enqProducts[prod] = (enqProducts[prod] || 0) + 1;
    const eType = e.prevEnqType?.textEn || 'Unknown';
    const yr = e.prevEnqDate ? e.prevEnqDate.slice(-4) : 'Unknown';
    enqByYear[yr] = (enqByYear[yr] || 0) + 1;
    if (ed) {
      const moKey = ed.getFullYear() + '-' + String(ed.getMonth()+1).padStart(2,'0');
      enqByMonth[moKey] = (enqByMonth[moKey] || 0) + 1;
    }
    enqByMember[member] = (enqByMember[member] || 0) + 1;
    enqByProduct[prod] = (enqByProduct[prod] || 0) + 1;
    enqByType[eType] = (enqByType[eType] || 0) + 1;
  });
  f.enq30 = enq30; f.enq60 = enq60; f.enq90 = enq90; f.enq180 = enq180;
  f.competitors = competitors;
  f.enqProducts = enqProducts;
  f.enqByYear = enqByYear;
  f.enqByMonth = enqByMonth;
  f.enqByMember = enqByMember;
  f.enqByProduct = enqByProduct;
  f.enqByType = enqByType;

  const cis = asArray(rep.creditInstrumentDetails);
  let bnplCount = 0, bnplBal = 0, totalInstallments = 0, activeLoans = 0;
  let totalOutstanding = 0, totalPastDue = 0;
  const productTypes = {};
  const creditors = {};
  const activePLNStats = {}; // per-creditor {sum, n} of ciLimit for active Personal Loans
  let hasMortgage = false;
  const competitorLoans = []; // active NBFI/BNPL loans: {institution, category, amount, installment, tenureMonths, annualRatePct}
  let competitorInstallmentSum = 0;
  cis.forEach(ci => {
    // 'A' = Active per creditInstrumentStatusDescEn ("Active"/"Closed"/"Written-off"/
    // "Suspended" -> codes A/C/W/S observed in real SIMAH payloads). The literal 'O'
    // used previously never matches anything, so every active-loan metric derived
    // from this loop (activeLoans, institutionLoanStats, totalOutstanding,
    // totalPastDue, totalInstallments, estimatedDBR) was silently always zero.
    const isActive = ci.ciStatus?.creditInstrumentStatusCode === 'A';
    const prod = ci.ciProductTypeDesc?.textEn || 'Unknown';
    const prodCode = ci.ciProductTypeDesc?.code || '';
    if (isActive) {
      activeLoans++;
      productTypes[prod] = (productTypes[prod] || 0) + 1;
      const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
      creditors[cred] = (creditors[cred] || 0) + 1;
      // Mortgage product codes observed in real payloads: MTG, OMTG, RMTG,
      // SMTG, TMTG, MMTG, AMTG, EMTG (all contain 'MTG'), plus AQAR
      // (Government Mortgage Real Estate Fund).
      if (prodCode.includes('MTG') || prodCode === 'AQAR') hasMortgage = true;
      if (prodCode === 'PLN') {
        const s = activePLNStats[cred] || (activePLNStats[cred] = { sum: 0, n: 0 });
        s.sum += Number(ci.ciLimit) || 0; s.n++; // ciLimit is inconsistently typed (string in ~44% of real records)
      }
    }
    // Per-loan detail for NBFI/BNPL/Bank exposure — captured for ANY status
    // (not just active) so views that want the full lending relationship
    // (e.g. Competitors List) can see closed loans too; views scoped to
    // "active" competitor exposure (Buy-Out Opportunities, Competitor Loan
    // Exposure, Buy-Out Conversions) filter on l.status==='Active'
    // themselves. Annual rate (user-specified): Excel
    // =RATE(tenure, -installment, loan amount) * 12.
    {
      const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
      const cat = competitorCategory(cred);
      if (cat === 'NBFI' || cat === 'BNPL' || cat === 'Bank') {
        const amount = Number(ci.ciLimit) || 0;
        const installment = Number(ci.ciInstallmentAmount) || 0;
        const tenureMonths = Number(ci.ciTenure) || 0;
        if (isActive) competitorInstallmentSum += installment;
        let annualRatePct = null;
        if (amount > 0 && tenureMonths > 0 && installment > 0) {
          const monthlyRate = excelRate(tenureMonths, -installment, amount);
          if (monthlyRate != null && isFinite(monthlyRate)) annualRatePct = Math.round(monthlyRate * 12 * 1000) / 10;
        }
        // Buy-Out Opportunities uses a separate, simpler formula (user-specified):
        // ((Instalment × Tenure ÷ Finance Amount) − 1) × (12 ÷ Tenure).
        let buyoutRatePct = null;
        if (amount > 0 && tenureMonths > 0) {
          buyoutRatePct = Math.round(((installment * tenureMonths / amount) - 1) * (12 / tenureMonths) * 1000) / 10;
        }
        // Status codes observed in real payloads: A=Active, C=Closed,
        // W=Written-off, S=Suspended.
        const STATUS_LABEL = { A: 'Active', C: 'Closed', W: 'Written-off', S: 'Suspended' };
        const statusCode = ci.ciStatus?.creditInstrumentStatusCode || '';
        competitorLoans.push({
          institution: cred, category: cat, prodCode,
          amount: Math.round(amount), installment: Math.round(installment),
          tenureMonths, annualRatePct, buyoutRatePct,
          issuedDate: ci.ciIssuedDate || '',
          status: STATUS_LABEL[statusCode] || (statusCode || 'Unknown')
        });
      }
    }
    if (prod === 'Buy Now Pay Later') {
      if (isActive) { bnplCount++; bnplBal += ci.ciOutstandingBalance || 0; }
    }
    if (isActive) {
      totalOutstanding += ci.ciOutstandingBalance || 0;
      totalPastDue += ci.ciPastDue || 0;
      totalInstallments += ci.ciInstallmentAmount || 0;
    }
  });
  f.bnplCount = bnplCount;
  f.bnplBalance = Math.round(bnplBal);
  f.activeLoans = activeLoans;
  f.totalOutstanding = Math.round(totalOutstanding);
  f.totalPastDue = Math.round(totalPastDue);
  f.totalInstallments = Math.round(totalInstallments);
  f.activeProductTypes = productTypes;
  f.activeCreditors = creditors;
  f.activePLNStats = activePLNStats;
  f.hasMortgage = hasMortgage;
  f.competitorLoans = competitorLoans;
  f.competitorDBR = f.simahIncome > 0
    ? Math.round((competitorInstallmentSum / f.simahIncome) * 100) : null;

  f.estimatedDBR = f.simahIncome > 0
    ? Math.round((f.totalInstallments / f.simahIncome) * 100) : null;

  const pDefs = asArray(rep.personalDefaults || rep.primaryDefaults);
  f.defaultCount = pDefs.length;
  f.defaultsSettled = pDefs.filter(d =>
    d.pDefaultStatuses?.defaultStatusCode === 'FS').length;
  f.defaultsActive = pDefs.filter(d =>
    d.pDefaultStatuses?.defaultStatusCode !== 'FS').length;

  const emps = asArray(rep.employers);
  const currentEmp = emps.find(e =>
    e.empStatusType?.employerStatusTypeCode?.trim() === 'C');
  f.employerName = currentEmp?.empEmployerNameDescEn || '';
  f.employerIncome = currentEmp?.empIncome || 0;

  f.enquiryDetails = enqs.slice(0, 50).map(e => [
    // memberShortNameEN is frequently blank in real SIMAH payloads — fall back
    // to the full member name rather than leaving the institution unidentified.
    e.prevEnqEnquirer?.memberShortNameEN || e.prevEnqEnquirer?.memberNameEN || '',
    e.prevEnqProductTypeDesc?.textEn || '',
    e.prevEnqType?.textEn || '',
    e.prevEnqDate ? e.prevEnqDate.slice(-4) : '',
    e.prevEnqDate || ''
  ]);

  return f;
}

function scoreBand(s) {
  if (s == null) return 'No Score';
  if (s < 400) return '300-399';
  if (s < 500) return '400-499';
  if (s < 550) return '500-549';
  if (s < 600) return '550-599';
  if (s < 650) return '600-649';
  if (s < 700) return '650-699';
  if (s < 750) return '700-749';
  return '750-850';
}
function enqBand(n) {
  if (n === 0) return '0';
  if (n <= 2) return '1-2';
  if (n <= 5) return '3-5';
  if (n <= 10) return '6-10';
  return '11+';
}
function utilizBand(u) {
  if (u <= 20) return '0-20%';
  if (u <= 40) return '21-40%';
  if (u <= 60) return '41-60%';
  if (u <= 80) return '61-80%';
  return '81-100%+';
}
function dbrBand(d) {
  if (d == null) return 'Unknown';
  if (d <= 20) return '0-20%';
  if (d <= 30) return '21-30%';
  if (d <= 40) return '31-40%';
  if (d <= 50) return '41-50%';
  return '50%+';
}
function shoppingBand(n) {
  if (n <= 2) return '0-2';
  if (n <= 5) return '3-5';
  if (n <= 10) return '6-10';
  return '11+';
}

function buildAggregates(features, acqMap) {
  const agg = {
    meta: { total: features.length, matched: 0, unmatched: 0, reportDate: new Date().toISOString().slice(0, 10), submittedMin: null, submittedMax: null },
    scoreDistribution: {},
    enqIntensity: {},
    competitorRank: {},
    competitorByOutcome: {},
    productEnquiries: {},
    utilizationBands: {},
    dbrBands: {},
    scoreReasonFreq: {},
    incomeMatch: { match: 0, mismatch: 0, noData: 0 },
    declineByScore: {},
    rawRecords: [],
    scoreReasonDescs: {},
    enquirerNames: {},
    productNames: {},
    typeNames: {},
    allYears: new Set(),
    enquirerStats: {},
    shoppingBands: {},
    institutionLoanStats: {},
    ucfsAvgFinAmount: 0,
    enqByMember: {},
    enqByProduct: {},
    enqByType: {},
    enqByMonth: {},
    totalEnquiries: 0
  };

  const BOOKED = new Set(['Completed [C]', 'Pending Final Approval']);
  let ucfsSum = 0, ucfsN = 0;

  features.forEach(f => {
    const acq = acqMap[f.civilId];
    const matched = !!acq;
    if (matched) agg.meta.matched++;
    else agg.meta.unmatched++;
    // Track the true submitted-date span across ALL processed records, not
    // just the ones retained in the capped rawRecords cache.
    if (acq?.submitted) {
      if (!agg.meta.submittedMin || acq.submitted < agg.meta.submittedMin) agg.meta.submittedMin = acq.submitted;
      if (!agg.meta.submittedMax || acq.submitted > agg.meta.submittedMax) agg.meta.submittedMax = acq.submitted;
    }

    const isApproved = acq?.Approvalflag === 'Y';
    const isBooked = acq ? BOOKED.has(acq.Altitudestatus) : false;
    const isStp = acq ? (acq.STP === '1' || acq.STP === 1) : false;

    const sb = scoreBand(f.score);
    const sd = agg.scoreDistribution[sb] || (agg.scoreDistribution[sb] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    sd.sub++; if (isApproved) sd.approved++; if (isBooked) sd.booked++; if (isStp) sd.stp++;

    const eb = enqBand(f.enq90);
    const ei = agg.enqIntensity[eb] || (agg.enqIntensity[eb] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    ei.sub++; if (isApproved) ei.approved++; if (isBooked) ei.booked++; if (isStp) ei.stp++;

    for (const [comp, cnt] of Object.entries(f.competitors)) {
      agg.competitorRank[comp] = (agg.competitorRank[comp] || 0) + cnt;
      const co = agg.competitorByOutcome[comp] || (agg.competitorByOutcome[comp] = { sub: 0, approved: 0, booked: 0 });
      co.sub++; if (isApproved) co.approved++; if (isBooked) co.booked++;
    }

    for (const [prod, cnt] of Object.entries(f.enqProducts)) {
      agg.productEnquiries[prod] = (agg.productEnquiries[prod] || 0) + cnt;
    }

    const ub = utilizBand(f.utilization);
    if (!agg.utilizationBands[ub]) agg.utilizationBands[ub] = { sub: 0, approved: 0, booked: 0, stp: 0, acqMatched: 0, acqRows: 0, acqApproved: 0 };
    const ui = agg.utilizationBands[ub];
    ui.sub++; if (isApproved) ui.approved++; if (isBooked) ui.booked++; if (isStp) ui.stp++;
    if (matched) { ui.acqMatched++; ui.acqRows++; if (isApproved) ui.acqApproved++; }

    const db = dbrBand(f.estimatedDBR);
    const di = agg.dbrBands[db] || (agg.dbrBands[db] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    di.sub++; if (isApproved) di.approved++; if (isBooked) di.booked++; if (isStp) di.stp++;

    f.scoreReasons.forEach((r, i) => {
      agg.scoreReasonFreq[r] = (agg.scoreReasonFreq[r] || 0) + 1;
      if (!agg.scoreReasonDescs[r] && f.scoreReasonTexts[i])
        agg.scoreReasonDescs[r] = f.scoreReasonTexts[i];
    });

    if (acq && f.simahIncome > 0) {
      const declared = parseFloat(acq.Income) || 0;
      if (declared > 0) {
        const ratio = declared / f.simahIncome;
        if (ratio >= 0.8 && ratio <= 1.2) agg.incomeMatch.match++;
        else agg.incomeMatch.mismatch++;
      } else agg.incomeMatch.noData++;
    } else agg.incomeMatch.noData++;

    if (acq && !isApproved && acq.SimplifiedDeclinedReason) {
      const dbs = agg.declineByScore[sb] || (agg.declineByScore[sb] = {});
      dbs[acq.SimplifiedDeclinedReason] = (dbs[acq.SimplifiedDeclinedReason] || 0) + 1;
    }

    const shopB = shoppingBand(f.enq90);
    if (!agg.shoppingBands[shopB]) agg.shoppingBands[shopB] = { sub: 0, approved: 0, booked: 0 };
    agg.shoppingBands[shopB].sub++;
    if (isApproved) agg.shoppingBands[shopB].approved++;
    if (isBooked) agg.shoppingBands[shopB].booked++;

    for (const [k, v] of Object.entries(f.enqByMember || {})) agg.enqByMember[k] = (agg.enqByMember[k] || 0) + v;
    for (const [k, v] of Object.entries(f.enqByProduct || {})) agg.enqByProduct[k] = (agg.enqByProduct[k] || 0) + v;
    for (const [k, v] of Object.entries(f.enqByType || {})) agg.enqByType[k] = (agg.enqByType[k] || 0) + v;
    for (const [k, v] of Object.entries(f.enqByMonth || {})) agg.enqByMonth[k] = (agg.enqByMonth[k] || 0) + v;
    for (const [k, v] of Object.entries(f.enqByYear || {})) agg.allYears.add(k);
    agg.totalEnquiries += f.totalEnquiries;

    for (const [inst, cnt] of Object.entries(f.activeCreditors || {})) {
      if (!agg.institutionLoanStats[inst]) agg.institutionLoanStats[inst] = { loans: 0, customers: 0, plnSum: 0, plnN: 0 };
      agg.institutionLoanStats[inst].loans += cnt;
      agg.institutionLoanStats[inst].customers++;
    }
    for (const [inst, s] of Object.entries(f.activePLNStats || {})) {
      if (!agg.institutionLoanStats[inst]) agg.institutionLoanStats[inst] = { loans: 0, customers: 0, plnSum: 0, plnN: 0 };
      agg.institutionLoanStats[inst].plnSum += s.sum;
      agg.institutionLoanStats[inst].plnN += s.n;
    }

    if (matched && acq.FIN_AMOUNT) {
      ucfsSum += parseFloat(acq.FIN_AMOUNT) || 0;
      ucfsN++;
    }

    if (agg.rawRecords.length < 5000) {
      const topComp = Object.entries(f.competitors).sort((a,b)=>b[1]-a[1]).slice(0,7)
        .map(([name,cnt])=>({name,cnt}));
      agg.rawRecords.push({
        civilId: f.civilId ? f.civilId.slice(0, 4) + '****' + f.civilId.slice(-2) : 'N/A',
        name: f.name,
        score: f.score,
        scoreCard: f.scoreCard,
        scoreReasons: f.scoreReasons,
        scoreReasonTexts: f.scoreReasonTexts,
        enq90: f.enq90, enq30: f.enq30, enq180: f.enq180,
        totalEnquiries: f.totalEnquiries,
        enquiriesThisMonth: f.enquiriesThisMonth,
        activeLoans: f.activeLoans,
        activeCreditInstruments: f.activeCreditInstruments,
        bnpl: f.bnplCount, bnplBalance: f.bnplBalance,
        totalLimits: f.totalLimits, totalLiabilities: f.totalLiabilities,
        utilization: f.utilization,
        totalOutstanding: f.totalOutstanding, totalPastDue: f.totalPastDue,
        totalInstallments: f.totalInstallments,
        estDBR: f.estimatedDBR,
        defaults: f.defaultCount, defaultsSettled: f.defaultsSettled, defaultsActive: f.defaultsActive,
        totalDefaultAmt: f.totalDefaults,
        currentDelinquent: f.currentDelinquent,
        simahIncome: f.simahIncome,
        employerName: f.employerName,
        nationality: f.nationality,
        gender: f.gender,
        maritalStatus: f.maritalStatus,
        city: f.city,
        topCompetitors: topComp,
        eq: f.enquiryDetails || [],
        outcome: matched ? (acq.Altitudestatus || 'Matched') : 'No match',
        stp: isStp ? 'Y' : 'N',
        approved: isApproved ? 'Y' : 'N',
        booked: isBooked ? 'Y' : 'N',
        stagingId: acq?.StagingID || '',
        declineReason: acq?.SimplifiedDeclinedReason || '',
        deDecision: acq?.DE_Decision || '',
        lightDE: acq?.Light_DE_Decision || '',
        store: acq?.StoreNameOnline || acq?.StoreName || '',
        region: acq?.Region || '',
        product: acq?.Product_type || '',
        source: acq?.SubmitSource || '',
        submitted: acq?.submitted || '',
        riskRating: acq?.RiskRating || '',
        scRiskGrade: acq?.SC_RiskGrade || '',
        declaredIncome: parseFloat(acq?.Income) || 0,
        incomeBand: acq?.DeclaredIncomeBand || '',
        ageBand: acq?.AgeBand || '',
        revisedDBR: acq?.Revised_DBR || '',
        smhDBR: acq?.SMH_CurrentDBR || '',
        smhInstallments: acq?.SMH_MonthlyInstalments || '',
        smhScore: acq?.SMH_Score || '',
        smhBand: acq?.SMHBand || '',
        gosiCalled: acq?.Is_GOSI_Called || '',
        mofCalled: acq?.Is_MOF_Called || '',
        employerType: acq?.FinalEmployerType || '',
        hasMortgage: f.hasMortgage ? 'Y' : 'N',
        altitudeIncome: parseFloat(acq?.AltitudeIncome) || 0,
        competitorLoans: f.competitorLoans || [],
        competitorDBR: f.competitorDBR
      });
    }
  });

  agg.allYears = [...agg.allYears].sort();
  agg.ucfsAvgFinAmount = ucfsN ? Math.round(ucfsSum / ucfsN) : 0;
  agg._ucfsSum = ucfsSum; agg._ucfsN = ucfsN;

  features.forEach(f => {
    f.enquiryDetails?.forEach(eq => {
      if (eq[0]) agg.enquirerNames[eq[0]] = eq[0];
      if (eq[1]) agg.productNames[eq[1]] = eq[1];
      if (eq[2]) agg.typeNames[eq[2]] = eq[2];
    });
  });

  return agg;
}

function findLatestAcqFile() {
  // Prefer the merged dataset (same columns, deduped by StagingID, always
  // the most complete/current view) over any single dated snapshot. This
  // matters now that merge_csv.js archives every dated snapshot out of the
  // project root after merging it (see scripts/merge_csv.js) -- before that
  // archiving existed, this function's old dated-file-only fallback would
  // silently pick up a stale historical snapshot (e.g. May 2026) instead of
  // current data once the daily files were gone from the root, joining
  // every SIMAH report against months-old Acquisition rows without warning.
  const mergedPath = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
  if (fs.existsSync(mergedPath)) return 'Acquisition_for_Loans_all_merged.csv';
  return fs.readdirSync(ROOT)
    .filter(f => /^Acquisition_for_Loans_\d{4}-\d{2}-\d{2}\.csv$/i.test(f))
    .sort().pop();
}

function mergeBandMap(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => {
    const av = a[k] || {}, bv = b[k] || {};
    const subKeys = new Set([...Object.keys(av), ...Object.keys(bv)]);
    out[k] = {};
    subKeys.forEach(sk => { out[k][sk] = (av[sk] || 0) + (bv[sk] || 0); });
  });
  return out;
}
function mergeCountMap(a, b) {
  const out = { ...a };
  Object.entries(b || {}).forEach(([k, v]) => { out[k] = (out[k] || 0) + v; });
  return out;
}
function mergeLabelMap(a, b) {
  return { ...b, ...a };
}
function mergeRawRecords(oldRecs, newRecs, cap) {
  const all = [...oldRecs, ...newRecs];
  const dated = all.filter(r => r.submitted).sort((a, b) => b.submitted.localeCompare(a.submitted));
  const undated = all.filter(r => !r.submitted);
  return [...dated, ...undated].slice(0, cap);
}
function mergeAggregates(oldAgg, newAgg) {
  const merged = {
    meta: {
      total: oldAgg.meta.total + newAgg.meta.total,
      matched: oldAgg.meta.matched + newAgg.meta.matched,
      unmatched: oldAgg.meta.unmatched + newAgg.meta.unmatched,
      reportDate: newAgg.meta.reportDate > oldAgg.meta.reportDate ? newAgg.meta.reportDate : oldAgg.meta.reportDate,
      simahFiles: (oldAgg.meta.simahFiles || 0) + (newAgg.meta.simahFiles || 0),
      parseErrors: (oldAgg.meta.parseErrors || 0) + (newAgg.meta.parseErrors || 0),
      acqFile: newAgg.meta.acqFile || oldAgg.meta.acqFile,
      mergedBatches: (oldAgg.meta.mergedBatches || 1) + 1,
      submittedMin: [oldAgg.meta.submittedMin, newAgg.meta.submittedMin].filter(Boolean).sort()[0] || null,
      submittedMax: [oldAgg.meta.submittedMax, newAgg.meta.submittedMax].filter(Boolean).sort().pop() || null,
      // Carry the dateChunks manifest forward untouched -- this script never
      // rebuilds it (only scripts/build_simah_datechunks.js does), and
      // previously rebuilding `meta` from scratch here silently DROPPED these
      // fields on every merge, collapsing the top date-picker's range down to
      // just submittedMin/Max and breaking Competitors List's full-history
      // load (which requires meta.dateChunks to be present). Re-run
      // build_simah_datechunks.js after this whenever a new archive file
      // lands so the manifest itself stays current -- this carry-forward is
      // just the safety net so a merge alone can never destroy it.
      dateChunks: oldAgg.meta.dateChunks,
      dateChunksMin: oldAgg.meta.dateChunksMin,
      dateChunksMax: oldAgg.meta.dateChunksMax,
      dateChunksTotal: oldAgg.meta.dateChunksTotal,
      // Same carry-forward reasoning as the dateChunks* fields above --
      // this one is what makes build_simah_datechunks.js's incremental
      // mode work at all. Missing here once already caused a merge to
      // silently drop it, which made the next datechunks run think NO
      // files had ever been processed and fall back to a full ~250-file
      // rebuild (confirmed live: 2026-09, cost hours instead of minutes).
      dateChunksSourceFiles: oldAgg.meta.dateChunksSourceFiles
    },
    scoreDistribution: mergeBandMap(oldAgg.scoreDistribution, newAgg.scoreDistribution),
    enqIntensity: mergeBandMap(oldAgg.enqIntensity, newAgg.enqIntensity),
    competitorRank: mergeCountMap(oldAgg.competitorRank, newAgg.competitorRank),
    competitorByOutcome: mergeBandMap(oldAgg.competitorByOutcome, newAgg.competitorByOutcome),
    productEnquiries: mergeCountMap(oldAgg.productEnquiries, newAgg.productEnquiries),
    utilizationBands: mergeBandMap(oldAgg.utilizationBands, newAgg.utilizationBands),
    dbrBands: mergeBandMap(oldAgg.dbrBands, newAgg.dbrBands),
    scoreReasonFreq: mergeCountMap(oldAgg.scoreReasonFreq, newAgg.scoreReasonFreq),
    incomeMatch: {
      match: (oldAgg.incomeMatch.match || 0) + (newAgg.incomeMatch.match || 0),
      mismatch: (oldAgg.incomeMatch.mismatch || 0) + (newAgg.incomeMatch.mismatch || 0),
      noData: (oldAgg.incomeMatch.noData || 0) + (newAgg.incomeMatch.noData || 0)
    },
    declineByScore: mergeBandMap(oldAgg.declineByScore, newAgg.declineByScore),
    // Keep the records with the most recent `submitted` (loan application) date
    // first, capped — older batches previously stayed pinned in place forever
    // (slice(0,5000) kept the FIRST 5000 ever added), which silently hid every
    // later merge from the rawRecords cache used by the date filter and detail
    // tables. Sorting by submitted-desc keeps the cache actually current.
    rawRecords: mergeRawRecords(oldAgg.rawRecords, newAgg.rawRecords, 10000),
    scoreReasonDescs: mergeLabelMap(oldAgg.scoreReasonDescs, newAgg.scoreReasonDescs),
    enquirerNames: mergeLabelMap(oldAgg.enquirerNames, newAgg.enquirerNames),
    productNames: mergeLabelMap(oldAgg.productNames, newAgg.productNames),
    typeNames: mergeLabelMap(oldAgg.typeNames, newAgg.typeNames),
    allYears: [...new Set([...(oldAgg.allYears || []), ...(newAgg.allYears || [])])].sort(),
    enquirerStats: mergeBandMap(oldAgg.enquirerStats, newAgg.enquirerStats),
    shoppingBands: mergeBandMap(oldAgg.shoppingBands, newAgg.shoppingBands),
    institutionLoanStats: mergeBandMap(oldAgg.institutionLoanStats, newAgg.institutionLoanStats),
    enqByMember: mergeCountMap(oldAgg.enqByMember, newAgg.enqByMember),
    enqByProduct: mergeCountMap(oldAgg.enqByProduct, newAgg.enqByProduct),
    enqByType: mergeCountMap(oldAgg.enqByType, newAgg.enqByType),
    enqByMonth: mergeCountMap(oldAgg.enqByMonth, newAgg.enqByMonth),
    totalEnquiries: (oldAgg.totalEnquiries || 0) + (newAgg.totalEnquiries || 0)
  };
  const oldSum = oldAgg._ucfsSum != null ? oldAgg._ucfsSum : (oldAgg.ucfsAvgFinAmount || 0) * (oldAgg.meta.matched || 0);
  const oldN = oldAgg._ucfsN != null ? oldAgg._ucfsN : (oldAgg.meta.matched || 0);
  const newSum = newAgg._ucfsSum || 0, newN = newAgg._ucfsN || 0;
  const totalN = oldN + newN;
  merged.ucfsAvgFinAmount = totalN ? Math.round((oldSum + newSum) / totalN) : 0;
  return merged;
}

// ═══════════════════════ MAIN ═══════════════════════
console.log('=== SIMAH Intelligence Updater (Qarar JSON CSV) ===');
console.log(`Input: ${CSV_FILE}`);

console.log('Reading CSV…');
const csvRows = readCsv(CSV_FILE);
console.log(`Found ${csvRows.length} rows`);

const features = [];
let parseErrors = 0;
csvRows.forEach((row, i) => {
  try {
    const wrapper = JSON.parse(row.JSON_Response);
    const rep = findReport(wrapper);
    if (!rep) { parseErrors++; return; }
    const f = extractFeatures(rep);
    if (f.civilId) features.push(f);
    else parseErrors++;
  } catch (e) {
    parseErrors++;
    if (parseErrors <= 5) console.warn(`  Row ${i+2} parse error: ${e.message.slice(0,80)}`);
  }
});
console.log(`Extracted features from ${features.length} reports (${parseErrors} errors)`);

const acqFile = findLatestAcqFile();
let acqMap = {};
if (acqFile) {
  console.log(`Reading ${acqFile}…`);
  const rows = readCsv(path.join(ROOT, acqFile));
  console.log(`  ${rows.length.toLocaleString()} acquisition rows`);
  rows.forEach(r => { if (r.CivilID) acqMap[r.CivilID] = r; });
  console.log(`  ${Object.keys(acqMap).length.toLocaleString()} unique CivilIDs`);
} else {
  console.warn('No Acquisition CSV found — running SIMAH-only analysis');
}

console.log('Aggregating…');
const agg = buildAggregates(features, acqMap);
agg.meta.simahFiles = features.length;
agg.meta.parseErrors = parseErrors;
agg.meta.acqFile = acqFile || 'none';

console.log('Reading SIMAH_Intelligence.html…');
const htmlTemplate = fs.readFileSync(HTML_OUT, 'utf-8');
const marker = 'const SIMAH_DATA = {';
const startIdx = htmlTemplate.indexOf(marker);
if (startIdx === -1) {
  console.error('ERROR: Could not find SIMAH_DATA marker in HTML template');
  process.exit(1);
}
let depth = 0, endIdx = startIdx + marker.length - 1;
for (let i = endIdx; i < htmlTemplate.length; i++) {
  if (htmlTemplate[i] === '{') depth++;
  else if (htmlTemplate[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}
if (htmlTemplate[endIdx] === ';') endIdx++;

const replaceMode = process.argv.includes('--replace');
let finalAgg = agg;
if (!replaceMode) {
  try {
    const existingRaw = htmlTemplate.slice(startIdx + marker.length - 1, htmlTemplate[endIdx - 1] === ';' ? endIdx - 1 : endIdx);
    const existing = JSON.parse(existingRaw);
    if (existing && existing.meta && existing.meta.total > 0) {
      console.log(`Merging with existing dataset (${existing.meta.total} reports already present)…`);
      finalAgg = mergeAggregates(existing, agg);
    } else {
      console.log('No existing dataset found — writing fresh.');
    }
  } catch (e) {
    console.warn('Could not parse existing SIMAH_DATA, writing fresh:', e.message.slice(0, 100));
  }
} else {
  console.log('--replace passed — discarding any existing dataset.');
}

delete finalAgg._ucfsSum; delete finalAgg._ucfsN;

console.log('Updating SIMAH_Intelligence.html…');
const dataLine = `const SIMAH_DATA = ${JSON.stringify(finalAgg)};`;
const updated = htmlTemplate.slice(0, startIdx) + dataLine + htmlTemplate.slice(endIdx);
fs.writeFileSync(HTML_OUT, updated, 'utf-8');

console.log(`\nDone — ${features.length} new SIMAH reports processed, ${finalAgg.meta.total} total in dataset (${finalAgg.meta.matched} matched to acquisitions).`);
console.log(`Score distribution: ${JSON.stringify(finalAgg.scoreDistribution)}`);

// Archive the source file now that it's safely merged in, so it can never
// be picked up and merged again by accident (see comment on SIMAH_ARCHIVE_FOLDER).
try {
  if (!fs.existsSync(SIMAH_ARCHIVE_FOLDER)) fs.mkdirSync(SIMAH_ARCHIVE_FOLDER, { recursive: true });
  const destPath = path.join(SIMAH_ARCHIVE_FOLDER, path.basename(CSV_FILE));
  if (path.resolve(CSV_FILE) !== path.resolve(destPath)) {
    fs.renameSync(CSV_FILE, destPath);
    console.log(`Archived: ${path.basename(CSV_FILE)} → SIMAH Qarar JSON/`);
  }
} catch (e) {
  console.warn(`WARN: could not archive source file (merge already succeeded, data is safe): ${e.message}`);
}
