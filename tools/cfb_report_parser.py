#!/usr/bin/env python3
"""
Parse a CFB27 "Season in Review" HTML report into structured JSON.

Usage:
    pip install beautifulsoup4 lxml
    python cfb_report_parser.py Massachusetts_2026_Season_in_Review.html out.json

Output sections: season, matches (with matched recaps), roster, stats, warnings.
Stats are full-season totals per player, the same shape the database stores
in player_season_stats (one row per player, season and category).
"""
import json
import re
import sys

from bs4 import BeautifulSoup


def num(text):
    """'1,797' -> 1797, '51.1%' -> 51.1, '4.3' -> 4.3, anything else stays text."""
    t = text.strip().replace(",", "").rstrip("%")
    try:
        return float(t) if "." in t else int(t)
    except ValueError:
        return text.strip()


def inline_md(node):
    """Convert a paragraph's inline markup to markdown."""
    out = []
    for child in node.children:
        if getattr(child, "name", None) in ("strong", "b"):
            out.append("**" + child.get_text() + "**")
        elif getattr(child, "name", None) in ("em", "i"):
            out.append("*" + child.get_text() + "*")
        elif getattr(child, "name", None):
            out.append(child.get_text())
        else:
            out.append(str(child))
    return re.sub(r"\s+", " ", "".join(out)).strip()


def prose_to_markdown(prose):
    parts = []
    for el in prose.find_all(["p", "h4", "h3", "blockquote"], recursive=False):
        text = inline_md(el)
        if not text:
            continue
        parts.append("## " + text if el.name in ("h3", "h4") else text)
    return "\n\n".join(parts)


STAT_CATEGORIES = [
    ("Cmp", "passing"),
    ("Rec", "receiving"),
    ("Tkl", "defense"),
    ("FGM", "kicking"),
    ("Punts", "punting"),
    ("KR", "returns"),
    ("Fum", "rushing"),
]


def stat_category(headers):
    for marker, name in STAT_CATEGORIES:
        if marker in headers:
            return name
    return None


def parse_stats(soup):
    stats = {}
    for table in soup.find_all("table"):
        if "results" in (table.get("class") or []):
            continue
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        category = stat_category(headers)
        if not category:
            continue
        rows = []
        for tr in table.find("tbody").find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) != len(headers):
                continue
            row = dict(zip(headers, cells))
            player, pos = row.pop("Player"), row.pop("Pos")
            games = num(row.pop("G")) if "G" in row else None
            rows.append({
                "player": player,
                "pos": pos,
                "games": games,
                "stats": {k: num(v) for k, v in row.items()},
            })
        stats[category] = rows
    return stats


def parse_roster(soup):
    roster = []
    section = soup.find(id="roster")
    if not section:
        return roster
    for panel in section.find_all("section", class_="panel"):
        side = panel.find("p", class_="panel-name").get_text(strip=True)
        for group in panel.find_all("div", class_="position-group"):
            group_name = group.find("p", class_="position-name")
            group_label = group_name.contents[0].strip() if group_name else None
            for man in group.find_all("div", class_="rosterman"):
                name_el = man.find("p", class_="rosterman-name")
                if name_el is None:  # empty placeholder entries in the report
                    continue
                captain = name_el.find("span", class_="is-captain") is not None
                marks = name_el.find_all("span", class_="mark")
                started = any("is-captain" not in (m.get("class") or []) for m in marks)
                for m in marks:
                    m.extract()
                name = name_el.get_text(strip=True)
                meta = man.find("p", class_="rosterman-meta").get_text(strip=True)
                m = re.match(r"#(\d+)\s*·\s*(\S+)\s*·\s*(\S+)\s*·\s*(\d+)\s*OVR", meta)
                roster.append({
                    "player": name,
                    "side": side,
                    "group": group_label,
                    "jersey": int(m.group(1)) if m else None,
                    "pos": m.group(2) if m else None,
                    "class_year": m.group(3) if m else None,
                    "overall": int(m.group(4)) if m else None,
                    "started": started,
                    "captain": captain,
                })
    return roster


