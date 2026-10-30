#!/usr/bin/env python3
"""
Build the Dynasty Archive data files.

    python tools/build.py

Reads dynasties.json (the list of your dynasties), pulls stats from the
files in imports/, merges in any markdown stories from content/<slug>/, and
writes everything the website needs to site/data/.

Supported sources
    cfb   "source": "imports/umass/*.html"   one CFB27 "Season in Review" report per season
    ootp  "source": "imports/reds/csv"       the folder of OOTP csv files

A dynasty with no "source" still shows up on the site, just without stats.
"""
import glob
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "site" / "data"
sys.path.insert(0, str(HERE))

GAME_LABEL = {"cfb": "College Football 27", "ootp": "Out of the Park Baseball 27"}
GAME_GROUP = {"cfb": "College Football", "ootp": "Baseball"}


# ---------------------------------------------------------------- helpers
def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def ordinal(n):
    n = int(n)
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def fmt_num(v):
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else f"{v:.1f}"
    return "" if v is None else str(v)


def rate(n, d, places=3):
    return round(n / d, places) if d else None


def dot3(v):
    if v is None:
        return "—"
    s = f"{v:.3f}"
    return s[1:] if s.startswith("0") else s


def excerpt(md, limit=280):
    for para in md.split("\n\n"):
        t = re.sub(r"\*+", "", para).strip()
        if para.startswith("**") or para.startswith("#") or len(t) < 60:
            continue
        if len(t) <= limit:
            return t
        cut = t[:limit]
        i = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        return cut[: i + 1] if i > 120 else cut.rsplit(" ", 1)[0] + "…"
    return ""


class Players:
    """One record per person per dynasty, with every stat row we know about."""

    def __init__(self, fixed_ids=False):
        self.by, self.next, self.fixed = {}, 1, fixed_ids

    def get(self, key, name, pos=None, pid=None):
        if key not in self.by:
            if self.fixed:
                i = pid
            else:
                i, self.next = self.next, self.next + 1
            self.by[key] = {"id": i, "n": name, "pos": pos, "bio": {}, "rows": []}
        p = self.by[key]
        if pos and not p["pos"]:
            p["pos"] = pos
        return p


def write_players(slug, players, cats, teams):
    """Index file for search + shards of 250 players for the detail pages."""
    plist = sorted(players.by.values(), key=lambda p: p["id"])
    base = OUT / slug / "players"
    shutil.rmtree(base, ignore_errors=True)
    index = []
    shards = {}
    for p in plist:
        years = [r[0] for r in p["rows"]] or [y for y in p["bio"].get("seasons", {})]
        years = [int(y) for y in years]
        index.append([p["id"], p["n"], p["pos"] or "", min(years) if years else 0, max(years) if years else 0])
        shards.setdefault(p["id"] // 250, {})[p["id"]] = {"n": p["n"], "pos": p["pos"], "bio": p["bio"],
                                                            "rows": sorted(p["rows"], key=lambda r: (r[0], r[3], r[2]))}
    write_json(base / "index.json", index)
    for k, v in shards.items():
        write_json(base / f"s{k}.json", v)
    return len(plist)


# ---------------------------------------------------------------- articles
def load_markdown(slug):
    out = []
    for f in sorted((ROOT / "content" / slug).glob("*.md")):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8")
        meta, body = {}, text
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
        if m:
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip().lower()] = v.strip().strip('"')
            body = m.group(2)
        title = meta.get("title")
        if not title:
            h = re.match(r"\s*#\s+(.+)", body)
            title = h.group(1).strip() if h else f.stem
            body = re.sub(r"^\s*#\s+.+\n", "", body, count=1)
        out.append({
            "id": f"{slug}-{f.stem}", "season": int(meta["season"]) if meta.get("season", "").isdigit() else None,
            "week": meta.get("week"), "date": meta.get("date", ""), "kind": meta.get("kind", "recap"),
            "title": title, "dek": meta.get("dek") or excerpt(body), "body": body.strip(), "source": "md",
        })
    return out


# ---------------------------------------------------------------- CFB
CFB_NO_SUM = {"Pct", "Y/A", "Avg", "Lng", "Net", "FG%", "XP%", "KR avg", "PR avg"}
CLASS = {"Freshman": "FR", "Sophomore": "SO", "Junior": "JR", "Senior": "SR"}


