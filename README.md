# Armenia new builds

Part of [Colombo](https://colombo-am.github.io/), open data projects that make information about Armenia
transparent and reusable. Live map: https://colombo-am.github.io/armenia-new-builds/

Every public new-building project in Armenia on one map, with prices, construction stage, contacts
and a developer reputation rating — plus an analytics dashboard and a one-file SQLite database.

- **Map** (`index.html`) — Google Maps 2D / 3D / photorealistic 3D, pins coloured per developer,
  faceted filters, project details with images, videos, contacts, price check and developer rating.
- **Analytics** (`analytics.html`) — prices by district, price distribution, delivery pipeline,
  stages, price against completion date, developer ratings, data quality, below-median deals, and a
  connections graph of developers, their companies and the people who own them (graph or tree view),
  with bankruptcies marked.
- **Database** (`db/armenia-new-builds.sqlite`) — the whole dataset in SQL form, documented in
  [`db/db.md`](db/db.md).

Current snapshot: 680 projects, 331 developers, 132 sources, data generated 2026-11-08.

## Repository layout

| Path | What it is |
| --- | --- |
| `web/` | The static site: two HTML pages, CSS, plain ES modules, `web/data/projects.json`, `connections.json` and `history.json` |
| `web/i18n/` | UI dictionaries: `am.json` (Armenian, the default) and `en.json`, the same nested keys in both; `?lang=en` or the globe button switches |
| `scraper/` | Crawlers, the merge/normalize/score pipeline, verification data, source registry, publish gate |
| `db/` | Generated SQLite database and its documentation |
| `build.py` | Builds `dist/` for static hosting |
| `serve.py` | Local dev server on http://localhost:5190 (IPv4 + IPv6) |
| `.claude/skills/` | Self-improving data commands (`/nb-status`, `/nb-recrawl`, …), see [COMMANDS.md](COMMANDS.md) |
| `.github/` | CI, GitHub Pages deploy and the monthly data refresh |

There is no framework and no bundler: the pages load ES modules directly, so the build is a copy
step plus a generated `config.js`.

## Requirements

- Python 3.10+ (standard library only for building and serving)
- A Google Maps JavaScript API key with **Maps JavaScript API**, **Places API (New)**,
  **Geocoding API** and **Map Tiles API** (for photorealistic 3D) enabled

## Local development

```bash
cp web/config.example.js web/config.js   # then paste your key, or:
echo 'GOOGLE_MAP_API_KEY=your-key' > .env && python3 scraper/make_config.py
python3 serve.py 5190
```

Open http://localhost:5190. The Maps key must allow `localhost` under **Website restrictions**, or
Google shows "Oops! Something went wrong".

## Build

```bash
GOOGLE_MAP_API_KEY=your-key python3 build.py
```

Writes `dist/` (~17 MB): both pages, CSS, JS, `data/projects.json`, the SQLite database under
`db/`, a generated `config.js`, and `version.json` recording the commit and dataset date. The key
is read from the environment first, then from `.env`, so CI can inject it as a secret. Options:
`--out <dir>`, `--no-db`.

`dist/` is git-ignored — it is a build artifact, rebuilt on every deploy.

## Publishing

`.github/workflows/pages.yml` builds `dist/` on every push to `main` that touches `web/`, `db/` or
`build.py` and deploys it with GitHub Pages (Settings → Pages → Source: **GitHub Actions**). It needs
the secret `GOOGLE_MAP_API_KEY` (and optionally the variable `GOOGLE_MAP_ID`); restrict the key to
`https://colombo-am.github.io/*` under **Website restrictions**. Every path in `web/` is relative, so
the site works under any sub-path.

## Data

The site reads a single file, `web/data/projects.json`, built by the scraper pipeline:

```bash
python3 scraper/pipeline.py status          # dataset health
python3 scraper/pipeline.py crawl           # re-crawl sources
python3 scraper/pipeline.py build           # rebuild projects.json + a change report
python3 scraper/export_db.py                # rebuild the SQLite database
python3 scraper/audit_links.py              # re-test every link the pages show → web/data/link_status.json
python3 scraper/connections.py crawl        # rebuild the ownership graph (registry + court records)
```

Prices are asking prices published by developers and aggregators, reconciled across sources and
re-checked by hand; projects have no current public price and keep their last known figure
instead. Developer ratings combine track record, delivery, datalex.am court records, cross-source
validation and transparency. Full definitions, caveats and example queries are in
[`db/db.md`](db/db.md); the data commands are described in [COMMANDS.md](COMMANDS.md).

The connections graph (`web/data/connections.json`) links each developer to its registered companies and
to the people who own or run them, using the state register of legal entities and its beneficial-owner data
(e-register.moj.am, read through karg.am) plus bankruptcy cases from datalex.am. Every node carries the
links it was built from, so each claim can be checked at the source; bankruptcy notices are published on
azdarar.am, which blocks requests from outside Armenia and is therefore linked rather than crawled. A
company is marked as declared bankrupt only when a bankruptcy case is matched by the register showing the
company as no longer active; a case with the company as its own claimant is shown as a self-filed
bankruptcy, and anything else as a pending case. Of the developer-to-company links, 195 rest on a tax id
recorded in the reputation research and 147 on an exact name match in the register — the view labels which
is which — and 80 legal entities that could not be matched are left out rather than guessed.

azdarar.am blocks requests from outside Armenia, so `scraper/azdarar.py` is meant to be run from a
machine that can reach it (`python3 scraper/azdarar.py check` says whether this one can). `verify`
looks up every flagged company, writes `scraper/azdarar_notices.json`, and the next
`connections.py build` uses those notices as the authority for a bankruptcy status and links them
from the company. Without that file the site still works — it links the bulletin instead of quoting it.

Family ties between owners are not published by any Armenian register. Confirmed ones are recorded by
hand in `scraper/family_ties.json` with the document that confirms them (an official's asset
declaration, a court ruling, a named investigation). Everything else the page can offer is a lead:
two owners in one cluster sharing a surname, or one name appearing twice in the owner register. Those
are hidden behind a checkbox and labelled unverified.

## Automatic data refresh

`.github/workflows/refresh.yml` runs Claude Code headless on the 1st of every month (and on demand
from Actions → Data refresh, with a `full`/`quick` mode and a spend cap). It follows
`.github/refresh/prompt.md`: the `/nb-refresh` skills (recrawl, discovery of new projects and
sources, verification of every new or changed figure, reputation, connections), then a rebuild.

Nothing reaches the public pages without passing `scraper/publish_gate.py` against the last
published dataset: a new project without a checked location is held back, an unverified price is
removed from a new project, and an unverified price jump of 30 % or more, an unchecked stage
regression or an unchecked 1 km move on an existing project is reverted to the published value.
Structural problems (duplicate ids, coordinates outside Armenia, missing fields, more than 5 % of
projects vanishing) fail the run. Held and reverted items are listed in
`scraper/reports/gate-*.md`, and the next refresh verifies them first. Tests and the build must pass too; only then does the workflow commit to `main`, append a `refresh`
snapshot to `web/data/history.json`, and start the Pages deploy.

One-time setup: add the secret `ANTHROPIC_API_KEY`, ideally a key from a dedicated Console
workspace with its own monthly spend limit. A full run costs roughly $150–250; start with a manual
`quick` run and a low budget. The run reads arbitrary web pages with write access to the
checkout; the workflow keeps the GitHub token out of Claude's step, rejects changes to
`.github/` and the gate, refuses to publish if the API key appears in any file, and the gate
re-checks the data, but a dedicated key with a spend limit keeps the remaining risk bounded.

## Licence

- Code: [MIT](LICENSE).
- Data (`web/data/`, `db/`, and the verification and research files in `scraper/`):
  [CC BY 4.0](LICENSE-DATA.md). Reuse it freely, crediting "Colombo — Armenia new builds".
- Administrative boundaries in `scraper/geo/` are © OpenStreetMap contributors, under the
  [ODbL](https://opendatacommons.org/licenses/odbl/).
- The licence covers this compilation: prices, stages, ratings, links and structure. Photos, logos
  and texts that the map links to or shows belong to their owners.
