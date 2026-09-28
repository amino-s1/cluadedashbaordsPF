#!/usr/bin/env node
/**
 * Interactive one-time (or re-run-anytime) setup: asks where this machine's
 * Downloads folder and each data source's archive folder live, plus which
 * files are the historical/seed Acquisition CSVs, and saves the answers to
 * pipeline.config.json. Every pipeline script (merge_csv.js, update_funnel.js,
 * update_simah_from_qarar_csv.js) reads from that file via
 * scripts/pipeline_config.js instead of hardcoding this machine's paths --
 * see REPLICATE_ON_NEW_MACHINE.md for the full story on why.
 *
 * Usage: node scripts/setup_config.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'pipeline.config.json');

let existing = {};
if (fs.existsSync(CONFIG_PATH)) {
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) { /* start fresh */ }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question, def) {
  return new Promise(resolve => {
    const suffix = def ? ` [${def}]` : '';
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || def || '');
    });
  });
}

function homeDownloads() {
  return path.join(os.homedir(), 'Downloads');
}

async function main() {
  console.log('=== Tasheel Dashboard Pipeline — machine setup ===');
  console.log('Answers are saved to pipeline.config.json (gitignored, machine-specific).');
  console.log('Press Enter to accept the bracketed default where one is shown.\n');

  const downloadsDir = await ask(
    'Where do new daily export files land? (Downloads folder)',
    existing.downloadsDir || homeDownloads()
  );

  console.log('\nEach data source archives its processed files to its own folder');
  console.log('(kept OUTSIDE this repo, since these are large raw data files):\n');

  const acquisitionArchiveDir = await ask(
    'Archive folder for processed Acquisition_for_Loans files',
    existing.acquisitionArchiveDir || path.join(path.dirname(ROOT), 'Acquisition for Loans')
  );
  const funnelArchiveDir = await ask(
    'Archive folder for processed Tawarruq_Funnel files',
    existing.funnelArchiveDir || path.join(path.dirname(ROOT), 'Tawarruq Funnel')
  );
  const simahArchiveDir = await ask(
    'Archive folder for processed SIMAH_Qarar_JSON files',
    existing.simahArchiveDir || path.join(path.dirname(ROOT), 'SIMAH Qarar JSON')
  );
  const smsArchiveDir = await ask(
    'Archive folder for processed SMS_Campaign files',
    existing.smsArchiveDir || path.join(path.dirname(ROOT), 'SMS Campaigns')
  );
  const smsSentListsDir = await ask(
    'Folder holding bulk "SMS sent" recipient-list xlsx files (CivilID/phone/send-date only, no application outcome)',
    existing.smsSentListsDir || path.join(path.dirname(ROOT), 'SMS Analyz')
  );
  const snbReferralArchiveDir = await ask(
    'Archive folder for processed SNB_Referral files',
    existing.snbReferralArchiveDir || path.join(path.dirname(ROOT), 'SNB Referral')
  );

  console.log('\nHistorical/seed data: merge_csv.js needs at least one starting');
  console.log('Acquisition_for_Loans CSV to merge new daily files into. List the');
  console.log('ones you have (comma-separated filenames or full paths), or leave');
  console.log('blank to auto-discover every Acquisition_for_Loans_*.csv already');
  console.log('sitting in the project root.\n');

  const histAnswer = await ask(
    'Historical/seed Acquisition CSV file(s)',
    (existing.acquisitionHistoricalFiles || []).join(', ')
  );
  const acquisitionHistoricalFiles = histAnswer
    ? histAnswer.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  rl.close();

  const config = {
    downloadsDir,
    acquisitionArchiveDir,
    funnelArchiveDir,
    simahArchiveDir,
    smsArchiveDir,
    smsSentListsDir,
    snbReferralArchiveDir,
    acquisitionHistoricalFiles,
  };

  // Create archive folders if they don't exist yet -- nothing downstream
  // should have to guess whether that's the setup script's job or not.
  [acquisitionArchiveDir, funnelArchiveDir, simahArchiveDir, smsArchiveDir, smsSentListsDir, snbReferralArchiveDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created: ${dir}`);
      } catch (e) {
        console.warn(`WARN: could not create ${dir} (${e.message}) -- create it manually before running the pipeline.`);
      }
    }
  });
  if (!fs.existsSync(downloadsDir)) {
    console.warn(`WARN: ${downloadsDir} doesn't exist -- double-check this is really where new files land.`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\n✅ Saved ${path.basename(CONFIG_PATH)}.`);
  console.log('\nConfig:');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nYou can re-run this script anytime to change any of these answers.');
}

main().catch(e => { console.error(e); process.exit(1); });