def build_cfb(cfg, players):
    from bs4 import BeautifulSoup
    from cfb_report_parser import parse_report

    files = sorted(glob.glob(str(ROOT / cfg["source"])))
    cats, seasons, articles = {}, {}, []
    short = cfg["short"]
    for path in files:
        d = parse_report(path)
        year = d["season"]["year"]
        soup = BeautifulSoup(Path(path).read_text(encoding="utf-8"), "lxml")
        print(f"  {cfg['slug']}: {Path(path).name} -> {year}")

        # roster
        roster = []
        for r in sorted(d["roster"], key=lambda r: -(r["overall"] or 0)):
            p = players.get(r["player"].lower(), r["player"], r["pos"])
            cls = CLASS.get(r["class_year"] or "", (r["class_year"] or "")[:2].upper())
            p["bio"].setdefault("seasons", {})[str(year)] = {"j": r["jersey"], "c": cls, "o": r["overall"]}
            roster.append([r["jersey"], r["pos"], [r["player"], p["id"]], cls, r["overall"]])

        # stats tables and player rows
        stats, leaders_src = {}, {}
        for cat, rows in d["stats"].items():
            keys = cats.setdefault(cat, [])
            for r in rows:
                for k in r["stats"]:
                    if k not in keys:
                        keys.append(k)
            for r in rows:
                p = players.get(r["player"].lower(), r["player"], r["pos"])
                p["rows"].append([year, 0, 1, 0, cat, r["games"], [r["stats"].get(k) for k in keys]])
            tkeys = list(rows[0]["stats"].keys())
            sort_key = {"passing": "Yds", "rushing": "Yds", "receiving": "Yds", "defense": "Tkl"}.get(cat)
            ordered = sorted(rows, key=lambda r: -(r["stats"].get(sort_key) or 0)) if sort_key else rows
            stats[cat] = {"h": ["Player", "Pos", "G"] + tkeys,
                          "r": [[[r["player"], players.by[r["player"].lower()]["id"]], r["pos"], fmt_num(r["games"])] +
                                [fmt_num(r["stats"].get(k)) for k in tkeys] for r in ordered]}
            leaders_src[cat] = ordered

        jersey = {r["player"].lower(): r["jersey"] for r in d["roster"]}

        def card(label, cat, key, show, src=None):
            rows = leaders_src.get(cat)
            if not rows:
                return None
            top = max(rows, key=lambda r: r["stats"].get(key) or 0)
            return [label, top["player"], top["pos"], jersey.get(top["player"].lower(), ""),
                    [[k, fmt_num(top["stats"].get(k))] for k in show], players.by[top["player"].lower()]["id"]]

        leaders = {
            "Offense": [c for c in [card("Passing", "passing", "Yds", ["Cmp", "Att", "Yds", "TD", "INT"]),
                                    card("Rushing", "rushing", "Yds", ["Att", "Yds", "Avg", "TD", "Lng"]),
                                    card("Receiving", "receiving", "Yds", ["Rec", "Yds", "Avg", "TD", "Lng"])] if c],
            "Defense": [c for c in [card("Tackles", "defense", "Tkl", ["Tkl", "TFL", "Sck", "INT", "PD"]),
                                    card("Sacks", "defense", "Sck", ["Tkl", "TFL", "Sck", "INT", "PD"]),
                                    card("Interceptions", "defense", "INT", ["Tkl", "TFL", "Sck", "INT", "PD"])] if c],
        }

        # schedule (with byes)
        sched, prev = [], None
        for g in sorted(d["matches"], key=lambda g: g["week"]):
            if prev and g["week"] - prev == 2:
                sched.append([prev + 1, "", "Bye", "", None, None, None])
            sched.append([g["week"], "", g["opponent"], g["home_away"], g["result"], g["points_for"], g["points_against"]])
            prev = g["week"]

        # numbers, staff
        tiles = {}
        for t in soup.select("#numbers .tile"):
            v, l = t.find(class_="tile-value"), t.find(class_="tile-label")
            if v and l:
                tiles[l.get_text(strip=True)] = v.get_text(strip=True)
        ranks = [[k, tiles[k]] for k in ("CFP", "AP", "Coaches", "Recruiting class") if k in tiles]
        staff = []
        hc = soup.select_one("#staff .headcoach-name")
        if hc:
            staff.append(["Head Coach", hc.get_text(strip=True)])
        for li in soup.select("#staff ul.plain li"):
            n, m = li.select_one(".plain-name"), li.select_one(".plain-meta")
            if n and m:
                staff.append([m.get_text(strip=True), n.get_text(strip=True)])

        s, n = d["season"], max(len(d["matches"]), 1)
        diff = (s["points_for"] - s["points_against"]) / n
        coord = {r: nme for r, nme in staff}
        meta = [GAME_LABEL["cfb"], f"{year} Season"]
        meta += [f"Head Coach: {coord['Head Coach']}"] if "Head Coach" in coord else []
        meta += [f"OC: {coord['Offensive Coordinator']}"] if "Offensive Coordinator" in coord else []
        meta += [f"DC: {coord['Defensive Coordinator']}"] if "Defensive Coordinator" in coord else []
        seasons[year] = {
            "year": year, "in_progress": False, "record": s["record_overall"], "conf": s["record_conference"],
            "hero": {"meta": meta, "trio": [[s["record_overall"], "Overall"], [s["record_conference"], "Conference"]] +
                     ([[ranks[0][1], "CFP Rank"]] if ranks else [])},
            "sched": sched,
            "teamStats": [[f"{s['points_for'] / n:.1f}", "PPG"], [f"{s['points_against'] / n:.1f}", "PAPG"],
                          [f"{diff:+.1f}".replace("-", "−"), "Margin"]],
            "ranks": ranks, "staff": staff, "leaders": leaders,
            "roster": {"h": ["#", "Pos", "Name", "Class", "Ovr"], "r": roster}, "stats": stats,
        }
        for g in d["matches"]:
            if g["recap"]:
                articles.append({"id": f"{cfg['slug']}-{year}-w{g['week']}", "season": year, "week": g["week"], "date": "",
                                 "kind": "recap", "title": g["recap"]["title"], "dek": excerpt(g["recap"]["body_md"]),
                                 "body": g["recap"]["body_md"], "source": "report"})
    schema_cats = {}
    for cat, keys in cats.items():
        schema_cats[cat] = {"label": cat.title(), "store": keys, "cols": [[k, k] for k in keys],
                            "sum": [k for k in keys if k not in CFB_NO_SUM], "derive": None}
    return seasons, articles, {"cats": schema_cats, "teams": [short]}


