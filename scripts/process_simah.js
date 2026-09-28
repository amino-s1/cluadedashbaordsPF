const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SIMAH_DIR = process.argv[2] || path.join(ROOT, '..', '..', 'SIMAH');
const HTML_OUT = path.join(ROOT, 'SIMAH_Intelligence.html');

// --- Find latest Acquisition CSV ---
function findLatestAcqFile() {
  // Prefer the merged dataset over any single dated snapshot -- see the
  // matching comment in update_simah_from_qarar_csv.js for why.
  if (fs.existsSync(path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv'))) return 'Acquisition_for_Loans_all_merged.csv';
  return fs.readdirSync(ROOT)
    .filter(f => /^Acquisition_for_Loans_\d{4}-\d{2}-\d{2}\.csv$/i.test(f))
    .sort().pop();
}

// --- CSV parser ---
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

// --- Parse Python-style dict JSON ---
function parsePythonDict(text) {
  const ctx = vm.createContext({ None: null, True: true, False: false });
  return vm.runInContext('(' + text + ')', ctx);
}

// --- Extract features from a single SIMAH report ---
function extractFeatures(rep) {
  const f = {};
  const demId = rep.providedDemographicsInfo?.demIDNumber ||
                rep.availableDemographicsInfo?.demIDNumber || null;
  f.civilId = demId;

  // Demographics
  const avail = rep.availableDemographicsInfo || {};
  f.gender = rep.providedDemographicsInfo?.demGender || avail.demGender || 'Unknown';
  f.nationality = avail.demNationality?.couNameEN ||
                  rep.providedDemographicsInfo?.demNationality?.couNameEN || 'Unknown';
  f.city = avail.demCustomerCity || '';
  f.simahIncome = parseFloat(avail.demTotalMonthlyIncome) || 0;
  f.maritalStatus = avail.demMaritalStatus?.statusNameEN || 'Unknown';

  // Score
  const sc = rep.score && rep.score[0];
  f.score = sc ? sc.score : null;
  f.scoreCard = sc?.scoreCard?.scoreCardDescEn || '';
  f.scoreReasons = (sc?.reasonCodes || []).map(r => r.scoreReasonCodeName);
  f.scoreReasonTexts = (sc?.reasonCodes || []).map(r => r.scoreReasonCodeDescEn);

  // Summary info
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

  // Previous enquiries analysis
  const reportDate = parseDate(rep.reportDate);
  const enqs = rep.prevEnquiries || [];
  let enq30 = 0, enq60 = 0, enq90 = 0, enq180 = 0;
  const competitors = {};
  const enqProducts = {};
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
  });
  f.enq30 = enq30;
  f.enq60 = enq60;
  f.enq90 = enq90;
  f.enq180 = enq180;
  f.competitors = competitors;
  f.enqProducts = enqProducts;

  // Credit instruments analysis
  const cis = rep.creditInstrumentDetails || [];
  let bnplCount = 0, bnplBal = 0, totalInstallments = 0, activeLoans = 0;
  let totalOutstanding = 0, totalPastDue = 0;
  const productTypes = {};
  const creditors = {};
  cis.forEach(ci => {
    const isActive = ci.ciStatus?.creditInstrumentStatusCode === 'O';
    const prod = ci.ciProductTypeDesc?.textEn || 'Unknown';
    if (isActive) {
      activeLoans++;
      productTypes[prod] = (productTypes[prod] || 0) + 1;
      const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
      creditors[cred] = (creditors[cred] || 0) + 1;
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

  // Estimated DBR (if income known)
  f.estimatedDBR = f.simahIncome > 0
    ? Math.round((f.totalInstallments / f.simahIncome) * 100) : null;

  // Defaults analysis
  const pDefs = rep.personalDefaults || [];
  f.defaultCount = pDefs.length;
  f.defaultsSettled = pDefs.filter(d =>
    d.pDefaultStatuses?.defaultStatusCode === 'FS').length;
  f.defaultsActive = pDefs.filter(d =>
    d.pDefaultStatuses?.defaultStatusCode !== 'FS').length;

  // Employer
  const emps = rep.employers || [];
  const currentEmp = emps.find(e =>
    e.empStatusType?.employerStatusTypeCode?.trim() === 'C');
  f.employerName = currentEmp?.empEmployerNameDescEn || '';
  f.employerIncome = currentEmp?.empIncome || 0;

  return f;
}

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

// --- Score band ---
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

// --- Aggregate all data ---
function buildAggregates(features, acqMap) {
  const agg = {
    meta: { total: features.length, matched: 0, unmatched: 0, reportDate: new Date().toISOString().slice(0, 10) },
    scoreDistribution: {},         // scoreBand → {sub, approved, booked, stp}
    enqIntensity: {},              // enqBand(90) → {sub, approved, booked, stp}
    competitorRank: {},            // competitor → count
    competitorByOutcome: {},       // competitor → {sub, approved, booked}
    productEnquiries: {},          // product → count
    utilizationBands: {},          // band → {sub, approved, booked, stp}
    dbrBands: {},                  // band → {sub, approved, booked, stp}
    bnplImpact: {},                // 0/1/2/3+ → {sub, approved, booked, stp}
    defaultImpact: {},             // 0/settled/active → {sub, approved, booked, stp}
    scoreReasonFreq: {},           // reasonCode → count
    incomeMatch: { match: 0, mismatch: 0, noData: 0 },
    declineByScore: {},            // scoreBand → {reason → count}
    rawRecords: []                 // for drill-down (capped)
  };

  const BOOKED = new Set(['Completed [C]', 'Pending Final Approval']);

  features.forEach(f => {
    const acq = acqMap[f.civilId];
    const matched = !!acq;
    if (matched) agg.meta.matched++;
    else agg.meta.unmatched++;

    const isApproved = acq?.Approvalflag === 'Y';
    const isBooked = acq ? BOOKED.has(acq.Altitudestatus) : false;
    const isStp = acq ? (acq.STP === '1' || acq.STP === 1) : false;

    // Score distribution
    const sb = scoreBand(f.score);
    const sd = agg.scoreDistribution[sb] || (agg.scoreDistribution[sb] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    sd.sub++;
    if (isApproved) sd.approved++;
    if (isBooked) sd.booked++;
    if (isStp) sd.stp++;

    // Enquiry intensity
    const eb = enqBand(f.enq90);
    const ei = agg.enqIntensity[eb] || (agg.enqIntensity[eb] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    ei.sub++;
    if (isApproved) ei.approved++;
    if (isBooked) ei.booked++;
    if (isStp) ei.stp++;

    // Competitors
    for (const [comp, cnt] of Object.entries(f.competitors)) {
      agg.competitorRank[comp] = (agg.competitorRank[comp] || 0) + cnt;
      const co = agg.competitorByOutcome[comp] || (agg.competitorByOutcome[comp] = { sub: 0, approved: 0, booked: 0 });
      co.sub++;
      if (isApproved) co.approved++;
      if (isBooked) co.booked++;
    }

    // Product enquiries
    for (const [prod, cnt] of Object.entries(f.enqProducts)) {
      agg.productEnquiries[prod] = (agg.productEnquiries[prod] || 0) + cnt;
    }

    // Utilization
    const ub = utilizBand(f.utilization);
    const ui = agg.utilizationBands[ub] || (agg.utilizationBands[ub] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    ui.sub++;
    if (isApproved) ui.approved++;
    if (isBooked) ui.booked++;
    if (isStp) ui.stp++;

    // Estimated DBR
    const db = dbrBand(f.estimatedDBR);
    const di = agg.dbrBands[db] || (agg.dbrBands[db] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    di.sub++;
    if (isApproved) di.approved++;
    if (isBooked) di.booked++;
    if (isStp) di.stp++;

    // BNPL impact
    const bk = f.bnplCount >= 3 ? '3+' : String(f.bnplCount);
    const bi = agg.bnplImpact[bk] || (agg.bnplImpact[bk] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    bi.sub++;
    if (isApproved) bi.approved++;
    if (isBooked) bi.booked++;
    if (isStp) bi.stp++;

    // Default impact
    const dk = f.defaultCount === 0 ? 'None' : (f.defaultsActive > 0 ? 'Active' : 'Settled');
    const dfi = agg.defaultImpact[dk] || (agg.defaultImpact[dk] = { sub: 0, approved: 0, booked: 0, stp: 0 });
    dfi.sub++;
    if (isApproved) dfi.approved++;
    if (isBooked) dfi.booked++;
    if (isStp) dfi.stp++;

    // Score reason frequency
    f.scoreReasons.forEach(r => {
      agg.scoreReasonFreq[r] = (agg.scoreReasonFreq[r] || 0) + 1;
    });

    // Income match
    if (acq && f.simahIncome > 0) {
      const declared = parseFloat(acq.Income) || 0;
      if (declared > 0) {
        const ratio = declared / f.simahIncome;
        if (ratio >= 0.8 && ratio <= 1.2) agg.incomeMatch.match++;
        else agg.incomeMatch.mismatch++;
      } else agg.incomeMatch.noData++;
    } else agg.incomeMatch.noData++;

    // Decline by score
    if (acq && !isApproved && acq.SimplifiedDeclinedReason) {
      const dbs = agg.declineByScore[sb] || (agg.declineByScore[sb] = {});
      const reason = acq.SimplifiedDeclinedReason;
      dbs[reason] = (dbs[reason] || 0) + 1;
    }

    // Raw record (capped at 5000)
    if (agg.rawRecords.length < 5000) {
      const topComp = Object.entries(f.competitors).sort((a,b)=>b[1]-a[1]).slice(0,7)
        .map(([name,cnt])=>({name,cnt}));
      agg.rawRecords.push({
        civilId: f.civilId ? f.civilId.slice(0, 4) + '****' + f.civilId.slice(-2) : 'N/A',
        score: f.score,
        scoreCard: f.scoreCard,
        scoreReasons: f.scoreReasons,
        scoreReasonTexts: f.scoreReasonTexts,
        enq90: f.enq90,
        enq30: f.enq30,
        enq180: f.enq180,
        totalEnquiries: f.totalEnquiries,
        enquiriesThisMonth: f.enquiriesThisMonth,
        activeLoans: f.activeLoans,
        activeCreditInstruments: f.activeCreditInstruments,
        bnpl: f.bnplCount,
        bnplBalance: f.bnplBalance,
        totalLimits: f.totalLimits,
        totalLiabilities: f.totalLiabilities,
        utilization: f.utilization,
        totalOutstanding: f.totalOutstanding,
        totalPastDue: f.totalPastDue,
        totalInstallments: f.totalInstallments,
        estDBR: f.estimatedDBR,
        defaults: f.defaultCount,
        defaultsSettled: f.defaultsSettled,
        defaultsActive: f.defaultsActive,
        totalDefaultAmt: f.totalDefaults,
        currentDelinquent: f.currentDelinquent,
        simahIncome: f.simahIncome,
        employerName: f.employerName,
        nationality: f.nationality,
        gender: f.gender,
        maritalStatus: f.maritalStatus,
        city: f.city,
        topCompetitors: topComp,
        outcome: acq?.Altitudestatus || 'No match',
        stp: isStp ? 'Y' : 'N',
        approved: isApproved ? 'Y' : 'N',
        booked: isBooked ? 'Y' : 'N',
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
        employerType: acq?.FinalEmployerType || ''
      });
    }
  });

  // Score reason descriptions map
  agg.scoreReasonDescs = {};
  features.forEach(f => {
    f.scoreReasons.forEach((code, i) => {
      if (!agg.scoreReasonDescs[code] && f.scoreReasonTexts[i])
        agg.scoreReasonDescs[code] = f.scoreReasonTexts[i];
    });
  });

  return agg;
}

// --- Main ---
console.log('=== SIMAH Intelligence Processor ===');
console.log(`SIMAH folder: ${SIMAH_DIR}`);

if (!fs.existsSync(SIMAH_DIR)) {
  console.error(`SIMAH directory not found: ${SIMAH_DIR}`);
  process.exit(1);
}

// Read SIMAH files
const simahFiles = fs.readdirSync(SIMAH_DIR).filter(f => f.endsWith('.json'));
console.log(`Found ${simahFiles.length} SIMAH JSON files`);

if (simahFiles.length === 0) {
  console.error('No JSON files found in SIMAH directory');
  process.exit(1);
}

const features = [];
let parseErrors = 0;
simahFiles.forEach(file => {
  try {
    const text = fs.readFileSync(path.join(SIMAH_DIR, file), 'utf-8');
    const rep = parsePythonDict(text);
    const f = extractFeatures(rep);
    if (f.civilId) features.push(f);
    else parseErrors++;
  } catch (e) {
    parseErrors++;
    if (parseErrors <= 3) console.warn(`  Warning: could not parse ${file}: ${e.message}`);
  }
});
console.log(`Extracted features from ${features.length} reports (${parseErrors} errors)`);

// Read acquisition CSV
const acqFile = findLatestAcqFile();
let acqMap = {};
if (acqFile) {
  console.log(`Reading ${acqFile}…`);
  const rows = readCsv(path.join(ROOT, acqFile));
  console.log(`  ${rows.length.toLocaleString()} acquisition rows`);
  rows.forEach(r => {
    if (r.CivilID) acqMap[r.CivilID] = r;
  });
  console.log(`  ${Object.keys(acqMap).length.toLocaleString()} unique CivilIDs`);
} else {
  console.warn('No Acquisition CSV found — running SIMAH-only analysis');
}

// Build aggregates
console.log('Aggregating…');
const agg = buildAggregates(features, acqMap);
agg.meta.simahFiles = simahFiles.length;
agg.meta.parseErrors = parseErrors;
agg.meta.acqFile = acqFile || 'none';

// Inject into HTML
console.log('Updating SIMAH_Intelligence.html…');
const htmlTemplate = fs.readFileSync(HTML_OUT, 'utf-8');
const dataLine = `const SIMAH_DATA = ${JSON.stringify(agg)};`;
const marker = 'const SIMAH_DATA = {';
const startIdx = htmlTemplate.indexOf(marker);
if (startIdx === -1) {
  console.error('ERROR: Could not find SIMAH_DATA marker in HTML template');
  process.exit(1);
}
const lineStart = htmlTemplate.lastIndexOf('\n', startIdx) + 1;
const lineEnd = htmlTemplate.indexOf('\n', startIdx);
const updated = htmlTemplate.slice(0, lineStart) + dataLine + htmlTemplate.slice(lineEnd);
fs.writeFileSync(HTML_OUT, updated, 'utf-8');

console.log(`Done — ${features.length} SIMAH reports processed, ${agg.meta.matched} matched to acquisitions.`);
