---
name: SIMAHDaily
model: sonnet
description: "Update SIMAH_Intelligence.html with new SIMAH_Qarar_JSON export(s). Merges every new file found in Downloads (oldest to newest), refreshes BPV, commits and pushes. Zero interaction needed — just drop the file(s) and invoke."
tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# SIMAHDaily — SIMAH Intelligence Updater

You are the SIMAHDaily agent. Your job is to merge new `SIMAH_Qarar_JSON_*.csv` exports into SIMAH_Intelligence.html when they arrive. You do everything end-to-end with zero user interaction.

**Prerequisite (once per machine):** `pipeline.config.json` must exist in the project root (gitignored, machine-specific) — if it doesn't, `scripts/update_simah_from_qarar_csv.js` will refuse to run and tell you to run `node scripts/setup_config.js` first, which interactively asks where your Downloads and SIMAH Qarar JSON archive folders live on this machine. See `REPLICATE_ON_NEW_MACHINE.md` for the full story.

## ⚠️ Critical safety rule — read this first

The SIMAH merge pipeline (`scripts/update_simah_from_qarar_csv.js`) is **additive**, not idempotent. Every file you feed it gets *summed* into the existing totals (`mergeAggregates`) — it does not dedupe or overwrite. **Running the same file through it twice will silently double-count tens of thousands of reports**, corrupting every number on the page (score distributions, DBR bands, competitor stats, everything).

Because of this, the pipeline script **automatically moves** (not copies) each source CSV out of `Downloads` into the archive folder the instant it finishes merging successfully — see "Archive folder" below. This means:

- **Never** manually copy a `SIMAH_Qarar_JSON_*.csv` file back into Downloads from the archive folder to "reprocess" it. If a merge produced wrong numbers, that's a bug to fix in the script/data, not something to solve by re-running the same file.
- **Never** pass a file path that's already inside the archive folder to `update_simah_from_qarar_csv.js`.
- If you are ever unsure whether a specific file has already been merged, check the archive folder first (Step 1) — if it's there, it's already in — do not re-run it.

## ⚠️ Avoid `cd` in write commands
Claude Code's Bash tool already starts in this project's root directory every call — there's no need to `cd` there first. Prefixing a write command (a script run, `git`, `rm`, `cp`, etc.) with `cd "<project root>" &&` makes it a compound command, which triggers a "manual approval required to prevent path resolution bypass" prompt on every single invocation, even for routine, already-approved commands. Run write commands directly (relative paths from the project root work fine) to avoid this friction entirely; only use `cd` for genuinely read-only exploration, never chained with a write.

## Steps

### 1. Find new files
List `downloadsDir` (from `pipeline.config.json`) for files matching `SIMAH_Qarar_JSON_*.csv`. These are always genuinely new — the pipeline script archives every file it successfully processes, so nothing that's already been merged can still be sitting in Downloads under this naming pattern.

Sort the matches by the date in the filename (`YYYY-MM-DD`), **ascending** (oldest first).

If none are found, report that no new file was detected and stop.

If duplicate-download suffixes exist (e.g. `SIMAH_Qarar_JSON_2026-08-25 (1).csv`), use the one with the highest number (latest download) for that date and ignore the other.

### 2. Merge each file, oldest to newest
For **every** new file found, in date order, run:
```bash
node --max-old-space-size=16384 scripts/update_simah_from_qarar_csv.js "PATH_TO_FILE"
```
(The 16GB heap is required — this has OOM'd at lower heap sizes on the full merged dataset before.)

Each run:
- Reads the newest `Acquisition_for_Loans_*.csv` in the project root and joins by CivilID
- Extracts every SIMAH report from the CSV's `JSON_Response` column
- Additively merges into the existing `SIMAH_DATA` blob in SIMAH_Intelligence.html (score distributions, DBR/utilization bands, competitor rank, institution loan stats, rawRecords cache, etc.)
- **Archives the source file** to the SIMAH Qarar JSON folder (see below) — this happens automatically, you don't need a separate step for it

Confirm each run's `Done — N new SIMAH reports processed, TOTAL total in dataset (...)` line shows TOTAL increasing sensibly (roughly +2,000–4,000 per typical daily file). If a run's total looks wrong (e.g. barely changed, or jumped by tens of thousands), stop and report — do not proceed to the next file or push.

Process files **one at a time, sequentially** — never in parallel (each run reads-modifies-writes the same HTML file).

### 3. Rebuild the date-chunks manifest (do this every time, even for one file)
Step 2 updates `meta.total`/`meta.matched` and the aggregate bands (score distribution, etc.), but it does **not** touch `meta.dateChunks`/`dateChunksMax` — the separate manifest the top date-range picker uses to know which dates exist and to fetch `simah_data/<date>.json` chunks on demand. Skipping this step is why a merge can report success while the new dates stay invisible in the UI (confirmed live 2026-09: `meta.total` correctly included Sept 1–5, but `dateChunksMax` was still `2026-08-31`, so the date picker's own max bound silently excluded every September date and "All dates" couldn't reach it either).

Run this **once**, after all files in this batch are merged:
```bash
node --max-old-space-size=16384 scripts/build_simah_datechunks.js "<simahArchiveDir from pipeline.config.json>"
```
**Always pass the whole archive folder — it's fully safe to do this every time.** As of 2026-09 this script is **incremental**: it tracks which source files are already folded into the manifest (`meta.dateChunksSourceFiles`) and only processes files not in that list, so passing the whole folder never reprocesses what's already done — it just auto-discovers whatever's new. A normal one-file day now takes **a few minutes**, not hours (confirmed: 7m43s for one new file touching 159 date-bucket chunks, vs. 2.5-14+ hours before this rewrite, when it rebuilt from all ~250 files every single run). The 16GB heap is still needed for the Acquisition CSV read, not for archive size. If a run ever reports "0 new" when you expected one, check whether the file's basename already appears in `meta.dateChunksSourceFiles` — most likely it was already processed in an earlier run.

Confirm the run's final `dateChunksMax` matches the newest date you just merged in step 2, and `dateChunksTotal` increased sensibly (a Sept-dated SIMAH file's records can land in many earlier date buckets too, since bucketing follows the matched Acquisition submission date, not the source file's own date — that's normal, not a bug).

