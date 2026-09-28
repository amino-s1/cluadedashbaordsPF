const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

async function main() {
  const masterPath = path.join('C:', 'Users', 'Emad.Ayyash', 'Downloads', 'MASTER 30-08-2026 16-16.csv');
  const masterLines = fs.readFileSync(masterPath, 'utf-8').replace(/^﻿/, '').split(/\r?\n/);
  const mh = parseCsvLine(masterLines[0]);
  const iMStatus = mh.indexOf('AppStatusID'), iMCiv = mh.indexOf('CivilId'), iMStaging = mh.indexOf('StagingID'),
    iMSales = mh.indexOf('SalesCompletedDate'), iMName = mh.indexOf('FullName_Latin');
  const masterByCiv = new Map(); // civilId -> {stagingId, salesCompletedDate, name}
  for (let i = 1; i < masterLines.length; i++) {
    if (!masterLines[i]) continue;
    const v = parseCsvLine(masterLines[i]);
    if (v[iMStatus] === 'Completed [C]' && v[iMCiv]) {
      masterByCiv.set(v[iMCiv].trim(), { stagingId: v[iMStaging], salesCompletedDate: v[iMSales], name: v[iMName] });
    }
  }
  console.log('MASTER completed unique civilIds:', masterByCiv.size);

  // Build full Acquisition map: civilId -> {status, stagingId} (last row wins, but track ANY status seen)
  const rl = readline.createInterface({ input: fs.createReadStream('Acquisition_for_Loans_all_merged.csv', { encoding: 'utf-8' }), crlfDelay: Infinity });
  let headers = null, iAlt = -1, iCiv = -1, iStaging = -1;
  const acqCompletedSet = new Set();
  const acqAnyStatus = new Map(); // civilId -> Set of statuses seen
  const acqStagingSet = new Set(); // all stagingIds seen in Acquisition
  for await (const line of rl) {
    if (!headers) { headers = parseCsvLine(line); iAlt = headers.indexOf('Altitudestatus'); iCiv = headers.indexOf('CivilID'); iStaging = headers.indexOf('StagingID'); continue; }
    const v = parseCsvLine(line);
    const civ = v[iCiv] ? v[iCiv].trim() : '';
    const st = v[iAlt];
    if (st === 'Completed [C]' && civ) acqCompletedSet.add(civ);
    if (civ) {
      if (!acqAnyStatus.has(civ)) acqAnyStatus.set(civ, new Set());
      acqAnyStatus.get(civ).add(st || '(blank)');
    }
    if (v[iStaging]) acqStagingSet.add(v[iStaging].trim());
  }

  const missing = [];
  masterByCiv.forEach((info, civ) => { if (!acqCompletedSet.has(civ)) missing.push({ civ, ...info }); });
  console.log('Missing from Acquisition Completed[C]:', missing.length);

  // For each missing civilId, check: not in Acquisition at all? present under a different status? StagingID present?
  let notInAcqAtAll = 0, presentOtherStatus = 0, stagingFoundElsewhere = 0;
  const statusBreakdown = {};
  missing.forEach(m => {
    const statuses = acqAnyStatus.get(m.civ);
    if (!statuses) {
      notInAcqAtAll++;
    } else {
      presentOtherStatus++;
      statuses.forEach(s => { statusBreakdown[s] = (statusBreakdown[s] || 0) + 1; });
    }
    if (m.stagingId && acqStagingSet.has(m.stagingId.trim())) stagingFoundElsewhere++;
  });
  console.log('Of the missing 345:');
  console.log('  Not in Acquisition CSV at all (civilId never appears):', notInAcqAtAll);
  console.log('  Present in Acquisition under a DIFFERENT status:', presentOtherStatus);
  console.log('  StagingID found in Acquisition (any row):', stagingFoundElsewhere);
  console.log('  Status breakdown for those present-under-different-status:', statusBreakdown);

  console.log('\nSample of 15 missing records:');
  missing.slice(0, 15).forEach(m => {
    const statuses = acqAnyStatus.get(m.civ);
    console.log(`  civ=${m.civ} staging=${m.stagingId} sales=${m.salesCompletedDate} acqStatuses=${statuses ? [...statuses].join('|') : 'NOT FOUND'}`);
  });
}
main();