def parse_recap(report_row):
    story = report_row.find("div", class_="story-body")
    if not story:
        return None
    title = story.find("h3")
    prose = story.find("div", class_="story-prose")
    header = None
    first_strong = prose.find("strong") if prose else None
    if first_strong:
        m = re.match(r"^(.+?)\s+(\d+),\s+(.+?)\s+(\d+)$", first_strong.get_text(strip=True))
        if m:
            header = {"a": m.group(1), "a_score": int(m.group(2)),
                      "b": m.group(3), "b_score": int(m.group(4))}
    return {
        "title": title.get_text(strip=True) if title else None,
        "score_header": header,
        "body_md": prose_to_markdown(prose) if prose else "",
    }


def parse_matches(soup, team, warnings):
    table = soup.find("table", class_="results")
    matches, pending = [], []
    for tr in table.find("tbody").find_all("tr"):
        classes = tr.get("class") or []
        if "report-row" in classes:
            pending.append((matches[-1] if matches else None, parse_recap(tr)))
            continue
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(tds) < 4:
            continue
        opponent = tds[1]
        pf, pa = (int(x) for x in tds[3].split("-"))
        matches.append({
            "week": int(tds[0]),
            "opponent": re.sub(r"^(at|vs)\s+", "", opponent),
            "home_away": "away" if opponent.startswith("at ") else "home",
            "result": tds[2],
            "points_for": pf,
            "points_against": pa,
            "recap": None,
        })
    # Attach each recap to the game its own score line describes. Fall back to
    # the row it sits under only when the recap has no readable score line.
    for adjacent, recap in pending:
        if not recap:
            continue
        target = None
        hdr = recap["score_header"]
        if hdr:
            ours = hdr["a_score"] if team.lower() in hdr["a"].lower() else hdr["b_score"]
            theirs = hdr["b_score"] if ours == hdr["a_score"] else hdr["a_score"]
            for g in matches:
                if g["points_for"] == ours and g["points_against"] == theirs:
                    target = g
                    break
        if target is None:
            target = adjacent
            recap["match_confidence"] = "adjacent-row"
        else:
            recap["match_confidence"] = "score-line"
            if adjacent is not None and adjacent is not target:
                warnings.append(
                    f"Week {adjacent['week']} ({adjacent['opponent']}) links to a recap "
                    f"for Week {target['week']} ({target['opponent']}); attached by score line."
                )
        if target["recap"] is None:
            target["recap"] = recap
    return matches


def parse_report(path):
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "lxml")
    title = soup.title.get_text(strip=True)
    m = re.match(r"(\d{4})\s+(.+?)\s+[—-]\s+Season in Review", title)
    year, team = (int(m.group(1)), m.group(2)) if m else (None, None)

    season = {"year": year, "team": team}
    numbers = soup.find(id="numbers")
    if numbers:
        text = numbers.get_text(" ", strip=True)
        rec = re.search(r"(\d+-\d+)\s+Overall\s+(\d+-\d+)\s+Conference", text)
        if rec:
            season["record_overall"], season["record_conference"] = rec.groups()
        for label, key in [("Points for", "points_for"), ("Points against", "points_against")]:
            hit = re.search(r"(\d+)\s+" + label, text)
            if hit:
                season[key] = int(hit.group(1))

    warnings = []
    return {
        "season": season,
        "matches": parse_matches(soup, team or "", warnings),
        "roster": parse_roster(soup),
        "stats": parse_stats(soup),
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: cfb_report_parser.py report.html out.json")
    data = parse_report(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"{data['season'].get('year')} {data['season'].get('team')}: "
          f"{len(data['matches'])} games, "
          f"{sum(1 for g in data['matches'] if g['recap'])} recaps, "
          f"{len(data['roster'])} roster players, "
          f"{sum(len(v) for v in data['stats'].values())} stat lines")
    for w in data["warnings"]:
        print("warning:", w)
