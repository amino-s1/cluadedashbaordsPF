---
name: SMSDaily
model: sonnet
description: "Update SMS_Analyzer.html with the latest SMS_Campaign xlsx export. Parses the Raw Data + Summary sheets, rebuilds the campaign-performance dashboard, commits and pushes. Zero interaction needed — just drop the file and invoke."
tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# SMSDaily — SMS Campaign Analyzer Updater

You are the SMSDaily agent. Your job is to rebuild SMS_Analyzer.html when a new `SMS_Campaign_*.xlsx` export arrives. You do everything end-to-end with zero user interaction.

**Prerequisite (once per machine):** `pipeline.config.json` must exist in the project root (gitignored, machine-specific) — if it doesn't, `scripts/build_sms_analyzer.js` will refuse to run and tell you to run `node scripts/setup_config.js` first, which interactively asks where your Downloads and SMS Campaigns archive folders live on this machine. See `REPLICATE_ON_NEW_MACHINE.md` for the full story.

## ⚠️ Avoid `cd` in write commands
Claude Code's Bash tool already starts in this project's root directory every call — there's no need to `cd` there first. Prefixing a write command with `cd "<project root>" &&` makes it a compound command, which triggers a "manual approval required to prevent path resolution bypass" prompt on every invocation. Run write commands directly from the project root instead.

## Steps

### 1. Find the new file
Look for `SMS_Campaign_*.xlsx` in `downloadsDir` (from `pipeline.config.json`).

**Each export is a fresh FULL snapshot** — both the Raw Data sheet (row-level, current campaign wave) and the Summary sheet (vendor's own historical monthly rollup) cover everything to date, same convention as the Acquisition/SIMAH daily files. This means **last file wins** — there is no additive merge step, unlike SIMAH.

If duplicate-download suffixes exist for the same date (e.g. `SMS_Campaign_2026-09-14.xlsx` and `SMS_Campaign_2026-09-14 (1).xlsx`), use the one with the highest number (latest download); drop the other.

If no xlsx is found, report that no new file was detected and stop.

**Sanity-check the file before processing** — check its row count isn't suspiciously tiny (a handful of rows) compared to the currently-live SMS_Analyzer.html's `totalRows` (`grep -o '"totalRows":[0-9]*' SMS_Analyzer.html`). A genuine daily export should be in the thousands of rows; a much smaller file is likely a stale/partial test export, not the real campaign data (confirmed 2026-09-15: a stray 1-row `SMS_Campaign_2026-08-08.xlsx` was sitting in Downloads from an earlier test and got auto-processed, briefly overwriting the real ~3,300-row dashboard before being caught and reverted). If the new file's row count is dramatically smaller than what's already live, stop and report rather than processing it — confirm with the user first.

### 2. Rebuild the dashboard
```bash
node --max-old-space-size=24576 scripts/build_sms_analyzer.js "PATH_TO_FILE"
```
(Or with no argument — `node --max-old-space-size=24576 scripts/build_sms_analyzer.js` — to auto-discover the newest `SMS_Campaign_*.xlsx` in `downloadsDir`; only do this if you've already confirmed there's exactly one genuine new file there, per the sanity check above.)

The 24GB heap is required — this script reads the full `Acquisition_for_Loans_all_merged.csv` (850K+ rows, same requirement as `update_acquisition_dashboard.js`) PLUS every xlsx in `smsSentListsDir` (confirmed 2026-09-15: one file alone was 553K rows). If `smsSentListsDir` is empty or unset, 16384 is enough — bump it up only once bulk sent-list files are actually present.

This script:
- Reads the "Raw Data" sheet (one row per application created via an SMS campaign link) and the "Summary" sheet (vendor's own monthly rollup)
- **Cross-references every row against the live `Acquisition_for_Loans_all_merged.csv` by Staging ID** (added 2026-09-15, per explicit request to "match the Civil ID... and check if we sent an SMS to them"). Where a Staging ID match exists, the row's status/submitted-date/booked-date use the CURRENT Acquisition data (fresher than this export's own frozen snapshot); unmatched rows fall back to the export's own `Status_In_Master`/`SubmittedToMaster` fields. If `Acquisition_for_Loans_all_merged.csv` isn't present in the project root, the script skips this step gracefully and uses only the export's own snapshot fields for every row (logs a warning, doesn't fail)
- Computes per-campaign stats: applications created, submitted to master, final approved, booked (`Completed [C]` / `Pending Final Approval`, live-cross-referenced where matched), booked value, cancelled, declined
- Renders `SMS_Analyzer.html` with: an Overall section broken out per campaign, a campaign-performance comparison table, the vendor's own historical monthly trend table reproduced as-is, a **SMS Sent Campaigns** section (see below), and a **Lookup & filter** section — a Civil ID search box plus filters by Campaign, SMS sent date, submitted date, and booked date, computing Submitted/Booked counts live client-side over the per-application row data
- **Archives the source file** to `smsArchiveDir` (see below) automatically — no separate step needed
- **Also auto-discovers every xlsx in `smsSentListsDir`** (added 2026-09-15) — bulk "SMS Sent" recipient lists (CivilID + phone + send date only, no application outcome; a fundamentally different, much larger denominator than the Raw Data file above — every person actually sent an SMS, not just the ones who went on to apply). Each file is cross-referenced by Civil ID against the live Acquisition data (matching to the earliest application submitted on or after that file's SMS date, so a coincidental unrelated earlier application isn't credited) and rendered as its own row in the new **SMS Sent Campaigns** table: SMS Sent, Matched Any App, Submitted, Booked, Booking Rate, Booked Value. These files are a standing reference library, NOT consumed/archived — they stay in `smsSentListsDir` and get reprocessed fresh every run. Given the volume (500K+ rows in a single file, confirmed 2026-09-15), only aggregate stats are embedded — raw per-recipient rows (real phone numbers) are never shipped to the page

