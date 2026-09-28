/**
 * Shared config for every daily-pipeline script (merge_csv.js,
 * update_funnel.js, update_simah_from_qarar_csv.js, build_simah_datechunks.js).
 *
 * These scripts used to hardcode this machine's absolute paths directly
 * (C:\Users\Emad.Ayyash\...) -- which meant replicating the pipeline on a
 * different machine/user required manually finding and editing every one
 * of those hardcoded strings across several files. Instead, every path is
 * now read from `pipeline.config.json` in the project root (gitignored --
 * it's machine-specific, never shared/committed).
 *
 * Run `node scripts/setup_config.js` once per machine to create/update it
 * interactively. If the file doesn't exist yet, that's exactly what this
 * module tells you to do (rather than silently falling back to some other
 * machine's paths, which is the whole bug this replaces).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'pipeline.config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('');
    console.error('ERROR: pipeline.config.json not found.');
    console.error('This machine has not been configured yet -- run:');
    console.error('');
    console.error('  node scripts/setup_config.js');
    console.error('');
    console.error('It will ask where your Downloads folder and each data');
    console.error('source\'s archive folder live on this machine, then save');
    console.error('the answers to pipeline.config.json for every pipeline');
    console.error('script to read from.');
    console.error('');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error(`ERROR: pipeline.config.json exists but isn't valid JSON (${e.message}).`);
    console.error('Re-run: node scripts/setup_config.js');
    process.exit(1);
  }
  const required = ['downloadsDir', 'acquisitionArchiveDir', 'funnelArchiveDir', 'simahArchiveDir'];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    console.error(`ERROR: pipeline.config.json is missing: ${missing.join(', ')}`);
    console.error('Re-run: node scripts/setup_config.js');
    process.exit(1);
  }
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH, ROOT };
