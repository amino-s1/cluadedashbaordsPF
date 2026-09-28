/**
 * "CocoNut" tab data builder: matches Holistic_View.html's underlying
 * portfolio (OverView.xlsx — the loan SERVICING dataset; every row in it is
 * an already-booked/originated contract, unlike Acquisition_for_Loans
 * which mixes submitted/declined/booked) against SIMAH's competitor-loan
 * data, and lists every application that (a) is booked per the Holistic
 * View portfolio and (b) has an ACTIVE loan with another institution.
 *
 * Holistic_View.html itself only ships pre-aggregated dimensional totals
 * (no per-row StagingID/CivilID survives that build) — so this reads
 * OverView.xlsx directly, streaming it the same SAX way
 * build_holistic_view.js does, to get real per-application CivilID/
 * StagingID/product/status.
 *
 * Then streams the full SIMAH_Qarar_JSON archive (same approach as
 * scripts/compute_full_booked_competitor_stats.js) and, for every
 * customer found in the Holistic View portfolio, checks their active
 * competitor loans.
 *
 * Usage: node --max-old-space-size=8192 scripts/build_coconut_matches.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sax = require('sax');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const XLSX_PATH = path.join('C:', 'Users', 'Emad.Ayyash', 'OneDrive - tasheelfinance', 'Documents', 'EIA Work', 'AI-Work', 'OverView.xlsx');
const HTML = path.join(ROOT, 'SIMAH_Intelligence.html');
const ARCHIVE_DIR = path.join('C:', 'Users', 'Emad.Ayyash', 'OneDrive - tasheelfinance', 'Documents', 'EIA Work', 'AI-Work', 'SIMAH Qarar JSON');
const ACQ_CSV = path.join(ROOT, 'Acquisition_for_Loans_all_merged.csv');
// NOTE: OverView.xlsx's CIVIL_ID column is an anonymized hash (e.g. "ID_848224c2edf715f6"),
// NOT the raw civil ID SIMAH reports carry — confirmed by direct inspection, so it cannot be
// joined to SIMAH directly. The real bridge is StagingID: OverView.xlsx's StagingID column
// matches Acquisition_for_Loans_all_merged.csv's StagingID, and that same CSV's CivilID column
// carries the raw civil ID that also appears in SIMAH's JSON (providedDemographicsInfo.demIDNumber).
// So the join is: SIMAH.civilId -> Acquisition.CivilID -> Acquisition.StagingID -> OverView.StagingID.

function unzipEntry(entryName) {
  return spawn('unzip', ['-p', XLSX_PATH, entryName], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}
// Same column order as scripts/build_holistic_view.js (A..DF exactly as in the sheet).
const HEADERS = "StoreNameOnline,Retailer,Gender,Empolyer_Type,EmployerType,MaritalStatus,TypeOfResidence,DE_Decision,SMH_MonthlyInstalments,SMH_CurrentDBR,Company,LOS,SMH_Score,SC_Score,SC_RiskGrade,AppSource,SubmitSource,referreasons,Revised_DBR,StagingID,MasterID,PRODUCT,STORE,CIVIL_ID,FIN_AMOUNT,TENURE,PROFIT_RATE,PROFIT_AMOUNT,INS_FLAG,INSURANCE_AMOUNT,FIN_START_DATE,FIRST_INSTALLMENT_DATE,MATURITY_DATE,CURR_INSTALLMENT_DATE,LAST_PAYMENT_DATE,LAST_PAYMENT_AMOUNT,TOTAL_PAID,OVD_FLAG,OVD_STATUS,OVD_AMOUNT,LPF,TOTAL_DUE,OUTSTANDING_PRIN,OUTSTANDING_PROF,REALIZED_PROFIT,COLLECTED_PROFIT,FUTURE_3_MONTHS_PROFIT,OUTSTANDING_PROFIT_12MON,OUTSTANDING_PROFIT_OVER_12MON,TOTAL_OUTSTANDING,TOTAL_OUTSTANDING_12MON,TOTAL_OUTSTANDING_OVER_12MON,REMAINING_TENURE,OUTSTANDING_INSTALLMENTS,NEXT_INST_AMOUNT,NEXT_INST_DATE,STATUS,DPD,NON_STARTER_FLAG,NS,LPF_CHARGED,CHARGED_DATE,CURRENT_LPF_BAL,Early_Discount,TOTAL_PAYMENT,PROMO_PAYMENTS,WRITE_OFF_DATE,ACCOUNT_CLOSE_DATE,FUTURE_PAID_INST_FLAG,ACTION_CODE,SNAP_DATE,Product_type,Region,SMHBand,AppScoreBand,RiskRating,EmployerType2,Nationality_Flag,AgeBand,IncomeBand,IncomeBand2,FinalIncomeBand,FinBand,DBRBand,DBRBand2,OVD_STATUS_BAND,FinBand2,EmployerType3,LOSBand2,Alt_LOS,Alt_EmployerType,PilotRating,Reverse_Date,VAT,PROC_FEE,PRINC_TO_BE,DPD_450_Date,SmartFinance,PartnerBankID,SETTLED_TOPUP_PRIN,SETTLED_TOPUP_PROF,PREV_TOPUP_CONTRACT,PARTNER_BANK,OVD_PRINCIPAL,OVD_PROFIT,RevisedDBR2,CASH_AMOUNT,WALLET_AMOUNT,calculatedApr,Principal_Discount".split(',');
const NEEDED = new Set(['StagingID', 'CIVIL_ID', 'STATUS', 'Product_type', 'FIN_START_DATE', 'FIN_AMOUNT']);
function colIndexFromLetter(letter) { let idx = 0; for (let i = 0; i < letter.length; i++) idx = idx * 26 + (letter.charCodeAt(i) - 64); return idx - 1; }
const IDX_TO_HEADER = {};
HEADERS.forEach((h, i) => { if (NEEDED.has(h)) IDX_TO_HEADER[i] = h; });
function excelSerialToDate(serial) {
  if (serial == null || serial === '' || serial === 'NULL') return null;
  const n = parseFloat(serial); if (isNaN(n) || n <= 0) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000));
}
function ymd(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }

async function readOverviewPortfolio() {
  console.log('Reading', XLSX_PATH);
  console.log('Parsing sharedStrings.xml…');
  const strings = [];
  { let current = '', inT = false;
    const s = sax.createStream(true, {});
    s.on('opentag', n => { if (n.name === 'si') current = ''; if (n.name === 't') inT = true; });
    s.on('text', t => { if (inT) current += t; });
    s.on('closetag', name => { if (name === 't') inT = false; if (name === 'si') strings.push(current); });
    await new Promise((resolve, reject) => { const stream = unzipEntry('xl/sharedStrings.xml'); stream.pipe(s); s.on('end', resolve); s.on('error', reject); });
  }
  console.log('  sharedStrings:', strings.length.toLocaleString());

  console.log('Streaming sheet1.xml…');
  // stagingId -> { products:Set, statuses:Set, count, finAmount }
  // (OverView's CIVIL_ID is an anonymized hash — not usable as a join key; StagingID is the real one.)
  const portfolio = new Map();
  let currentRow = {}, currentCellRef = null, currentCellType = null, currentVal = '', inCell = false, rowNum = 0, totalRows = 0;
  function colLetterFromRef(ref) { let i = 0; while (i < ref.length && (ref.charCodeAt(i) < 48 || ref.charCodeAt(i) > 57)) i++; return ref.slice(0, i); }
  function finalizeRow() {
    totalRows++;
    if (totalRows % 50000 === 0) console.log('  ...', totalRows.toLocaleString(), 'rows');
    const sid = currentRow.StagingID;
    if (!sid || sid === 'NULL') return;
    let p = portfolio.get(sid);
    if (!p) { p = { products: new Set(), statuses: new Set(), count: 0, finAmount: 0 }; portfolio.set(sid, p); }
    if (currentRow.Product_type) p.products.add(currentRow.Product_type);
    if (currentRow.STATUS) p.statuses.add(currentRow.STATUS);
    const fa = Number(currentRow.FIN_AMOUNT);
    if (isFinite(fa) && fa > 0) p.finAmount = Math.max(p.finAmount, fa); // one row per StagingID in practice; max guards against dupes
    p.count++;
  }
  const parser = sax.createStream(true, {});
  parser.on('opentag', node => {
    if (node.name === 'row') { currentRow = {}; rowNum = parseInt(node.attributes.r, 10); }
    if (node.name === 'c') { currentCellRef = node.attributes.r; currentCellType = node.attributes.t || null; currentVal = ''; inCell = true; }
  });
  parser.on('text', t => { if (inCell) currentVal += t; });
  parser.on('closetag', name => {
    if (name === 'c') {
      const letter = colLetterFromRef(currentCellRef);
      const idx = colIndexFromLetter(letter);
      const headerName = IDX_TO_HEADER[idx];
      if (headerName) {
        let val = currentVal;
        if (currentCellType === 's') val = strings[parseInt(currentVal, 10)];
        currentRow[headerName] = val;
      }
      inCell = false;
    }
    if (name === 'row') { if (rowNum > 1) finalizeRow(); }
  });
  await new Promise((resolve, reject) => {
    const stream = unzipEntry('xl/worksheets/sheet1.xml');
    stream.pipe(parser);
    parser.on('end', resolve); parser.on('error', reject);
  });
  console.log(`Done. ${totalRows.toLocaleString()} portfolio rows, ${portfolio.size.toLocaleString()} unique StagingIDs`);
  return portfolio;
}

// Builds civilId -> Set(stagingId) restricted to StagingIDs present in the OverView portfolio.
function buildCivilToStagingMap(portfolioStagingIds) {
  console.log('Reading', ACQ_CSV, 'to bridge SIMAH civilId -> StagingID -> OverView portfolio…');
  const lines = fs.readFileSync(ACQ_CSV, 'utf-8').split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const idxStaging = headers.indexOf('StagingID'), idxCivil = headers.indexOf('CivilID');
  const map = new Map(); // civilId -> Set(stagingId)
  let matched = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = parseCsvLine(lines[i]);
    const sid = vals[idxStaging], civ = (vals[idxCivil] || '').trim();
    if (!sid || !civ || !portfolioStagingIds.has(sid)) continue;
    let s = map.get(civ);
    if (!s) { s = new Set(); map.set(civ, s); }
    s.add(sid);
    matched++;
  }
  console.log(`  ${map.size.toLocaleString()} unique civilIds bridged to ${matched.toLocaleString()} portfolio StagingID rows`);
  return map;
}

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

async function main() {
  console.log('=== CocoNut: Holistic View (booked portfolio) x SIMAH active competitor loans ===');
  const portfolio = await readOverviewPortfolio();
  const civilToStaging = buildCivilToStagingMap(new Set(portfolio.keys()));

  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => /\.csv$/i.test(f)).sort();
  console.log(`${files.length} archived SIMAH files to scan for matches`);

  const rows = []; // {civilId(masked), stagingId, product, tasheelAmount, institution, category, amount, installment, tenure, rate, issuedDate}
  let totalScanned = 0, matchedCustomers = 0;
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
        const stagingIds = civilToStaging.get(civilId);
        if (!stagingIds || !stagingIds.size) continue; // not in the booked Holistic View portfolio
        // Merge products/statuses/loan amount across every portfolio row for this customer's StagingID(s).
        const port = { stagingIds, products: new Set(), statuses: new Set(), tasheelAmount: 0 };
        stagingIds.forEach(sid => {
          const p = portfolio.get(sid);
          if (!p) return;
          p.products.forEach(x => port.products.add(x));
          p.statuses.forEach(x => port.statuses.add(x));
          port.tasheelAmount += p.finAmount || 0;
        });

        const cis = asArray(rep.creditInstrumentDetails);
        const perInst = {};
        cis.forEach(ci => {
          const cred = ci.ciCreditor?.memberNameEN || 'Unknown';
          const cat = competitorCategory(cred);
          if (!cat) return;
          if (ci.ciStatus?.creditInstrumentStatusCode !== 'A') return; // active only
          const amount = Number(ci.ciLimit) || 0;
          const installment = Number(ci.ciInstallmentAmount) || 0;
          const tenureMonths = Number(ci.ciTenure) || 0;
          // Flat-rate approximation: ((Installment x Tenure / Finance Amount) - 1) x (12 / Tenure), as a %.
          let annualRatePct = null;
          if (amount > 0 && tenureMonths > 0 && installment > 0) {
            const flatRate = ((installment * tenureMonths / amount) - 1) * (12 / tenureMonths);
            if (isFinite(flatRate)) annualRatePct = Math.round(flatRate * 100 * 10) / 10;
          }
          const issuedDate = ci.ciIssuedDate || '';
          const d = parseDMY(issuedDate);
          const existing = perInst[cred];
          if (!existing || (d && (!existing.date || d > existing.date))) {
            perInst[cred] = { category: cat, amount: Math.round(amount), installment: Math.round(installment) || null, tenure: tenureMonths || null, rate: annualRatePct, issuedDate, date: d };
          }
        });
        const instKeys = Object.keys(perInst);
        if (!instKeys.length) continue;
        matchedCustomers++;
        instKeys.forEach(inst => {
          const l = perInst[inst];
          rows.push({
            civilId: civilId.slice(0, 4) + '****' + civilId.slice(-2),
            stagingId: [...port.stagingIds][0] || '',
            product: [...port.products].join('/') || '',
            tasheelAmount: Math.round(port.tasheelAmount) || null,
            institution: inst, category: l.category, amount: l.amount, installment: l.installment, tenure: l.tenure, rate: l.rate, issuedDate: l.issuedDate
          });
        });
        n++;
      } catch (e) { /* skip malformed row */ }
    }
    console.log(`  ${n} portfolio matches found in this file`);
  }
  console.log(`Total: ${totalScanned.toLocaleString()} SIMAH records scanned, ${matchedCustomers.toLocaleString()} booked-portfolio customers have >=1 active competitor loan, ${rows.length.toLocaleString()} (customer, institution) rows`);

  const byInst = {};
  rows.forEach(r => { byInst[r.institution] = (byInst[r.institution] || 0) + 1; });
  console.log('By institution:');
  Object.entries(byInst).sort((a, b) => b[1] - a[1]).forEach(([inst, n]) => console.log(`  ${inst.padEnd(48)} ${n}`));

  const blob = `const COCONUT_DATA = ${JSON.stringify({ meta: { generatedAt: new Date().toISOString().slice(0, 10), overviewRows: portfolio.size, matchedCustomers, archiveFiles: files.length }, rows })};\n`;
  const startTag = 'const COCONUT_DATA = ';
  const html = fs.readFileSync(HTML, 'utf-8');
  const s2 = html.indexOf(startTag);
  let newHtml;
  if (s2 !== -1) {
    const endMatch = /\};\r?\n/.exec(html.slice(s2));
    const e2 = s2 + endMatch.index + 1;
    newHtml = html.slice(0, s2) + blob + html.slice(e2);
    console.log('(replaced existing COCONUT_DATA)');
  } else {
    const anchor = 'const SIMAH_ORIG';
    const ai = html.indexOf(anchor);
    if (ai === -1) { console.error('Could not find insertion anchor (const SIMAH_ORIG)'); process.exit(1); }
    newHtml = html.slice(0, ai) + blob + html.slice(ai);
    console.log('(inserted new COCONUT_DATA)');
  }
  fs.writeFileSync(HTML, newHtml, 'utf-8');
  console.log('✅ Done.');
}
main();
