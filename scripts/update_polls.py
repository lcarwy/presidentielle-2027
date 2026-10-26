#!/usr/bin/env python3
"""Récupère les sondages de la présidentielle 2027 depuis Wikipédia (fr).

Source : « Liste de sondages sur l'élection présidentielle française de 2027 ».
Le script lit les tableaux du premier et du second tour, les normalise et écrit
data/sondages.json (utilisé par le site) et data/sondages.csv (export).

Bibliothèque standard uniquement : aucune dépendance à installer.

    python3 scripts/update_polls.py            # télécharge et met à jour
    python3 scripts/update_polls.py --html f   # utilise un fichier HTML local
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

PAGE = "Liste de sondages sur l'élection présidentielle française de 2027"
API = "https://fr.wikipedia.org/w/api.php"
PAGE_URL = "https://fr.wikipedia.org/wiki/" + urllib.parse.quote(PAGE.replace(" ", "_"))
REPO = os.environ.get("GITHUB_REPOSITORY", "")
USER_AGENT = f"Presidentielle2027Tracker/1.0 (https://github.com/{REPO}; python-urllib)"

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "data" / "sondages.json"
OUT_CSV = ROOT / "data" / "sondages.csv"

MONTHS = {
    "janvier": 1, "janv": 1, "jan": 1,
    "février": 2, "fevrier": 2, "févr": 2, "fevr": 2, "fév": 2, "fev": 2,
    "mars": 3, "mar": 3,
    "avril": 4, "avr": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7, "juil": 7,
    "août": 8, "aout": 8,
    "septembre": 9, "sept": 9, "sep": 9,
    "octobre": 10, "oct": 10,
    "novembre": 11, "nov": 11,
    "décembre": 12, "decembre": 12, "déc": 12, "dec": 12,
}

VOID = {"br", "img", "hr", "meta", "link", "input", "wbr", "col", "source", "area"}


# --------------------------------------------------------------------------
# Mini DOM
# --------------------------------------------------------------------------

class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children = []
        self.parent = parent

    def iter(self, *tags):
        for ch in self.children:
            if isinstance(ch, Node):
                if not tags or ch.tag in tags:
                    yield ch
                yield from ch.iter(*tags)

    @property
    def classes(self):
        return set((self.attrs.get("class") or "").split())


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, attrs, self.stack[-1]))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def is_hidden(node: Node) -> bool:
    style = (node.attrs.get("style") or "").replace(" ", "").lower()
    cls = node.classes
    return (
        "display:none" in style
        or "reference" in cls
        or "sortkey" in cls
        or "mw-ref" in cls
        or node.tag in ("style", "script")
    )


def text_of(node: Node) -> str:
    out = []

    def walk(n):
        for ch in n.children:
            if isinstance(ch, str):
                out.append(ch)
            elif ch.tag == "br":
                out.append(" ")
            elif not is_hidden(ch):
                walk(ch)

    walk(node)
    s = "".join(out).replace("\xa0", " ").replace(" ", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip()


def link_titles(node: Node) -> list[str]:
    titles = []

    def walk(n):
        for ch in n.children:
            if isinstance(ch, Node) and not is_hidden(ch):
                if ch.tag == "a" and ch.attrs.get("title"):
                    titles.append(ch.attrs["title"])
                walk(ch)

    walk(node)
    return titles


def external_link(node: Node) -> str | None:
    for a in node.iter("a"):
        href = a.attrs.get("href") or ""
        if href.startswith("http") and "wikipedia.org" not in href:
            return href
    return None


# --------------------------------------------------------------------------
# Tableaux
# --------------------------------------------------------------------------

def table_rows(table: Node) -> list[Node]:
    rows = []
    for ch in table.children:
        if not isinstance(ch, Node):
            continue
        if ch.tag == "tr":
            rows.append(ch)
        elif ch.tag in ("tbody", "thead", "tfoot"):
            rows.extend(c for c in ch.children if isinstance(c, Node) and c.tag == "tr")
    return rows


def expand(table: Node):
    """Étend rowspan/colspan : renvoie une grille [ligne][colonne] -> cellule."""
    grid: dict[tuple[int, int], dict] = {}
    rows = table_rows(table)
    for r, tr in enumerate(rows):
        c = 0
        for cell in tr.children:
            if not isinstance(cell, Node) or cell.tag not in ("td", "th"):
                continue
            while (r, c) in grid:
                c += 1
            rs = _int(cell.attrs.get("rowspan"), 1)
            cs = _int(cell.attrs.get("colspan"), 1)
            info = {
                "node": cell,
                "th": cell.tag == "th",
                "text": text_of(cell),
                "r0": r,
                "c0": c,
                "cs": cs,
            }
            for dr in range(rs):
                for dc in range(cs):
                    grid[(r + dr, c + dc)] = info
            c += cs
    nrows = len(rows)
    ncols = max((k[1] for k in grid), default=-1) + 1
    return [[grid.get((r, c)) for c in range(ncols)] for r in range(nrows)]


def _int(v, default):
    try:
        return int(re.sub(r"\D", "", str(v))) if v else default
    except ValueError:
        return default


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


NAME_PARTY = re.compile(r"^(.*?)\s*\(\s*([^()]*?)\s*\)\s*$")
VALUE = re.compile(r"^\s*([<≤]?)\s*(\d+(?:[.,]\d+)?)\s*%?\s*(.*)$")


def parse_header(text: str):
    """« Mélenchon (LFI) » -> ("Mélenchon", "LFI") ; « Candidat RN » -> (None, "RN")."""
    text = text.strip()
    m = NAME_PARTY.match(text)
    name, party = (m.group(1), m.group(2)) if m else (text, None)
    if re.match(r"^candidate?s?\b", name, re.I):
        return None, (party or re.sub(r"^candidate?s?\s*", "", name, flags=re.I)).strip() or None
    return name.strip() or None, party


def parse_value(text: str):
    """« 13 Glucksmann » -> (13.0, "Glucksmann", None) ; « — » -> None."""
    m = VALUE.match(text)
    if not m:
        return None
    val = float(m.group(2).replace(",", "."))
    if m.group(1):  # « <0,5 »
        val = val / 2
    rest = m.group(3).strip()
    name = party = None
    if rest:
        nm = NAME_PARTY.match(rest)
        name, party = (nm.group(1).strip(), nm.group(2)) if nm else (rest, None)
    return val, name or None, party


def parse_dates(text: str, default_year: int | None):
    """« 28 septembre-1er octobre » -> (date début, date fin)."""
    t = text.lower().replace("1er", "1").replace("\xa0", " ")
    t = re.sub(r"\[.*?\]", "", t)
    t = re.sub(r"\s*(?:–|—|-|au)\s*", "-", t)
    t = t.replace(".", " ")
    parts = [p.strip() for p in t.split("-") if p.strip()]
    if not parts:
        return None, None

    def piece(p):
        m = re.match(r"^(\d{1,2})?\s*([a-zéûôè]+)?\s*(\d{4})?$", p.strip())
        if not m:
            return None
        day = int(m.group(1)) if m.group(1) else None
        month = MONTHS.get(m.group(2)) if m.group(2) else None
        year = int(m.group(3)) if m.group(3) else None
        return day, month, year

    end = piece(parts[-1])
    start = piece(parts[0]) if len(parts) > 1 else end
    if not end or end[0] is None or end[1] is None:
        return None, None
    ey = end[2] or default_year
    if ey is None:
        return None, None
    try:
        end_d = dt.date(ey, end[1], end[0])
        sd, sm, sy = start if start else (None, None, None)
        sd = sd or end[0]
        sm = sm or end[1]
        sy = sy or (ey - 1 if sm > end[1] else ey)
        start_d = dt.date(sy, sm, sd)
    except ValueError:
        return None, None
    if start_d > end_d:
        start_d = end_d
    return start_d, end_d


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

class Extractor:
    def __init__(self):
        self.full_names: dict[str, str] = {}
        self.parties: dict[str, str] = {}
        self.warnings: list[str] = []

    def remember(self, name, party, titles):
        if not name:
            return None
        key = slug(name)
        if party and key not in self.parties:
            self.parties[key] = party
        for t in titles:
            t = re.sub(r"\s*\(.*\)$", "", t)
            if slug(t).endswith(key) and key not in self.full_names:
                self.full_names[key] = t
        return key

    def columns(self, grid, header_rows):
        cols = []
        for c in range(len(grid[0]) if grid else 0):
            label, node = "", None
            for r in range(header_rows):
                cell = grid[r][c]
                if cell and cell["th"] and cell["text"]:
                    label, node = cell["text"], cell["node"]
            low = label.lower()
            if low.startswith("sondeur") or low.startswith("institut"):
                kind = "pollster"
            elif low.startswith("date"):
                kind = "date"
            elif low.startswith("échantillon") or low.startswith("echantillon"):
                kind = "sample"
            elif not label or re.match(r"^(autres?|vote blanc|blancs?|abst|nsp|ne se prononce)", low):
                kind = "ignore"
            else:
                kind = "candidate"
            col = {"kind": kind, "label": label}
            if kind == "candidate":
                name, party = parse_header(label)
                col["party"] = party
                col["key"] = self.remember(name, party, link_titles(node) if node else [])
            cols.append(col)
        return cols

    def rows(self, grid, default_year):
        """Itère sur les lignes de données : (cellule sondeur, date, échantillon, {clé: score})."""
        if not grid:
            return
        ncols = len(grid[0])
        header_rows = 0
        for r, row in enumerate(grid):
            first = row[0]
            if first and not first["th"] and first["text"] and first["cs"] < ncols - 2:
                header_rows = r
                break
        cols = self.columns(grid, header_rows)
        idx = {k: next((i for i, c in enumerate(cols) if c["kind"] == k), None)
               for k in ("pollster", "date", "sample")}
        if idx["pollster"] is None or idx["date"] is None:
            self.warnings.append("tableau sans colonne sondeur/date ignoré")
            return
        for r in range(header_rows, len(grid)):
            row = grid[r]
            pcell = row[idx["pollster"]]
            if not pcell or pcell["th"] or pcell["cs"] >= ncols - 2 or not pcell["text"]:
                continue  # ligne d'événement (« X annonce sa candidature »)
            start, end = parse_dates(row[idx["date"]]["text"], default_year) if row[idx["date"]] else (None, None)
            if not end:
                self.warnings.append(f"date illisible : {row[idx['date']]['text'] if row[idx['date']] else '?'}")
                continue
            sample = None
            if idx["sample"] is not None and row[idx["sample"]]:
                digits = re.sub(r"\D", "", row[idx["sample"]]["text"].split("(")[0])
                sample = int(digits) if digits else None
            scores, alternatives, seen, ok = {}, [], set(), True
            for c, col in enumerate(cols):
                cell = row[c]
                if col["kind"] != "candidate" or not cell or cell["th"]:
                    continue
                if id(cell) in seen:
                    continue  # cellule fusionnée (colspan) déjà lue
                seen.add(id(cell))
                parsed = parse_value(cell["text"])
                if not parsed:
                    continue
                val, name, party = parsed
                if name:
                    # « 34 Bardella / Le Pen » : même score pour deux personnalités
                    names = [n.strip() for n in re.split(r"\s+(?:/|ou)\s+", name) if n.strip()]
                    titles = link_titles(cell["node"])
                    keys = [self.remember(n, party or col["party"], titles) for n in names]
                else:
                    spanned = {cols[c + i].get("key") for i in range(cell["cs"]) if c + i < len(cols)}
                    keys = [col["key"]] if len(spanned) == 1 else [None]  # candidature commune
                if not all(keys):
                    self.warnings.append(f"cellule ambiguë ({col['label']}) : {cell['text']}")
                    ok = False
                    break
                if len(keys) > 1:
                    alternatives.append((keys, val))
                elif keys[0] not in scores:  # même personne dans deux colonnes : on garde la 1re
                    scores[keys[0]] = val
            if not ok or not scores:
                continue
            variants = [scores]
            for keys, val in alternatives:
                variants = [{**v, k: val} for v in variants for k in keys if k not in v]
            for v in variants:
                yield pcell, start, end, sample, v


POLLSTERS = {
    "cluster17": "Cluster17",
    "harris": "Harris Interactive",
    "harrisinteractive": "Harris Interactive",
    "tolunaharrisinteractive": "Harris Interactive",
    "ifopfiducial": "Ifop",
    "ipsosbva": "Ipsos",
    "opinionway": "OpinionWay",
}


def clean_pollster(text: str) -> str:
    t = re.sub(r"\[.*?\]", "", text).strip()
    t = re.sub(r"\s+", " ", t)
    return POLLSTERS.get(re.sub(r"[^a-z0-9]", "", slug(t)), t)


def poll_id(pollster, end, sample):
    return f"{end.isoformat()}-{slug(pollster)}" + (f"-{sample}" if sample else "")


def extract(page_html: str):
    tb = TreeBuilder()
    tb.feed(page_html)
    ex = Extractor()

    h2 = h3 = h4 = ""
    first_round: dict[str, dict] = {}
    duels: dict[tuple, dict] = {}

    for node in tb.root.iter("h2", "h3", "h4", "table"):
        if node.tag == "h2":
            h2, h3, h4 = text_of(node), "", ""
            continue
        if node.tag == "h3":
            h3, h4 = text_of(node), ""
            continue
        if node.tag == "h4":
            h4 = text_of(node)
            continue
        if "wikitable" not in node.classes:
            continue
        sec = h2.lower()
        grid = expand(node)
        if "premier tour" in sec:
            m = re.search(r"(20\d\d)", h4 or h3)
            if not m:
                continue  # « Autres » : configurations hors sujet (vote blanc, Macron…)
            year = int(m.group(1))
            for pcell, start, end, sample, scores in ex.rows(grid, year):
                pollster = clean_pollster(pcell["text"])
                pid = poll_id(pollster, end, sample)
                poll = first_round.setdefault(pid, {
                    "id": pid,
                    "institut": pollster,
                    "debut": start.isoformat(),
                    "fin": end.isoformat(),
                    "echantillon": sample,
                    "notice": external_link(pcell["node"]),
                    "hypotheses": [],
                    "_cell": id(pcell),
                })
                if scores not in poll["hypotheses"]:
                    poll["hypotheses"].append(scores)
        elif "second tour" in sec:
            for pcell, start, end, sample, scores in ex.rows(grid, None):
                if len(scores) != 2:
                    continue
                a, b = sorted(scores)
                duel = duels.setdefault((a, b), {"a": a, "b": b, "sondages": []})
                pollster = clean_pollster(pcell["text"])
                entry = {
                    "id": poll_id(pollster, end, sample),
                    "institut": pollster,
                    "debut": start.isoformat(),
                    "fin": end.isoformat(),
                    "echantillon": sample,
                    "notice": external_link(pcell["node"]),
                    "a": scores[a],
                    "b": scores[b],
                }
                if entry not in duel["sondages"]:
                    duel["sondages"].append(entry)

    polls = sorted(first_round.values(), key=lambda p: (p["fin"], p["institut"]), reverse=True)
    for p in polls:
        p.pop("_cell", None)
        for h in p["hypotheses"]:
            total = sum(h.values())
            if not 80 <= total <= 105:
                ex.warnings.append(f"{p['id']} : total d'hypothèse inhabituel ({total:.1f})")
    duel_list = sorted(duels.values(), key=lambda d: -len(d["sondages"]))
    for d in duel_list:
        d["sondages"].sort(key=lambda s: (s["fin"], s["institut"]), reverse=True)

    used = {k for p in polls for h in p["hypotheses"] for k in h} | {d[x] for d in duel_list for x in "ab"}
    candidats = {
        k: {"nom": ex.full_names.get(k) or k.replace("-", " ").title(), "parti": ex.parties.get(k)}
        for k in sorted(used)
    }
    return polls, duel_list, candidats, ex.warnings


# --------------------------------------------------------------------------
# Entrées / sorties
# --------------------------------------------------------------------------

def api_get(params: dict, attempts: int = 5):
    """Appel à l'API MediaWiki, avec nouvelles tentatives si Wikipédia limite le débit."""
    url = f"{API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 5 * 2 ** i
        except urllib.error.URLError:
            if i == attempts - 1:
                raise
            wait = 5 * 2 ** i
        print(f"nouvelle tentative dans {wait} s…", file=sys.stderr)
        time.sleep(min(wait, 120))