# ---------------------------------------------------------------- OOTP
BAT_STORE = ["g", "gs", "pa", "ab", "h", "d", "t", "hr", "r", "rbi", "bb", "ibb", "k", "hp", "sf", "sh", "gdp", "sb", "cs", "war"]
PIT_STORE = ["g", "gs", "w", "l", "s", "hld", "qs", "cg", "sho", "outs", "ha", "hra", "r", "er", "bb", "k", "bf", "hp", "wp", "bk", "war"]


def bat_line(o):
    ab, h = o.get("ab") or 0, o.get("h") or 0
    tb = h + (o.get("d") or 0) + 2 * (o.get("t") or 0) + 3 * (o.get("hr") or 0)
    obp = rate(h + (o.get("bb") or 0) + (o.get("hp") or 0), ab + (o.get("bb") or 0) + (o.get("hp") or 0) + (o.get("sf") or 0))
    slg = rate(tb, ab)
    return {"avg": rate(h, ab), "obp": obp, "slg": slg, "ops": round(obp + slg, 3) if obp is not None and slg is not None else None}


def pit_line(o):
    outs = o.get("outs") or 0
    return {"ip": f"{outs // 3}.{outs % 3}", "era": rate((o.get("er") or 0) * 27, outs, 2),
            "whip": rate(((o.get("ha") or 0) + (o.get("bb") or 0)) * 3, outs, 2)}


def clean_name(first, last):
    name = f"{first} {last}".replace("\\", "").replace('""', '"')
    if name.count('"') == 1:          # the export dropped the opening quote of a nickname
        return re.sub(r'(\S+)"', "“\\1”", name).strip()
    return re.sub(r'"(.*?)"', "“\\1”", name).strip()