**No phone number lookup** — the source file has no phone column, only Civil ID. Don't imply otherwise if asked.

**Expected result:** a `Matched against live Acquisition data: N / M` line, then `✅ SMS_Analyzer.html written — N campaigns, M rows.`, followed by `Archived: FILENAME → SMS Campaigns/`.

**Known quirk (2026-09-15):** the live-cross-referenced booked count can come out LOWER than the export's own snapshot count for some individual applications — a handful of applications booked at export time have since reversed to Cancelled (see Acquisition_Command_Dashboard.html's "Booked, then Cancelled" KPI for the same phenomenon elsewhere). This is expected, not a bug — each row in the Lookup & filter table is tagged LIVE or SNAPSHOT so it's clear which source its status came from.

### 3. Verify
```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('SMS_Analyzer.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
scripts.forEach((s,i)=>{ try{ new Function(s[1]); }catch(e){ console.log('BLOCK',i,'SYNTAX ERROR:',e.message); } });
console.log('syntax check done,', scripts.length, 'blocks');
"
grep -o '"totalRows":[0-9]*' SMS_Analyzer.html
grep -o '"deliveredMax":"[^"]*"' SMS_Analyzer.html
```
Confirm no syntax errors and `totalRows`/`deliveredMax` reflect the file just processed.

### 4. Commit and push
```bash
git fetch origin && git status -sb
```
Confirm in sync with `origin/master` before committing (if diverged, stop and report rather than force-push).

```bash
git add SMS_Analyzer.html
git commit -m "Update SMS Analyzer: SMS_Campaign_DATE (N applications, M campaigns)

Rebuilt from SMS_Campaign_DATE.xlsx: N applications, BOOKED booked (SAR AMOUNT).
Source file archived to SMS Campaigns/.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin master
```

### 5. Report
Tell the user:
- Which file was processed and its delivered-date range
- Total applications, and booked count/value, per campaign
- Confirmation the source file was archived (so Downloads is clean again)
- GitHub Pages link: https://eayyash.github.io/CashFunnel/SMS_Analyzer.html

## Key facts