def fetch():
    parse = api_get({
        "action": "parse", "page": PAGE, "prop": "text|revid",
        "format": "json", "formatversion": "2", "redirects": "1", "maxlag": "5",
    })["parse"]
    revid = parse.get("revid")
    ts = None
    try:
        q = api_get({"action": "query", "prop": "revisions", "revids": revid,
                     "rvprop": "timestamp", "format": "json", "formatversion": "2"}, attempts=2)
        ts = q["query"]["pages"][0]["revisions"][0]["timestamp"]
    except Exception as e:  # l'horodatage est un bonus
        print(f"avertissement : horodatage de révision indisponible ({e})", file=sys.stderr)
    return parse["text"], revid, ts


def write_csv(polls, duels):
    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["tour", "sondage", "institut", "debut", "fin", "echantillon",
                    "hypothese", "candidat", "score"])
        for p in polls:
            for i, h in enumerate(p["hypotheses"], 1):
                for k, v in h.items():
                    w.writerow([1, p["id"], p["institut"], p["debut"], p["fin"],
                                p["echantillon"] or "", i, k, v])
        for d in duels:
            for s in d["sondages"]:
                for k in ("a", "b"):
                    w.writerow([2, s["id"], s["institut"], s["debut"], s["fin"],
                                s["echantillon"] or "", f"{d['a']} / {d['b']}", d[k], s[k]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", help="fichier HTML (ou JSON de l'API) à utiliser au lieu de télécharger")
    ap.add_argument("--force", action="store_true", help="écrire même si le nombre de sondages chute")
    args = ap.parse_args()

    if args.html:
        raw = Path(args.html).read_text(encoding="utf-8")
        if raw.lstrip().startswith("{"):
            j = json.loads(raw)["parse"]
            raw, revid, ts = j["text"], j.get("revid"), None
        else:
            revid = ts = None
    else:
        raw, revid, ts = fetch()

    polls, duels, candidats, warnings = extract(raw)
    for w in warnings[:40]:
        print("avertissement :", w, file=sys.stderr)

    previous = None
    if OUT_JSON.exists():
        try:
            previous = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = None

    # Garde-fou : une page vandalisée ou restructurée ne doit pas vider le site.
    if previous and not args.force:
        before = len(previous.get("sondages", []))
        if before and len(polls) < 0.8 * before:
            print(f"refus : {len(polls)} sondages contre {before} auparavant", file=sys.stderr)
            return 2
    if len(polls) < 5:
        print("refus : trop peu de sondages extraits", file=sys.stderr)
        return 2

    payload = {
        "sondages": polls,
        "duels": duels,
        "candidats": candidats,
    }
    if previous and all(previous.get(k) == v for k, v in payload.items()):
        print(f"aucun changement ({len(polls)} sondages)")
        return 0

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    out = {
        "mis_a_jour": now,
        "source": {
            "nom": "Wikipédia — " + PAGE,
            "url": PAGE_URL,
            "revision": revid,
            "revision_date": ts,
            "licence": "CC BY-SA 4.0",
        },
        "election": {"premier_tour": "2027-04-18", "second_tour": "2027-05-02"},
        **payload,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    write_csv(polls, duels)
    n_h = sum(len(p["hypotheses"]) for p in polls)
    print(f"{len(polls)} sondages ({n_h} hypothèses), {len(duels)} duels, {len(candidats)} candidats")
    return 0


if __name__ == "__main__":
    sys.exit(main())