def build_ootp(cfg, players):
    import pandas as pd

    csv_dir = ROOT / cfg["source"]
    tmp = Path(tempfile.mkdtemp(prefix="ootp_"))
    cmd = [sys.executable, str(HERE / "ootp_importer.py"), str(csv_dir), str(tmp), "--start-year", str(cfg["start_year"])]
    if cfg.get("team_id"):
        cmd += ["--team-id", str(cfg["team_id"])]
    print("  running OOTP importer…")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)

    dyn = json.loads((tmp / "dynasty.json").read_text())
    my_id, team_name, start, current = dyn["external_team_id"], dyn["name"], dyn["start_year"], dyn["current_year"]
    jersey = {int(r.player_id): r.uniform_number for r in
              pd.read_csv(csv_dir / "players.csv", usecols=["player_id", "uniform_number"], low_memory=False).itertuples()}
    mgr = pd.read_csv(csv_dir / "human_managers.csv", usecols=["first_name", "last_name", "team_id"])
    mgr = mgr[mgr.team_id == my_id]
    manager = clean_name(mgr.iloc[0].first_name, mgr.iloc[0].last_name) if len(mgr) else None

    teams, team_idx = [], {}
    pinfo = {}
    for line in (tmp / "players.jsonl").read_text(encoding="utf-8").splitlines():
        p = json.loads(line)
        rec = players.get(p["external_id"], p["full_name"], p["primary_pos"], int(p["external_id"]))
        rec["bio"] = {k: v for k, v in {"bats": p.get("bats"), "throws": p.get("throws"), "dob": p.get("date_of_birth"),
                                        "retired": p.get("retired")}.items() if v not in (None, "", False)}
        pinfo[int(p["external_id"])] = p

    team_rows = {"batting": {}, "pitching": {}}   # (year) -> pid -> accumulated counting stats for my team
    for line in (tmp / "season_stats.jsonl").read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if r["team"] not in team_idx:
            team_idx[r["team"]] = len(teams)
            teams.append(r["team"])
        cat, store = r["category"], (BAT_STORE if r["category"] == "batting" else PIT_STORE)
        rec = players.by[r["external_id"]]
        rec["rows"].append([r["year"], team_idx[r["team"]], r["level"], 0 if r["split"] == "regular" else 1, cat,
                            r["games"], [r["stats"].get(k) for k in store]])
        if r["team_id"] == my_id and r["level"] == 1 and r["split"] == "regular":
            acc = team_rows[cat].setdefault(r["year"], {}).setdefault(int(r["external_id"]), {})
            for k in store:
                acc[k] = (acc.get(k) or 0) + (r["stats"].get(k) or 0)

    seasons_meta = {}
    for line in (tmp / "seasons.jsonl").read_text().splitlines():
        s = json.loads(line)
        seasons_meta[s["year"]] = s
    matches = {}
    for line in (tmp / "matches.jsonl").read_text().splitlines():
        m = json.loads(line)
        matches.setdefault(m["year"], []).append(m)

    seasons = {}
    for year, ms in sorted(matches.items()):
        meta_s = seasons_meta.get(year, {})
        tr = (meta_s.get("summary") or {}).get("team_record") or {}
        w, l = tr.get("w", sum(m["result"] == "W" for m in ms)), tr.get("l", sum(m["result"] == "L" for m in ms))
        n = len(ms)
        rs, ra = sum(m["points_for"] for m in ms), sum(m["points_against"] for m in ms)
        bat, pit = team_rows["batting"].get(year, {}), team_rows["pitching"].get(year, {})

        def name(pid):
            return players.by[str(pid)]["n"]

        def pos(pid):
            return players.by[str(pid)]["pos"] or ""

        brows = sorted(bat.items(), key=lambda kv: -kv[1]["pa"])
        prows = sorted(pit.items(), key=lambda kv: -kv[1]["outs"])
        stats = {
            "batting": {"h": ["Player", "Pos", "G", "AB", "H", "HR", "RBI", "BB", "K", "AVG", "OBP", "SLG", "OPS", "WAR"],
                        "r": [[[name(pid), pid], pos(pid), o["g"], o["ab"], o["h"], o["hr"], o["rbi"], o["bb"], o["k"],
                               dot3(bat_line(o)["avg"]), dot3(bat_line(o)["obp"]), dot3(bat_line(o)["slg"]),
                               dot3(bat_line(o)["ops"]), f"{o['war']:.1f}"] for pid, o in brows]},
            "pitching": {"h": ["Player", "Pos", "G", "GS", "W", "L", "SV", "IP", "K", "BB", "ERA", "WHIP", "WAR"],
                         "r": [[[name(pid), pid], pos(pid), o["g"], o["gs"], o["w"], o["l"], o["s"], pit_line(o)["ip"], o["k"],
                                o["bb"], f"{pit_line(o)['era']:.2f}" if pit_line(o)["era"] is not None else "—",
                                f"{pit_line(o)['whip']:.2f}" if pit_line(o)["whip"] is not None else "—", f"{o['war']:.1f}"]
                               for pid, o in prows]},
        }
        qual_pa, qual_outs = 2.5 * n, 2.4 * n

        def bcard(label, key, qual=False):
            pool = [(pid, o) for pid, o in bat.items() if not qual or o["pa"] >= qual_pa]
            if not pool:
                return None
            pid, o = (max(pool, key=lambda kv: bat_line(kv[1])["avg"] or 0) if key == "avg"
                      else max(pool, key=lambda kv: kv[1][key]))
            bl = bat_line(o)
            return [label, name(pid), pos(pid), jersey.get(pid, ""),
                    [["AVG", dot3(bl["avg"])], ["HR", o["hr"]], ["RBI", o["rbi"]], ["OPS", dot3(bl["ops"])], ["WAR", f"{o['war']:.1f}"]], pid]

        def pcard(label, key, qual=False):
            pool = [(pid, o) for pid, o in pit.items() if not qual or o["outs"] >= qual_outs]
            if not pool:
                return None
            pid, o = (min(pool, key=lambda kv: pit_line(kv[1])["era"] if pit_line(kv[1])["era"] is not None else 99)
                      if key == "era" else max(pool, key=lambda kv: kv[1][key]))
            pl = pit_line(o)
            return [label, name(pid), pos(pid), jersey.get(pid, ""),
                    [["W-L", f"{o['w']}-{o['l']}"], ["ERA", f"{pl['era']:.2f}" if pl["era"] is not None else "—"], ["IP", pl["ip"]],
                     ["K", o["k"]], ["WAR", f"{o['war']:.1f}"]], pid]

        leaders = {"Batting": [c for c in [bcard("Batting Average", "avg", True), bcard("Home Runs", "hr"), bcard("RBI", "rbi")] if c],
                   "Pitching": [c for c in [pcard("Wins", "w"), pcard("Strikeouts", "k"), pcard("ERA", "era", True)] if c]}

        roster_all = [(pid, o["war"], o["g"], "bat") for pid, o in bat.items()] + [(pid, o["war"], o["g"], "pit") for pid, o in pit.items()]
        best = {}
        for pid, war, g, kind in roster_all:      # one line per player; two-way players keep the bigger WAR
            if pid not in best or war > best[pid][0]:
                best[pid] = (war, g)
        bt = {1: "R", 2: "L", 3: "S"}
        roster = []
        for pid, (war, g) in sorted(best.items(), key=lambda kv: -kv[1][0]):
            info = players.by[str(pid)]["bio"]
            roster.append([jersey.get(pid, ""), pos(pid), [name(pid), pid], f"{info.get('bats', '')}/{info.get('throws', '')}", g, f"{war:.1f}"])

        gp = tr.get("g", n)
        seasons[year] = {
            "year": year, "in_progress": bool(meta_s.get("in_progress")), "record": f"{w}-{l}", "conf": "",
            "hero": {"meta": [GAME_LABEL["ootp"], f"{year} Season" + (" (in progress)" if meta_s.get("in_progress") else ""), dyn["league"]] +
                            ([f"Manager: {manager}"] if manager else []),
                     "trio": [[f"{w}-{l}", "Record"], [ordinal(tr["finish"]) if tr.get("finish") else "—", "Division"],
                              [dot3(rate(w, w + l)), "Win %"]]},
            "sched": [[i + 1, m["played_on"], m["opponent"], m["home_away"], m["result"], m["points_for"], m["points_against"]]
                      for i, m in enumerate(ms)],
            "teamStats": [[f"{rs / n:.2f}", "Runs / G"], [f"{ra / n:.2f}", "Allowed / G"], [f"{rs - ra:+d}".replace("-", "−"), "Run Diff"]],
            "ranks": [["Games played", str(gp)], ["Division finish", ordinal(tr["finish"]) if tr.get("finish") else "—"]],
            "staff": [["Manager", manager]] if manager else [],
            "leaders": leaders,
            "roster": {"h": ["#", "Pos", "Name", "B/T", "G", "WAR"], "r": roster},
            "stats": stats,
        }
    schema = {"teams": teams, "cats": {
        "batting": {"label": "Batting", "store": BAT_STORE,
                    "cols": [["g", "G"], ["ab", "AB"], ["h", "H"], ["hr", "HR"], ["rbi", "RBI"], ["bb", "BB"], ["k", "K"], ["sb", "SB"],
                             ["avg", "AVG"], ["obp", "OBP"], ["slg", "SLG"], ["ops", "OPS"], ["war", "WAR"]],
                    "sum": BAT_STORE, "derive": "bat"},
        "pitching": {"label": "Pitching", "store": PIT_STORE,
                     "cols": [["g", "G"], ["gs", "GS"], ["w", "W"], ["l", "L"], ["s", "SV"], ["ip", "IP"], ["k", "K"], ["bb", "BB"],
                              ["era", "ERA"], ["whip", "WHIP"], ["war", "WAR"]],
                     "sum": PIT_STORE, "derive": "pit"}}}
    shutil.rmtree(tmp, ignore_errors=True)
    return seasons, [], schema


