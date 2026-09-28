/**
 * One-off backfill: rebuild rawRecords, meta.submittedMin/submittedMax, and
 * institutionLoanStats in SIMAH_Intelligence.html from the raw
 * SIMAH_Qarar_JSON_*.csv files still available on disk, joined against the
 * latest cumulative Acquisition_for_Loans CSV.
 *
 * Why: buildAggregates()/mergeAggregates() in update_simah_from_qarar_csv.js
 * cap rawRecords at 5000 and always keep the FIRST 5000 ever added (oldest
 * batches), so every batch merged after the cache filled up (long ago)
 * silently vanished from the rawRecords cache — even though the numeric
 * aggregates (score distributions, totals, etc.) correctly reflect all
 * merged batches. Separately, institutionLoanStats was NEVER populated at
 * all across any historical merge, because extractFeatures() checked
 * creditInstrumentStatusCode === 'O' for "active" when the real code is
 * 'A' (confirmed against real payloads: A/C/W/S all appear, 'O' never
 * does). This script does NOT touch any other aggregate field (score
 * distributions, totals, matched/unmatched, etc.) — only rawRecords,
 * meta.submittedMin/submittedMax, and institutionLoanStats are replaced.
 *
 * Usage: node scripts/backfill_simah_rawrecords.js <file1.csv> [file2.csv ...]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const HTML_OUT = path.join(ROOT, 'SIMAH_Intelligence.html');
const RAW_CAP = 10000;

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

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/backfill_simah_rawrecords.js <SIMAH_Qarar_JSON_*.csv> [...]');
  process.exit(1);
}

// --- CSV parsing (identical to update_simah_from_qarar_csv.js) ---
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
function asArray(x) { if (x == null) return []; return Array.isArray(x) ? x : [x]; }
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
function extractFeatures(rep) {
  const f = {};
  const demId = rep.providedDemographicsInfo?.demIDNumber || rep.availableDemographicsInfo?.demIDNumber || null;
  f.civilId = demId;
  const avail = rep.availableDemographicsInfo || {};
  f.gender = rep.providedDemographicsInfo?.demGender || avail.demGender || 'Unknown';
  f.nationality = avail.demNationality?.couNameEN || rep.providedDemographicsInfo?.demNationality?.couNameEN || 'Unknown';
  f.city = avail.demCustomerCity || '';
  f.simahIncome = parseFloat(avail.demTotalMonthlyIncome) || 0;
  f.maritalStatus = avail.demMaritalStatus?.statusNameEN || 'Unknown';
  f.name = rep.providedDemographicsInfo?.demCustomerName || avail.demCustomerName || '';
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
  let enq30 = 0, enq90 = 0, enq180 = 0;
  const competitors = {};
  enqs.forEach(e => {
    const ed = parseDate(e.prevEnqDate);
    if (reportDate && ed) {
      const diffDays = (reportDate - ed) / 864e5;
      if (diffDays <= 30) enq30++;
      if (diffDays <= 90) enq90++;
      if (diffDays <= 180) enq180++;
    }
    const member = e.prevEnqEnquirer?.memberNameEN || 'Unknown';
    competitors[member] = (competitors[member] || 0) + 1;
  });
  f.enq30 = enq30; f.enq90 = enq90; f.enq180 = enq180;
  f.competitors = competitors;
  const cis = asArray(rep.creditInstrumentDetails);
  let bnplCount = 0, bnplBal = 0, totalInstallments = 0, activeLoans = 0, totalOutstanding = 0, totalPastDue = 0;
  const activePLNStats = {};
  const activeCreditors = {};
  let hasMortgage = false;
  const competitorLoans = []; // active NBFI/BNPL loans: {institution, category, amount, installment, tenureMonths, annualRatePct}
  let competitorInstallmentSum = 0;
  cis.forEach(ci => {
    // 'A' = Active (confirmed against real payloads; 'O' never appears).
    const isActive = ci.ciStatus?.creditInstrumentStatusCode === 'A';
    const prod = ci.ciProductTypeDesc?.textEn || 'Unknown';
    const prodCode = ci.ciProductTypeDesc?.code || '';
    if (isActive) {
      activeLoans++;
      const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
      activeCreditors[cred] = (activeCreditors[cred] || 0) + 1;
      // Mortgage product codes observed in real payloads: MTG, OMTG, RMTG,
      // SMTG, TMTG, MMTG, AMTG, EMTG (all contain 'MTG'), plus AQAR
      // (Government Mortgage Real Estate Fund).
      if (prodCode.includes('MTG') || prodCode === 'AQAR') hasMortgage = true;
    }
    // Per-loan detail for NBFI/BNPL/Bank exposure — captured for ANY status
    // (not just active) so views wanting the full lending relationship
    // (e.g. Competitors List) can see closed loans too; views scoped to
    // "active" competitor exposure filter on l.status==='Active'
    // themselves. Annual rate (user-specified):
    // Excel =RATE(tenure, -installment, loan amount) * 12.
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
    if (prod === 'Buy Now Pay Later' && isActive) { bnplCount++; bnplBal += ci.ciOutstandingBalance || 0; }
    if (isActive) {
      totalOutstanding += ci.ciOutstandingBalance || 0;
      totalPastDue += ci.ciPastDue || 0;
      totalInstallments += ci.ciInstallmentAmount || 0;
      if (prodCode === 'PLN') {
        const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
        const s = activePLNStats[cred] || (activePLNStats[cred] = { sum: 0, n: 0 });
        s.sum += Number(ci.ciLimit) || 0; s.n++; // ciLimit is inconsistently typed (string in ~44% of real records)
      }
    }
  });
  f.bnplCount = bnplCount; f.bnplBalance = Math.round(bnplBal); f.activeLoans = activeLoans;
  f.totalOutstanding = Math.round(totalOutstanding); f.totalPastDue = Math.round(totalPastDue);
  f.totalInstallments = Math.round(totalInstallments);
  f.activePLNStats = activePLNStats;
  f.activeCreditors = activeCreditors;
  f.hasMortgage = hasMortgage;
  f.competitorLoans = competitorLoans;
  f.competitorDBR = f.simahIncome > 0 ? Math.round((competitorInstallmentSum / f.simahIncome) * 100) : null;
  f.estimatedDBR = f.simahIncome > 0 ? Math.round((f.totalInstallments / f.simahIncome) * 100) : null;
  const pDefs = asArray(rep.personalDefaults || rep.primaryDefaults);
  f.defaultCount = pDefs.length;
  f.defaultsSettled = pDefs.filter(d => d.pDefaultStatuses?.defaultStatusCode === 'FS').length;
  f.defaultsActive = pDefs.filter(d => d.pDefaultStatuses?.defaultStatusCode !== 'FS').length;
  const emps = asArray(rep.employers);
  const currentEmp = emps.find(e => e.empStatusType?.employerStatusTypeCode?.trim() === 'C');
  f.employerName = currentEmp?.empEmployerNameDescEn || '';
  f.enquiryDetails = enqs.slice(0, 50).map(e => [
    e.prevEnqEnquirer?.memberShortNameEN || e.prevEnqEnquirer?.memberNameEN || '',
    e.prevEnqProductTypeDesc?.textEn || '',
    e.prevEnqType?.textEn || '',
    e.prevEnqDate ? e.prevEnqDate.slice(-4) : '',
    e.prevEnqDate || ''
  ]);
  return f;
}
function findLatestAcqFile() {
  // Prefer the merged dataset over any single dated snapshot -- see the
  // matching comment in update_simah_from_qarar_csv.js for why (merge_csv.js
  // now archives every dated snapshot out of the project root after
  // merging it, so this fallback used to silently resolve to a stale
  // historical file once the daily ones were gone).
  if (fs.existsSync(path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv'))) return 'Acquisition_for_Loans_all_merged.csv';
  return fs.readdirSync(ROOT).filter(f => /^Acquisition_for_Loans_\d{4}-\d{2}-\d{2}\.csv$/i.test(f)).sort().pop();
}

// --- Main ---
console.log('=== SIMAH rawRecords + institutionLoanStats backfill ===');

const acqFile = findLatestAcqFile();
console.log(`Reading ${acqFile}…`);
const acqRows = readCsv(path.join(ROOT, acqFile));
const acqMap = {};
acqRows.forEach(r => { if (r.CivilID) acqMap[r.CivilID] = r; });
console.log(`  ${acqRows.length.toLocaleString()} acquisition rows, ${Object.keys(acqMap).length.toLocaleString()} unique CivilIDs`);

const BOOKED = new Set(['Completed [C]', 'Pending Final Approval']);
const institutionLoanStats = {}; // inst -> {loans, customers, plnSum, plnN}

// Bounded top-RAW_CAP min-heap keyed by `submitted` date (undated = '',
// always lowest priority so it's evicted first, matching the original
// "dated records take priority" rule). Replaces accumulating ALL ~453K
// full-detail records (each carrying eq[]/competitorLoans[]/etc, ~7KB
// average) into one giant array before sorting+slicing at the end -- that
// approach grew unbounded (observed 4.2GB and climbing after only ~1/3 of
// the archive, with V8 GC overhead making each subsequent file slower than
// the last: 30 days in 4 minutes, then 5 days in the next 6h48m). This
// keeps at most RAW_CAP full objects in memory at any time, independent of
// how many total records get scanned.
class MinHeap {
  constructor() { this.a = []; }
  size() { return this.a.length; }
  peekKey() { return this.a[0].key; }
  push(item) { this.a.push(item); this._up(this.a.length - 1); }
  popMin() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) { this.a[0] = last; this._down(0); }
    return top;
  }
  _up(i) { while (i > 0) { const p = (i - 1) >> 1; if (this.a[p].key <= this.a[i].key) break; [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p; } }
  _down(i) {
    const n = this.a.length;
    while (true) {
      let s = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.a[l].key < this.a[s].key) s = l;
      if (r < n && this.a[r].key < this.a[s].key) s = r;
      if (s === i) break;
      [this.a[s], this.a[i]] = [this.a[i], this.a[s]]; i = s;
    }
  }
}
const topHeap = new MinHeap();
function offerRecord(record) {
  const key = record.submitted || '';
  if (topHeap.size() < RAW_CAP) { topHeap.push({ key, record }); return; }
  if (key > topHeap.peekKey()) { topHeap.popMin(); topHeap.push({ key, record }); }
}

// Archive files (~100-270MB each) are streamed line-by-line via readline
// instead of fs.readFileSync — reading a whole file (plus its split lines
// array, plus every parsed row object) into memory at once was blowing past
// an 8GB heap and crashing on the very first file once the archive grew to
// its current size.
async function processFile(fp) {
  console.log(`Reading ${path.basename(fp)}…`);
  const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let headers = null, idxJson = -1, n = 0, errs = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) { headers = parseCsvLine(line); idxJson = headers.indexOf('JSON_Response'); continue; }
    try {
      const vals = parseCsvLine(line);
      const jsonStr = vals[idxJson];
      if (!jsonStr) { errs++; continue; }
      const wrapper = JSON.parse(jsonStr);
      const rep = findReport(wrapper);
      if (!rep) { errs++; continue; }
      const f = extractFeatures(rep);
      if (!f.civilId) { errs++; continue; }
      const acq = acqMap[f.civilId];
      const matched = !!acq;
      const isApproved = acq?.Approvalflag === 'Y';
      const isBooked = matched && BOOKED.has(acq?.Altitudestatus);
      const isStp = matched && acq?.STP === 'Y';
      const topComp = Object.entries(f.competitors).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name, cnt]) => ({ name, cnt }));
      offerRecord({
        civilId: f.civilId ? f.civilId.slice(0, 4) + '****' + f.civilId.slice(-2) : 'N/A',
        name: f.name, score: f.score, scoreCard: f.scoreCard,
        scoreReasons: f.scoreReasons, scoreReasonTexts: f.scoreReasonTexts,
        enq90: f.enq90, enq30: f.enq30, enq180: f.enq180,
        totalEnquiries: f.totalEnquiries, enquiriesThisMonth: f.enquiriesThisMonth,
        activeLoans: f.activeLoans, activeCreditInstruments: f.activeCreditInstruments,
        bnpl: f.bnplCount, bnplBalance: f.bnplBalance,
        totalLimits: f.totalLimits, totalLiabilities: f.totalLiabilities, utilization: f.utilization,
        totalOutstanding: f.totalOutstanding, totalPastDue: f.totalPastDue, totalInstallments: f.totalInstallments,
        estDBR: f.estimatedDBR,
        defaults: f.defaultCount, defaultsSettled: f.defaultsSettled, defaultsActive: f.defaultsActive,
        totalDefaultAmt: f.totalDefaults, currentDelinquent: f.currentDelinquent,
        simahIncome: f.simahIncome, employerName: f.employerName, nationality: f.nationality,
        gender: f.gender, maritalStatus: f.maritalStatus, city: f.city,
        topCompetitors: topComp, eq: f.enquiryDetails || [],
        outcome: matched ? (acq.Altitudestatus || 'Matched') : 'No match',
        stp: isStp ? 'Y' : 'N', approved: isApproved ? 'Y' : 'N', booked: isBooked ? 'Y' : 'N',
        stagingId: acq?.StagingID || '',
        declineReason: acq?.SimplifiedDeclinedReason || '', deDecision: acq?.DE_Decision || '',
        lightDE: acq?.Light_DE_Decision || '',
        store: acq?.StoreNameOnline || acq?.StoreName || '', region: acq?.Region || '',
        product: acq?.Product_type || '', source: acq?.SubmitSource || '',
        submitted: acq?.submitted || '',
        riskRating: acq?.RiskRating || '', scRiskGrade: acq?.SC_RiskGrade || '',
        declaredIncome: parseFloat(acq?.Income) || 0, incomeBand: acq?.DeclaredIncomeBand || '',
        ageBand: acq?.AgeBand || '', revisedDBR: acq?.Revised_DBR || '',
        smhDBR: acq?.SIMAH_DBR || '', smhInstallments: acq?.SIMAH_Installments || '',
        smhScore: acq?.SIMAH_Score || '', smhBand: acq?.SIMAH_Band || '',
        gosiCalled: acq?.Is_GOSI_Called || '', mofCalled: acq?.Is_MOF_Called || '',
        employerType: acq?.FinalEmployerType || '',
        hasMortgage: f.hasMortgage ? 'Y' : 'N',
        altitudeIncome: parseFloat(acq?.AltitudeIncome) || 0,
        competitorLoans: f.competitorLoans || [],
        competitorDBR: f.competitorDBR
      });
      for (const [inst, cnt] of Object.entries(f.activeCreditors || {})) {
        if (!institutionLoanStats[inst]) institutionLoanStats[inst] = { loans: 0, customers: 0, plnSum: 0, plnN: 0 };
        institutionLoanStats[inst].loans += cnt;
        institutionLoanStats[inst].customers++;
      }
      for (const [inst, s] of Object.entries(f.activePLNStats || {})) {
        if (!institutionLoanStats[inst]) institutionLoanStats[inst] = { loans: 0, customers: 0, plnSum: 0, plnN: 0 };
        institutionLoanStats[inst].plnSum += s.sum;
        institutionLoanStats[inst].plnN += s.n;
      }
      n++;
    } catch (e) { errs++; }
  }
  console.log(`  ${n} extracted, ${errs} errors`);
}

async function main() {
  for (const fp of files) {
    await processFile(fp);
  }

  const freshRecords = topHeap.a.map(x => x.record);
  console.log(`Total fresh records kept (bounded top-${RAW_CAP.toLocaleString()}): ${freshRecords.length}`);
  console.log(`Institutions with active PLN data: ${Object.keys(institutionLoanStats).length}`);

  // Prioritize records with a real submitted date (most recent first); unmatched
  // (no submitted date) fill any remaining capacity at the end.
  const dated = freshRecords.filter(r => r.submitted).sort((a, b) => b.submitted.localeCompare(a.submitted));
  const undated = freshRecords.filter(r => !r.submitted);
  const finalRecords = [...dated, ...undated].slice(0, RAW_CAP);

  const dates = finalRecords.map(r => r.submitted).filter(Boolean).sort();
  const submittedMin = dates[0] || null;
  const submittedMax = dates[dates.length - 1] || null;
  console.log(`Final rawRecords: ${finalRecords.length} (capped at ${RAW_CAP})`);
  console.log(`submittedMin: ${submittedMin}, submittedMax: ${submittedMax}`);

  // --- Splice into SIMAH_Intelligence.html (rawRecords + meta.submittedMin/Max + institutionLoanStats) ---
  console.log('Reading SIMAH_Intelligence.html…');
  const html = fs.readFileSync(HTML_OUT, 'utf-8');
  const startTag = 'const SIMAH_DATA = ';
  const startIdx = html.indexOf(startTag) + startTag.length;
  const endTag = ';\nlet D = SIMAH_DATA;';
  const endIdx = html.indexOf(endTag, startIdx);
  if (startIdx < 0 || endIdx < 0) { console.error('Could not locate SIMAH_DATA blob'); process.exit(1); }
  const data = JSON.parse(html.slice(startIdx, endIdx));

  console.log(`Old rawRecords: ${data.rawRecords.length}, old institutionLoanStats keys: ${Object.keys(data.institutionLoanStats || {}).length}`);
  data.rawRecords = finalRecords;
  data.meta.submittedMin = submittedMin;
  data.meta.submittedMax = submittedMax;
  data.institutionLoanStats = institutionLoanStats;

  const newBlob = JSON.stringify(data);
  const newHtml = html.slice(0, startIdx) + newBlob + html.slice(endIdx);
  fs.writeFileSync(HTML_OUT, newHtml, 'utf-8');
  console.log('✅ Done — rawRecords, submittedMin/Max, and institutionLoanStats backfilled. All other aggregates untouched.');
}
main();