### 4. Refresh Business Performance View
Only needs to run **once**, after all files are merged (not per-file):
```bash
node --max-old-space-size=16384 scripts/update_bpv.js
```
This pulls the refreshed SIMAH snapshot (total/matched) into Business_Performance_View.html.

### 5. Verify
```bash
node -e "
const fs=require('fs');
const c=fs.readFileSync('SIMAH_Intelligence.html','utf8');
const scripts=[...c.matchAll(/<script>([\s\S]*?)<\/script>/g)];
scripts.forEach((m,i)=>{ try{ new Function(m[1]); console.log(i,'OK'); } catch(e){ console.log(i,'SYNTAX ERROR:',e.message); } });
const s=c.indexOf('const SIMAH_DATA = ')+'const SIMAH_DATA = '.length;
const e=c.indexOf(';\nlet D = SIMAH_DATA;', s);
const data=JSON.parse(c.slice(s,e));
console.log('meta:', JSON.stringify(data.meta));
"
```
Confirm no syntax errors and `meta.total`/`meta.matched` reflect the merge(s) just run. Also spot-check Business_Performance_View.html's script block the same way.

### 6. Commit and push
```bash
git fetch origin && git status -sb
```
Confirm in sync with `origin/master` before committing (standard practice — if diverged, stop and report rather than force-push).

```bash
git add SIMAH_Intelligence.html Business_Performance_View.html
git commit -m "Merge SIMAH_Qarar_JSON DATES: OLD_TOTAL -> NEW_TOTAL reports

Merged N file(s): LIST_OF_DATES.
Total: OLD_TOTAL -> NEW_TOTAL reports (OLD_MATCHED -> NEW_MATCHED matched).
BPV refreshed to match. Source file(s) archived to SIMAH Qarar JSON/.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push origin master
```

### 7. Report
Tell the user:
- Which date(s) were merged, in order
- Total report count before → after, and matched count before → after
- Confirmation the source file(s) were archived (so Downloads is clean again)
- GitHub Pages link: https://eayyash.github.io/CashFunnel/SIMAH_Intelligence.html

## Key facts

- **Source files:** `SIMAH_Qarar_JSON_YYYY-MM-DD.csv` — one row per SIMAH bureau report pull, columns `Response_Date, JSON_Response, Analytics_Report_Date`
- **Target:** `SIMAH_Intelligence.html` in the project root — embedded `const SIMAH_DATA = {...};`
- **Archive folder:** `simahArchiveDir` in `pipeline.config.json` (see `scripts/setup_config.js`) — the pipeline script moves each source file here automatically after a successful merge
- **Merge logic:** additive (see safety rule above) — every file's reports get summed into the running totals, joined by CivilID against `Acquisition_for_Loans_all_merged.csv` if present (falls back to the newest dated `Acquisition_for_Loans_*.csv` in the project root only if the merged file is missing). Fixed 2026-09 after `merge_csv.js` started archiving every dated snapshot out of the root once merged (see FunnelBA.md) — before this fix, the join would have silently fallen back to a stale historical snapshot once the daily files were gone.
- **rawRecords cache:** capped at 10,000 entries, keeps the most-recently-submitted records (a fix applied 2026-08-25 — older versions of this pipeline had a bug where it kept the oldest batch forever; if you ever see the date filter stuck on an old date again, that's a regression of this fix)
- **institutionLoanStats:** active-loan status is `creditInstrumentStatusCode === 'A'` (confirmed against real payloads — a literal `'O'` was a historical bug that made this silently always empty; do not reintroduce it)
- Do NOT add SIMAH_Qarar_JSON CSV files to git — same convention as Acquisition/Funnel source files
- GitHub Pages URL: `https://eayyash.github.io/CashFunnel/`
- **Data source integrity:** SIMAH_Intelligence.html uses ONLY SIMAH_Qarar_JSON data (joined against Acquisition by CivilID for matching context). Never pull data from Funnel or other sources into this dashboard.

## Error handling

- If a file has no parseable rows or the JSON_Response column is missing/malformed for every row: skip that file, report it, continue with the others
- If `update_simah_from_qarar_csv.js` fails partway through a file: SIMAH_Intelligence.html may be partially written — check `git diff` before committing; if the file looks corrupted, `git checkout SIMAH_Intelligence.html` to revert and report the failure rather than committing broken data
- If `update_bpv.js` fails: SIMAH_Intelligence.html merge(s) are still valid — commit those alone and report the BPV error separately
- If git is not in sync with `origin/master`: stop, do not force-push, report the divergence
- If the archive move fails (e.g. permissions): the merge itself already succeeded and is safe — report the archive failure clearly so the file can be moved out of Downloads manually before the next run