# ---------------------------------------------------------------- main
def main():
    config = json.loads((ROOT / "dynasties.json").read_text(encoding="utf-8"))
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    listing = []
    for cfg in config:
        slug, game = cfg["slug"], cfg["game"]
        print(f"{slug} ({game})")
        seasons, articles, schema, n_players = {}, [], {"cats": {}, "teams": []}, 0
        src = cfg.get("source")
        has_source = bool(src) and (glob.glob(str(ROOT / src)) if game == "cfb" else (ROOT / src).exists())
        if has_source:
            players = Players(fixed_ids=(game == "ootp"))
            seasons, articles, schema = (build_cfb if game == "cfb" else build_ootp)(cfg, players)
            schema["start_year"] = cfg["start_year"]
            n_players = write_players(slug, players, schema["cats"], schema["teams"])
        elif src:
            print(f"  ! nothing found at {src}; listed without stats")
        known = {a["id"] for a in articles}
        articles += [a for a in load_markdown(slug) if a["id"] not in known]
        articles.sort(key=lambda a: ((a["season"] or 0), int(a["week"]) if str(a["week"] or "").isdigit() else 0, a["date"]))
        schema["start_year"] = cfg.get("start_year")
        write_json(OUT / slug / "schema.json", schema)
        write_json(OUT / slug / "articles.json", articles)
        for y, bundle in seasons.items():
            write_json(OUT / slug / f"season-{y}.json", bundle)
        latest = seasons[max(seasons)] if seasons else None
        listing.append({
            "slug": slug, "name": cfg["name"], "short": cfg.get("short", cfg["name"]), "full": cfg.get("full", cfg["name"]),
            "init": cfg.get("init", cfg["name"][:2].upper()), "game": game, "group": GAME_GROUP[game], "status": cfg.get("status", "current"),
            "p": cfg.get("p", "#2B3040"), "s": cfg.get("s", "#9AA0AE"), "start_year": cfg.get("start_year"),
            "seasons": sorted(seasons), "current_year": max(seasons) if seasons else None,
            "latest": {"year": latest["year"], "record": latest["record"]} if latest else None,
            "players": n_players, "articles": len(articles),
        })
        print(f"  {len(seasons)} season(s), {n_players} players, {len(articles)} stories")
    write_json(OUT / "dynasties.json", listing)
    print("done ->", OUT)


if __name__ == "__main__":
    main()
