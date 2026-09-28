// Streams OverView.xlsx (422K rows x 110 cols, ~1.64GB uncompressed sheet XML) via SAX
// to build a monthly-bucketed (by loan origination date, FIN_START_DATE) portfolio
// dataset for Holistic_View.html — enabling a genuine From/To filter, unlike the
// prior hand-written static snapshot.
//
// Usage: node --max-old-space-size=8192 scripts/build_holistic_view.js "../OverView.xlsx"

const fs = require('fs');
const path = require('path');
const sax = require('sax');
const { spawn } = require('child_process');

const XLSX_PATH = process.argv[2] || '../OverView.xlsx';
const HTML_PATH = path.join(__dirname, '..', 'Holistic_View.html');

function unzipEntry(entryName) {
  return spawn('unzip', ['-p', XLSX_PATH, entryName], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}

// ── column order exactly as they appear A..DF in the sheet ──────────────
const HEADERS = "StoreNameOnline,Retailer,Gender,Empolyer_Type,EmployerType,MaritalStatus,TypeOfResidence,DE_Decision,SMH_MonthlyInstalments,SMH_CurrentDBR,Company,LOS,SMH_Score,SC_Score,SC_RiskGrade,AppSource,SubmitSource,referreasons,Revised_DBR,StagingID,MasterID,PRODUCT,STORE,CIVIL_ID,FIN_AMOUNT,TENURE,PROFIT_RATE,PROFIT_AMOUNT,INS_FLAG,INSURANCE_AMOUNT,FIN_START_DATE,FIRST_INSTALLMENT_DATE,MATURITY_DATE,CURR_INSTALLMENT_DATE,LAST_PAYMENT_DATE,LAST_PAYMENT_AMOUNT,TOTAL_PAID,OVD_FLAG,OVD_STATUS,OVD_AMOUNT,LPF,TOTAL_DUE,OUTSTANDING_PRIN,OUTSTANDING_PROF,REALIZED_PROFIT,COLLECTED_PROFIT,FUTURE_3_MONTHS_PROFIT,OUTSTANDING_PROFIT_12MON,OUTSTANDING_PROFIT_OVER_12MON,TOTAL_OUTSTANDING,TOTAL_OUTSTANDING_12MON,TOTAL_OUTSTANDING_OVER_12MON,REMAINING_TENURE,OUTSTANDING_INSTALLMENTS,NEXT_INST_AMOUNT,NEXT_INST_DATE,STATUS,DPD,NON_STARTER_FLAG,NS,LPF_CHARGED,CHARGED_DATE,CURRENT_LPF_BAL,Early_Discount,TOTAL_PAYMENT,PROMO_PAYMENTS,WRITE_OFF_DATE,ACCOUNT_CLOSE_DATE,FUTURE_PAID_INST_FLAG,ACTION_CODE,SNAP_DATE,Product_type,Region,SMHBand,AppScoreBand,RiskRating,EmployerType2,Nationality_Flag,AgeBand,IncomeBand,IncomeBand2,FinalIncomeBand,FinBand,DBRBand,DBRBand2,OVD_STATUS_BAND,FinBand2,EmployerType3,LOSBand2,Alt_LOS,Alt_EmployerType,PilotRating,Reverse_Date,VAT,PROC_FEE,PRINC_TO_BE,DPD_450_Date,SmartFinance,PartnerBankID,SETTLED_TOPUP_PRIN,SETTLED_TOPUP_PROF,PREV_TOPUP_CONTRACT,PARTNER_BANK,OVD_PRINCIPAL,OVD_PROFIT,RevisedDBR2,CASH_AMOUNT,WALLET_AMOUNT,calculatedApr,Principal_Discount".split(',');

// Only these are needed for aggregation — keeps per-row object small.
const NEEDED = new Set([
  'StoreNameOnline','Gender','EmployerType','MaritalStatus','TypeOfResidence',
  'StagingID','PRODUCT','FIN_AMOUNT','TENURE','PROFIT_RATE','PROFIT_AMOUNT',
  'FIN_START_DATE','TOTAL_PAID','OVD_FLAG','OVD_AMOUNT','OUTSTANDING_PRIN',
  'OUTSTANDING_PROF','REALIZED_PROFIT','COLLECTED_PROFIT','TOTAL_OUTSTANDING',
  'DPD','WRITE_OFF_DATE','TOTAL_PAYMENT','Product_type','SMHBand','AppScoreBand',
  'RiskRating','Nationality_Flag','AgeBand','IncomeBand','DBRBand','AppSource',
  'SubmitSource','SmartFinance','PilotRating','calculatedApr','SNAP_DATE',
  'DPD_450_Date','OVD_PRINCIPAL','OVD_PROFIT','STATUS'
]);

function colIndexFromLetter(letter) {
  let idx = 0;
  for (let i = 0; i < letter.length; i++) idx = idx * 26 + (letter.charCodeAt(i) - 64);
  return idx - 1;
}
// Pre-resolve which numeric col-index corresponds to each needed header, once.
const IDX_TO_HEADER = {};
HEADERS.forEach((h, i) => { if (NEEDED.has(h)) IDX_TO_HEADER[i] = h; });

function excelSerialToDate(serial) {
  if (serial == null || serial === '' || serial === 'NULL') return null;
  const n = parseFloat(serial);
  if (isNaN(n) || n <= 0) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000); // Excel epoch -> Unix epoch
  return new Date(ms);
}
function ymd(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
function ym(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function num(v) { if (v == null || v === '' || v === 'NULL') return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function isNull(v) { return v == null || v === '' || v === 'NULL'; }
function notNull(v) { return !isNull(v); }

function storeParts(storeName) {
  if (!storeName || storeName === 'NULL') return { retailer: 'Unknown', city: 'Unknown' };
  const parts = storeName.split('-').map(s => s.trim()).filter(Boolean);
  return {
    retailer: parts[0] || storeName,
    city: parts.length >= 2 ? parts[1] : storeName
  };
}

function dpdBucket(dpd) {
  if (dpd <= 0) return 'current';
  if (dpd <= 29) return '1-29';
  if (dpd <= 59) return '30-59';
  if (dpd <= 89) return '60-89';
  if (dpd <= 179) return '90-179';
  if (dpd <= 359) return '180-359';
  return '360+';
}

const DIMS = ['product', 'risk', 'nationality', 'employer', 'age', 'gender', 'marital',
  'residence', 'city', 'channel', 'income', 'dbr', 'smhband', 'scoreband', 'partner_rating',
  'retailer', 'store'];

function emptyLeaf() {
  return { n: 0, fin: 0, outstanding: 0, paid: 0, realizedProfit: 0, collectedProfit: 0,
    ovdN: 0, ovdAmt: 0, woN: 0, tenSum: 0, tenN: 0, rateSum: 0, rateN: 0,
    dpd: { current: 0, '1-29': 0, '30-59': 0, '60-89': 0, '90-179': 0, '180-359': 0, '360+': 0 } };
}
function addLeaf(leaf, row) {
  leaf.n++;
  leaf.fin += row.fin;
  leaf.outstanding += row.outstanding;
  leaf.paid += row.paid;
  leaf.realizedProfit += row.realizedProfit;
  leaf.collectedProfit += row.collectedProfit;
  if (row.ovd) { leaf.ovdN++; leaf.ovdAmt += row.ovdAmt; }
  if (row.wo) leaf.woN++;
  if (row.ten > 0) { leaf.tenSum += row.ten; leaf.tenN++; }
  if (row.rate > 0) { leaf.rateSum += row.rate; leaf.rateN++; }
  leaf.dpd[row.dpdB]++;
}

function newMonthBucket() {
  const b = { k: emptyLeaf(), dims: {} };
  DIMS.forEach(d => { b.dims[d] = {}; });
  return b;
}

async function main() {
  console.error('Reading', XLSX_PATH);

  // ── 1. shared strings ──
  console.error('Parsing sharedStrings.xml ...');
  const strings = [];
  { let current = '', inT = false;
    const s = sax.createStream(true, {});
    s.on('opentag', (node) => { if (node.name === 'si') current = ''; if (node.name === 't') inT = true; });
    s.on('text', (t) => { if (inT) current += t; });
    s.on('closetag', (name) => { if (name === 't') inT = false; if (name === 'si') strings.push(current); });
    await new Promise((resolve, reject) => {
      const stream = unzipEntry('xl/sharedStrings.xml');
      stream.pipe(s);
      s.on('end', resolve); s.on('error', reject);
    });
  }
  console.error('  sharedStrings:', strings.length);

  // ── 2. stream sheet1.xml, aggregate row by row ──
  console.error('Streaming sheet1.xml ...');
  const monthly = {}; // 'YYYY-MM' -> bucket
  const allTime = newMonthBucket();
  let totalRows = 0, skippedNoDate = 0;
  let minMon = null, maxMon = null;
  let snapDateExcel = null;

  let currentRow = {}, currentCellRef = null, currentCellType = null, currentVal = '', inCell = false, rowNum = 0, stopped = false;
  const MAX_ROWS = process.env.MAX_ROWS ? parseInt(process.env.MAX_ROWS, 10) : 0;

  function colLetterFromRef(ref) {
    let i = 0;
    while (i < ref.length && (ref.charCodeAt(i) < 48 || ref.charCodeAt(i) > 57)) i++;
    return ref.slice(0, i);
  }

  function finalizeRow() {
    totalRows++;
    if (totalRows % 50000 === 0) console.error('  ...', totalRows, 'rows');

    const finStartD = excelSerialToDate(currentRow.FIN_START_DATE);
    if (!finStartD) { skippedNoDate++; return; }
    const mon = ym(finStartD);
    if (!minMon || mon < minMon) minMon = mon;
    if (!maxMon || mon > maxMon) maxMon = mon;

    if (snapDateExcel == null && currentRow.SNAP_DATE) snapDateExcel = currentRow.SNAP_DATE;

    // Total Outstanding calculation (per spec):
    //   1. Exclude STATUS "109"
    //   2. DPD_450_Date must be NULL
    //   3. Only count rows where TOTAL_OUTSTANDING >= 10 SAR
    //   4. Sum OUTSTANDING_PRIN (not TOTAL_OUTSTANDING) for qualifying rows
    // Every other metric (fin, paid, profit, etc.) is unaffected — this
    // filter/value-swap applies to `outstanding` only.
    const outstandingQualifies =
      currentRow.STATUS !== '109' &&
      isNull(currentRow.DPD_450_Date) &&
      num(currentRow.TOTAL_OUTSTANDING) >= 10;

    const row = {
      fin: num(currentRow.FIN_AMOUNT),
      outstanding: outstandingQualifies ? num(currentRow.OUTSTANDING_PRIN) : 0,
      paid: num(currentRow.TOTAL_PAID),
      realizedProfit: num(currentRow.REALIZED_PROFIT),
      collectedProfit: num(currentRow.COLLECTED_PROFIT),
      ovd: currentRow.OVD_FLAG === 'Y',
      ovdAmt: num(currentRow.OVD_AMOUNT),
      wo: !!(currentRow.WRITE_OFF_DATE && currentRow.WRITE_OFF_DATE !== 'NULL'),
      dpdB: dpdBucket(num(currentRow.DPD)),
      ten: num(currentRow.TENURE),
      rate: num(currentRow.PROFIT_RATE)
    };

    if (!monthly[mon]) monthly[mon] = newMonthBucket();
    const bucket = monthly[mon];
    addLeaf(bucket.k, row);
    addLeaf(allTime.k, row);

    const sp = storeParts(currentRow.StoreNameOnline);
    const catVals = {
      product: currentRow.Product_type || 'Unknown',
      risk: currentRow.RiskRating || 'Unknown',
      nationality: currentRow.Nationality_Flag || 'Unknown',
      employer: currentRow.EmployerType || 'Unknown',
      age: currentRow.AgeBand || 'Unknown',
      gender: currentRow.Gender || 'Unknown',
      marital: currentRow.MaritalStatus || 'Unknown',
      residence: currentRow.TypeOfResidence || 'Unknown',
      city: sp.city,
      channel: currentRow.AppSource || currentRow.SubmitSource || 'Unknown',
      income: currentRow.IncomeBand || 'Unknown',
      dbr: currentRow.DBRBand || 'Unknown',
      smhband: currentRow.SMHBand || 'Unknown',
      scoreband: currentRow.AppScoreBand || 'Unknown',
      partner_rating: currentRow.PilotRating || 'Unknown',
      retailer: sp.retailer,
      store: currentRow.StoreNameOnline || 'Unknown'
    };
    DIMS.forEach(dim => {
      const cat = catVals[dim];
      if (!bucket.dims[dim][cat]) bucket.dims[dim][cat] = emptyLeaf();
      addLeaf(bucket.dims[dim][cat], row);
      if (!allTime.dims[dim][cat]) allTime.dims[dim][cat] = emptyLeaf();
      addLeaf(allTime.dims[dim][cat], row);
    });
  }

  const parser = sax.createStream(true, {});
  parser.on('opentag', (node) => {
    if (node.name === 'row') { currentRow = {}; rowNum = parseInt(node.attributes.r, 10); }
    if (node.name === 'c') { currentCellRef = node.attributes.r; currentCellType = node.attributes.t || null; currentVal = ''; inCell = true; }
  });
  parser.on('text', (t) => { if (inCell) currentVal += t; });
  parser.on('closetag', (name) => {
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
    if (name === 'row') {
      if (rowNum > 1) finalizeRow();
      if (MAX_ROWS && totalRows >= MAX_ROWS) stopped = true;
    }
  });

  await new Promise((resolve, reject) => {
    const stream = unzipEntry('xl/worksheets/sheet1.xml');
    stream.pipe(parser);
    parser.on('end', resolve);
    parser.on('error', reject);
    if (MAX_ROWS) {
      const check = setInterval(() => { if (stopped) { clearInterval(check); stream.destroy(); resolve(); } }, 50);
    }
  });

  console.error('Done streaming. totalRows=%d skippedNoDate=%d monMin=%s monMax=%s', totalRows, skippedNoDate, minMon, maxMon);

  const snapDate = snapDateExcel ? ymd(excelSerialToDate(snapDateExcel)) : null;

  const monthsSorted = Object.keys(monthly).sort();
  const HV = {
    meta: {
      totalRows: totalRows - skippedNoDate,
      skippedNoDate,
      snapDate,
      minMon, maxMon,
      generatedFrom: path.basename(XLSX_PATH),
      generatedAt: new Date().toISOString().slice(0, 10)
    },
    dims: DIMS,
    allTime,
    monthly: monthsSorted.map(mon => ({ mon, ...monthly[mon] }))
  };

  const outPath = path.join(__dirname, '..', 'holistic_view_data.json');
  fs.writeFileSync(outPath, JSON.stringify(HV));
  console.error('Wrote', outPath, '(', (fs.statSync(outPath).size / 1e6).toFixed(1), 'MB )');
}

main().catch(e => { console.error(e); process.exit(1); });
