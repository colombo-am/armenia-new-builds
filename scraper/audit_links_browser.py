"""Second pass of the link audit: open every link the script pass could not settle in headless Chrome.

JavaScript-only pages, sites that refuse scripts and pages that did not seem to name what they are
cited for are loaded in a real browser, and the rendered page is judged with the same rules as the
first pass (audit_links.judge_page). A page that asks for a captcha or a login is recorded as such —
never solved or bypassed — and shown to readers as "not verified". Results are stored next to the
first-pass result in scraper/link_audit.json, then web/data/link_status.json is re-exported.

Needs Playwright and uses the installed Google Chrome (no browser download):
    python3 -m venv .venv && .venv/bin/pip install playwright
    .venv/bin/python scraper/audit_links_browser.py [--only HOST] [--recheck] [--workers N] [--limit N]
"""
from __future__ import annotations

import argparse
import asyncio
import re
import time
from collections import Counter, defaultdict
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

import audit_links as al
import check_urls as cu

HOST_GAP = 1.5          # seconds between two page loads on one host
GOTO_TIMEOUT = 30_000   # ms
SETTLE_TIMEOUT = 7_000  # ms to wait for the network to go quiet after load
CAPTCHA_STREAK = 4      # after this many captcha pages in a row, a host is assumed to gate every page
CAPTCHA = re.compile(r"captcha|g-recaptcha|hcaptcha|cf-turnstile", re.I)
CHALLENGE = re.compile(r"cf-chl|challenge-platform|/checkpoint/", re.I)  # a gate in front of the page itself
GATE_TEXT = 1500  # a captcha widget on a page with more text than this is a form on the page, not a gate
LOGIN = re.compile(r"log in to facebook|log into facebook|log in to instagram|sign in to linkedin|join linkedin|"
                   r"войдите|вход в facebook", re.I)
NO_RESULTS = re.compile(r"արդյունքների քանակը[՝:]?\s*\(0\)|ոչինչ չի գտ[նվ]|no results found|nothing found|"
                        r"ничего не найдено|0 results|արդյունքներ չեն գտնվել", re.I)
SKIP_REASONS = {"dns", "noembed"}  # already conclusive: the domain is gone / the owner disabled embedding


def candidates(cache: dict, entries: dict, args) -> list[str]:
    """Links whose first-pass status is not ok and that a browser could still settle."""
    out = []
    for url, r in cache.items():
        e = entries.get(url)
        if not e or not e["kinds"] & set(al.LINK_KINDS):
            continue
        if args.only and args.only not in urlsplit(url).netloc:
            continue
        if r.get("browser") and not args.recheck:
            continue
        status, reason = al.status_of({k: v for k, v in r.items() if k != "browser"}, url)
        if status != "ok" and reason not in SKIP_REASONS:
            out.append(url)
    return out[: args.limit] if args.limit else out


class Hosts:
    """Per-host spacing and captcha streaks, shared by all workers."""

    def __init__(self) -> None:
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.last: dict[str, float] = {}
        self.captcha: Counter = Counter()

    async def wait(self, host: str) -> None:
        gap = HOST_GAP - (time.monotonic() - self.last.get(host, 0))
        if gap > 0:
            await asyncio.sleep(gap)
        self.last[host] = time.monotonic()


async def check_video(ctx, url: str) -> dict:
    """A video file is not a page to render: ask for it and look at what comes back."""
    try:
        resp = await ctx.request.get(url, timeout=GOTO_TIMEOUT, max_redirects=5)
        ok = resp.ok and re.match(r"video/|text/html|application/octet-stream", resp.headers.get("content-type", ""))
        return {"verdict": "ok" if ok else cu.classify(resp.status, None), "status": resp.status}
    except Exception as e:  # noqa: BLE001
        return {"verdict": "unreachable", "error": f"{type(e).__name__}: {e}"[:200]}


