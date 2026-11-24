# nb-reputation learnings

## 2026-09-15 (initial build)
- datalex search is word-fuzzy: always filter to exact party names (datalex.py does) and sanity-check namesakes (Mets Syunik wine co., Vardanyanshin old Kotayk company, ՇԱՄԱԽՅԱՆ surname/street).
- Brands often sign contracts through project LLCs (Shinas for Tigran Mets, Magnolia Comfort for Zover, Arcada Construction for Ember, Gasparyan & Sons for Capital Build) — search those too.
- Tax IDs: karg.am/company/<id> and construction.am company pages are the quickest sources.
- WebSearch quota (200/session) runs out quickly with parallel agents; use news-site search pages (azatutyun, hetq, factor, aravot, armlur, 168.am) and Bing/Google News RSS as fallback, and mark coverage as partial in notes.
- "respondent_by_individuals" is a name-pattern heuristic; employee wage claims and shareholder disputes (Lorida Group) inflate it — note these.
- Zero datalex hits for companies with known tax IDs (Bedeck, TOP BUILDINGS, SIL Capital) usually means a spelling variant — try more variants.
- Coordinator agents that spawn helpers must run the final compile themselves; one run left a worker idling for 16 h waiting for a DONE file.

## 2026-11-06/07 (70 queued developers, 3 batches)
- Result: 70 researched; 18 grade changes. Serious: Kechark (E, 2 bankruptcies), Kanach Tagh (E, declared bankrupt 2025; sister «ԱՎԵՏԻՍՅԱՆ ՔՈՆՍԹՐԱՔՇՆ» too), V&B Construction (D, bankruptcy decided 27-07-2026, not yet in datalex), Shinas (D, 141 template money-recovery suits 2025–26 + 15.27M consumer fine), Magnolia Comfort (16 buyer suits; C after its 4th project joined via alias — legal penalty scales with portfolio), EcoPanel (D), Mikshin (65 cases, mostly claimant), MAGAS (6 late-handover suits), RID (8 suits from one landowner = title risk, not buyers).
- datalex.am's search API can slow to 14 s+ per request at night (homepage stays fast) while daytime is ~0.1 s: one developer took 1–3 h overnight. If throughput drops, pause and resume in the daytime rather than trimming name variants.
- datalex.py now rate-limits across processes (fcntl lock + shared timestamp in .cache_datalex/.rate.lock); MIN_INTERVAL alone was per process, so 3 agents tripled the rate.
- A network outage killed two agents mid-run; their files listed every developer but 24 were placeholders with zero court counts and "pending" notes — they would have shown as clean records. Always scan for "pending"/empty searched_names before building; resume the agent (SendMessage) to finish.
- A background runner died while the machine slept; a wait loop using `pgrep -f "<cmd>"` matched itself and never exited — poll for the output file instead.
- e-register name search works: https://e-register.moj.am/hy/search/companies?query=<Armenian name> (tax ID, reg date, address; 429 at ~1 req/s → use 2 s). Owner declarations confirm matches (owner name vs contact email/brand). A project company's legal address is often the project plot (Mountain Plaza, HATIS, AAA Shin Dro 13/1) — strongest single proof. Search a short stem first (ՆՈՅ ԼԱՔՇ, ՎԻ ԸՆԴ ԲԻ).
- Register "no liquidation" doesn't rule out bankruptcy — check scraper/azdarar_notices.json by tax ID and the datalex bankruptcy tab; datalex lags azdarar by months.
- Unverified entity matches must not feed scored counts: Amur Construction's 4 bankruptcy petitions belong to «ԱՄՈՒՐ ՔՆՍՏՐԱՔՇՆՍ» (one letter off, no address/owner link) → kept in notes, zeroed in counts until confirmed.
- New project-LLC mappings: Hatshin Construct → HATIS PARK; Total Shin / Nash Group → Leningradyan Residence; KAM Developments → Nova Building (HAEKSHIN API "client" field: system.haekshin.am/api/projects/details?slug=…); «ՆՈՅ ԼԱՔՇԵՐԻ ԸՓԱՐԹՄԵՆԹ» → Noy; Aygedzor → Alma-ata Rezidens (same address, merged).
- Namesakes: ՎԵՆԻ ԳՐՈՒՊ (Veni Business Center) ≠ ՎԵՆՆԻ ԳՐՈՒՊ (Venni Group — was wrongly D); many «ԲԱՐՍ», «ԴՐԻՄ ՀԱՈՒՍ»; ԱՅԳԵՁՈՐ condominium/Berd village. Residents' condominiums (ՀՄՏ) at a project address confirm completion but aren't the developer.
- "respondent_by_individuals" counts parties without a legal-form marker as people, so company names like «ԴԱՎ ԿԱՊԻՏԱԼ ՍՏՐՈՅ» inflate it; check for surname endings (…յան, …ունց, …ով).
- A one-word datalex query also catches longer names containing it (ՄԵՏՐՈՒՄ ԻՆՎԵՍՏ covers …ԳՐՈՒՊ) — saves queries. Large contractors (Լ.Ա.Պ.Ա.) return hundreds of claimant rows; skip unless they are the developer.
