#!/usr/bin/env python3
"""Rassemble les titres de presse sur la présidentielle 2027 à partir des flux RSS des médias.

Seuls le titre, le lien, le média et la date sont conservés : aucun extrait, aucune
image. Le résumé fourni par le flux sert uniquement à repérer les articles pertinents
et n'est jamais enregistré. Écrit data/actualites.json (non versionné : le fichier est
régénéré à chaque publication et fusionné avec la version en ligne).

    python3 scripts/update_news.py
    python3 scripts/update_news.py --previous https://…/data/actualites.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import html
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "actualites.json"
POLLS = ROOT / "data" / "sondages.json"

# Flux RSS publics des rubriques politiques (médias d'orientations diverses).
FEEDS = [
    ("Le Monde", "https://www.lemonde.fr/politique/rss_full.xml"),
    ("franceinfo", "https://www.francetvinfo.fr/politique.rss"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_politique.xml"),
    ("Libération", "https://www.liberation.fr/arc/outboundfeeds/rss/category/politique/?outputType=xml"),
    ("20 Minutes", "https://www.20minutes.fr/feeds/rss-politique.xml"),
    ("BFMTV", "https://www.bfmtv.com/rss/politique/"),
    ("L'Express", "https://www.lexpress.fr/arc/outboundfeeds/rss/politique.xml"),
    ("HuffPost", "https://www.huffingtonpost.fr/politique/rss_headline.xml"),
    ("France 24", "https://www.france24.com/fr/france/rss"),
    ("RFI", "https://www.rfi.fr/fr/france/rss"),
]
KEEP_DAYS = 14
MAX_ITEMS = 500
MAX_BYTES = 5_000_000
USER_AGENT = "Presidentielle2027Tracker/1.0 (+https://github.com/lcarwy/presidentielle-2027)"

ELECTION = re.compile(r"\bprésidentielle|\b2027\b|\bprimaire|\bsondage|\bcandidature", re.I)
# Noms trop courants pour être reconnus seuls : on exige alors prénom + nom.
AMBIGUOUS = {"philippe", "hollande", "roussel", "faure", "bertrand", "royal", "borne",
             "le-maire", "rousseau", "maurel", "villiers"}


def fold(s: str) -> str:
    """Retire les accents (en gardant la casse) pour comparer « Edouard » et « Édouard »."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def candidate_patterns(since_days: int = 180):
    """Personnalités testées dans les sondages récents -> expression régulière de détection."""
    try:
        data = json.loads(POLLS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    limit = (dt.date.today() - dt.timedelta(days=since_days)).isoformat()
    recent = {k for p in data["sondages"] if p["fin"] >= limit for h in p["hypotheses"] for k in h}
    pats = {}
    for key in recent:
        full = data["candidats"].get(key, {}).get("nom") or ""
        parts = full.split(" ")
        if len(parts) < 2:
            continue
        surname = " ".join(parts[1:])
        surname_core = re.sub(r"^(de|d')\s*", "", surname)
        names = [fold(full)] if key in AMBIGUOUS else [fold(full), fold(surname_core)]
        alt = "|".join(re.escape(n) for n in sorted(set(names), key=len, reverse=True))
        pats[key] = re.compile(rf"(?<![\w-])(?:{alt})(?![\w-])")
    return pats


def strip_tags(s: str | None) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("flux trop volumineux")
    return data


def child_text(el, *names):
    for n in names:
        found = el.find(n)
        if found is not None and (found.text or found.get("href")):
            return found.text or found.get("href")
    return None


def parse_date(raw: str | None):
    if not raw:
        return None
    raw = raw.strip()
    try:
        d = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def parse_feed(source: str, data: bytes, pats, now):
    root = ET.fromstring(data)
    atom = "{http://www.w3.org/2005/Atom}"
    entries = list(root.iter("item")) or list(root.iter(f"{atom}entry"))
    out = []
    for e in entries:
        title = strip_tags(child_text(e, "title", f"{atom}title"))
        link = (child_text(e, "link", f"{atom}link") or "").strip()
        if len(title.split()) < 4 or not re.match(r"^https?://", link):
            continue  # titre réduit à un nom (page thème) ou lien invalide
        date = parse_date(child_text(e, "pubDate", "{http://purl.org/dc/elements/1.1/}date",
                                     f"{atom}updated", f"{atom}published"))
        if date and date > now:
            date = now
        summary = strip_tags(child_text(e, "description", f"{atom}summary"))
        haystack = fold(f"{title} {summary}")
        tags = sorted(k for k, p in pats.items() if p.search(haystack))
        if not tags and not ELECTION.search(f"{title} {summary}"):
            continue
        out.append({
            "id": hashlib.sha1(link.encode()).hexdigest()[:12],
            "titre": title,
            "url": link,
            "source": source,
            "date": date.isoformat().replace("+00:00", "Z") if date else None,
            "candidats": tags,
        })
    return out


def load_previous(where: str | None):
    if where:
        try:
            if re.match(r"^https?://", where):
                return json.loads(fetch(where))
            return json.loads(Path(where).read_text(encoding="utf-8"))
        except (OSError, ValueError, urllib.error.URLError) as e:
            print(f"avertissement : version précédente indisponible ({e})", file=sys.stderr)
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--previous", help="URL ou fichier de la version précédente, pour garder l'historique")
    args = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    nowiso = now.isoformat().replace("+00:00", "Z")
    pats = candidate_patterns()

    def one(feed):
        name, url = feed
        try:
            return name, parse_feed(name, fetch(url), pats, now), None
        except Exception as e:  # un flux en panne ne doit pas bloquer les autres
            return name, [], str(e)[:120]

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(one, FEEDS))

    previous = load_previous(args.previous) or {}
    items = {a["id"]: a for a in previous.get("articles", []) if a.get("url", "").startswith("http")}
    sources = []
    for name, found, err in results:
        sources.append({"nom": name, "ok": err is None, "articles": len(found)})
        if err:
            print(f"avertissement : {name} : {err}", file=sys.stderr)
        for a in found:
            old = items.get(a["id"])
            a["date"] = a["date"] or (old or {}).get("date") or nowiso
            items[a["id"]] = a

    # Un même titre repris deux fois par un média (liens différents) n'apparaît qu'une fois.
    seen, articles = set(), []
    cutoff = (now - dt.timedelta(days=KEEP_DAYS)).isoformat().replace("+00:00", "Z")
    for a in sorted(items.values(), key=lambda a: a["date"], reverse=True):
        k = (a["source"], fold(a["titre"]).lower())
        if a["date"] < cutoff or k in seen:
            continue
        seen.add(k)
        articles.append(a)
    articles = articles[:MAX_ITEMS]

    if not any(s["ok"] for s in sources) and not articles:
        print("refus : aucun flux n'a pu être lu", file=sys.stderr)
        return 2

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"mis_a_jour": nowiso, "sources": sources, "articles": articles},
                              ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    ok = sum(s["ok"] for s in sources)
    print(f"{len(articles)} articles ({ok}/{len(sources)} flux lus)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