async def check_page(ctx, url: str, e: dict) -> dict:
    """Load the page, let its scripts run, and judge what a reader would see."""
    page = await ctx.new_page()
    try:
        resp = await page.goto(cu.encoded(url), wait_until="domcontentloaded", timeout=GOTO_TIMEOUT)
        try:
            await page.wait_for_load_state("networkidle", timeout=SETTLE_TIMEOUT)
        except Exception:  # noqa: BLE001 — pages that keep polling never go idle; what has rendered is enough
            pass
        status = resp.status if resp else None
        html = await page.content()
        res = {"status": status, "final_url": page.url, "verdict": cu.classify(status, None)}
        text = await page.inner_text("body") if await page.query_selector("body") else ""
        # An empty search result repeats the query ("nothing found for X"), so it is checked before matching.
        if NO_RESULTS.search(text):
            return {**res, "content": "noresults"}
        judged = al.judge_page(url, e, html, page.url)
        if judged.get("content") != "match":
            if CHALLENGE.search(html) or (CAPTCHA.search(html) and len(text.strip()) < GATE_TEXT):
                return {**res, "verdict": "captcha"}
            if LOGIN.search(text) or "/login" in urlsplit(page.url).path:
                return {**res, "verdict": "login"}
        if res["verdict"] == "ok":
            res.update(judged)
        return res
    except Exception as err:  # noqa: BLE001 — timeouts, TLS and DNS errors all mean the reader cannot open it
        return {"verdict": "dns" if "ERR_NAME_NOT_RESOLVED" in str(err) else "unreachable", "error": f"{type(err).__name__}: {err}"[:200]}
    finally:
        await page.close()


async def worker(queue: asyncio.Queue, ctx, entries: dict, cache: dict, hosts: Hosts, progress: Counter) -> None:
    while True:
        url = await queue.get()
        try:
            host = urlsplit(url).netloc
            if hosts.captcha[host] >= CAPTCHA_STREAK:
                res = {"verdict": "captcha", "inferred": True}
            else:
                async with hosts.locks[host]:
                    await hosts.wait(host)
                    e = entries[url]
                    is_file = e["kinds"] == {"video"} or re.search(r"\.(mp4|webm|mov)(\?|$)", url)
                    res = await (check_video(ctx, url) if is_file else check_page(ctx, url, e))
                hosts.captcha[host] = hosts.captcha[host] + 1 if res["verdict"] == "captcha" else 0
            cache[url]["browser"] = {**res, "checked": time.strftime("%Y-%m-%d")}
            progress[res["verdict"] + ("/" + res["content"] if res.get("content") else "")] += 1
            progress["_done"] += 1
            if progress["_done"] % 50 == 0:
                print(f"  {progress['_done']} checked", flush=True)
                al.save(cache)
        finally:
            queue.task_done()


async def run(args) -> None:
    entries = al.collect()
    cache = al.load_cache()
    todo = candidates(cache, entries, args)
    print(f"{len(todo)} links to open in the browser: "
          f"{dict(Counter(urlsplit(u).netloc for u in todo).most_common(8))}", flush=True)
    queue: asyncio.Queue = asyncio.Queue()
    for url in todo:
        queue.put_nowait(url)
    hosts, progress = Hosts(), Counter()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=True)
        ctx = await browser.new_context(locale="en-US", viewport={"width": 1280, "height": 900}, ignore_https_errors=False)
        # Images, fonts and media only slow the check down; the text decides the verdict.
        await ctx.route("**/*", lambda route: route.abort() if route.request.resource_type in ("image", "font", "media")
                        else route.continue_())
        tasks = [asyncio.create_task(worker(queue, ctx, entries, cache, hosts, progress)) for _ in range(args.workers)]
        await queue.join()
        for task in tasks:
            task.cancel()
        await browser.close()
    al.save(cache)
    progress.pop("_done", None)
    print("browser verdicts:", dict(progress))
    al.export(entries, cache)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="limit to URLs on this host")
    ap.add_argument("--recheck", action="store_true", help="open links again even if the browser checked them")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, help="check at most this many links (for a trial run)")
    args = ap.parse_args()
    asyncio.run(run(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