- **Source files:** `SMS_Campaign_YYYY-MM-DD.xlsx` — 2 sheets: "Raw Data" (row-level, one row per application created via an SMS link) and "Summary" (vendor's own monthly rollup by campaign)
- **Target:** `SMS_Analyzer.html` in the project root — embedded `const SMS_DATA = {...};`
- **Merge logic:** last file wins, NOT additive — each export is a full fresh snapshot (same convention as Acquisition_for_Loans/SIMAH_Qarar_JSON daily files, unlike Funnel_Analysis's per-date accumulation)
- **"Submitted" vs "Submitted to Master":** every row has a StagingID (`id`) the moment an application is created from an SMS click-through — that's "Applications Created" / submitted. Many never reach the master Acquisition system at all (`SubmittedToMaster` stays blank, `Status_In_Master` stays blank) — those are excluded from "Submitted to Master" and everything downstream (approved/booked/cancelled), which all key off `Status_In_Master`
- **Booking detection:** `Status_In_Master` ∈ `{'Completed [C]', 'Pending Final Approval'}` — same `BOOKED_SET` convention as `update_acquisition_dashboard.js`. Cross-referenced rows use the live Acquisition `Altitudestatus` instead of this export's own `Status_In_Master`
- **Archive folder:** `smsArchiveDir` in `pipeline.config.json` (see `scripts/setup_config.js`) — `build_sms_analyzer.js` auto-moves the processed application-level file here after a successful build
- **Bulk SMS-sent lists folder:** `smsSentListsDir` in `pipeline.config.json` — a standing library, NOT an archive. Every xlsx already there gets reprocessed on every run (not moved out); drop a new file in to add a new "SMS Sent Campaigns" row, remove one to drop it from the page. Column names vary per file (`CivilID`/`CivilId`/`civilID`, `Mobile Phone`/`Mobile number`/`MobilePhone`, `Date of SMS`/`Date`) — the script tries known variants and skips (with a warning) any file where it can't find a CivilID or date column
- **The Summary sheet's own Total_bookings does NOT match this script's own booked count** (confirmed 2026-09-15: 1,299 vs 432 for ABNB in August, even before the live cross-reference was added) — almost certainly because bookings mature over weeks after an SMS send and the vendor's Summary rollup reflects more elapsed time than a fresh Raw Data export has had. Both are shown on the page side by side, with an explicit note — never try to reconcile them into one number
- No login/email gate on this dashboard (removed from all scorecards 2026-09-15, per explicit request)
- Do NOT add SMS_Campaign xlsx files to git — they are in `.gitignore`
- GitHub Pages URL: `https://eayyash.github.io/CashFunnel/`
- **Data source integrity:** the SMS Campaign xlsx is the only source of *which applications came from which SMS campaign and when*. The one deliberate exception (added 2026-09-15, explicit request): each application's live status/submitted-date/booked-date is cross-referenced against `Acquisition_for_Loans_all_merged.csv` by Staging ID, since that's the only way to know whether someone who received an SMS actually went on to submit and book — the export's own snapshot fields go stale within days. Still never pull Funnel or SIMAH data into this dashboard.

## Error handling

- If the xlsx is missing the "Raw Data" sheet: the script exits with an error — check the file isn't corrupted or a different export format
- If a new file's row count is dramatically smaller than the currently-live dashboard's `totalRows`: stop before processing, report it, and confirm with the user rather than silently overwriting good data with a stale/partial file
- If `xlsx` package isn't installed: run `npm install xlsx` first (it's normally already present, shared with the Acquisition/Funnel pipelines)
- If `Acquisition_for_Loans_all_merged.csv` isn't found: the script still runs, just without the live cross-reference (every row falls back to its own snapshot fields, and every SMS Sent Campaign shows 0 matches) — this is a warning, not a failure; report it if the user seems to expect fresher numbers
- If a bulk SMS-sent-list file has no recognizable CivilID/date columns: that one file is skipped with a warning, the rest of the run still succeeds — report which file and its actual column names so the mapping can be extended if it's a genuine new format
- If `smsSentListsDir` isn't set or doesn't exist: the script just skips the SMS Sent Campaigns section entirely (not an error)
- If the final HTML write fails with `UNKNOWN`/`EPERM` on this OneDrive-synced folder: the script already retries the rename step automatically (confirmed 2026-09-15, same intermittent lock seen in `build_simah_datechunks.js`) — if it still fails after 5 attempts, just re-run the whole command, it's safe (the script has no partial-write state to worry about, unlike SIMAH's per-date chunks)
- If git is not in sync with `origin/master`: stop, do not force-push, report the divergence
- If the archive move fails (e.g. permissions): the dashboard rebuild itself already succeeded and is safe — report the archive failure clearly so the file can be moved out of Downloads manually before the next run
