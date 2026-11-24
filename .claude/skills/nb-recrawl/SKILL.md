---
name: nb-recrawl
description: Re-crawl the existing sources of the Armenia new-builds map (aggregators, bank catalogs, developer websites), rebuild the dataset and produce a change report (new/removed projects, price, stage, location and grade changes). Use for "recrawl", "refresh data", "update prices from sources", or a specific source name.
argument-hint: "[all | karucapatoxic | extra[:geoln,dignisi] | catalogs | devsites | enrich] [--fresh]"
---

# nb-recrawl

Work from the `armenia-new-builds` folder. Read `LEARNINGS.md` and `scraper/sources.json` first — they record site quirks and blocked sources.

## 1. Plan
- Parse the argument (default `all`). `--fresh` refetches pages; without it cached pages are reused (fast, offline-safe).
- Skip sources with status `blocked`/`dead` in `scraper/sources.json` unless the user names them.

## 2. Crawl scripted sources
Use a Python that has `shapely` for the build (`python3.14` on this machine; Homebrew `python3` 3.15 lacks it).
```
python3 scraper/pipeline.py crawl --only karucapatoxic,extra,catalogs [--fresh] [--extra-sources geoln,dignisi]
```
Snapshot the output files before crawling. If a scraper fails or returns far fewer projects than last time (compare per-source counts) — or a field (status, completion, price) suddenly goes empty for a whole source — inspect the site, fix the scraper minimally, re-run, and record the cause. Never solve captchas: mark the source `blocked` (extra_sources.py carries its last records forward).

## 3. Developer websites (`devsites`)
- Input: `scraper/developers_master.json` entries with `projects_url`.
- Split into batches of ~45 and launch background agents (general-purpose) with `project_schema.md` as the output contract, writing `scraper/developer_projects_b<N>.json` (reuse existing file names so the build picks them up). Reference per-developer scrapers are in `scraper/agent_work/devsites_b*/`.
- Tell agents to keep polite rates, never log in, and rewrite their file incrementally, and to carry a developer's previous records forward when its site fails (give them the combined previous output).
- When all batches finish, compare per-`source` domain counts old vs new across all `developer_projects_b*.json`; any domain that dropped to 0 without a reported reason was lost — resume that batch's agent to restore it.

## 4. Enrich + build + diff
```
python3 scraper/pipeline.py crawl --only enrich
python3 scraper/pipeline.py build
```
Open the new `scraper/reports/diff-*.md`. Investigate anomalies before accepting: mass removals (scraper broke), price jumps > 40 % (unit/currency slip), pins moved > 1 km (bad source coordinates). Fix or add overrides, rebuild.

## 5. Queue follow-up checks
`python3 scraper/pipeline.py audit all` and tell the user how many items each `/nb-verify` kind would re-check.

## 6. Self-improve and commit
Follow `../SELF_IMPROVEMENT.md` (record, promote, verify, commit `nb-recrawl: …`, report).
