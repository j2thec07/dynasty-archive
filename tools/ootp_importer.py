#!/usr/bin/env python3
"""
Convert an OOTP CSV database export into Dynasty Desk import files.

Usage:
    pip install pandas
    python ootp_importer.py CSV_DIR OUT_DIR [--start-year 1997] [--team-id 17]

CSV_DIR is the folder holding the exported csv files. Only the tables below
are read, so the rest of the (very large) export is never touched:
    teams, leagues, players, players_career_batting_stats,
    players_career_pitching_stats, team_history_record, team_record, games

Writes to OUT_DIR:
    dynasty.json       the dynasty (team, league, start year, current year)
    seasons.jsonl      one line per year, with your team's record
    players.jsonl      one line per player (OOTP player_id kept as external_id)
    season_stats.jsonl one line per player, year, team, stint, level and split
    matches.jsonl      your team's regular-season games since the start year
    summary.json       counts and sanity checks

What gets imported
    * All major-league (level 1) batting and pitching history, from the
      first year in the export, so career totals reach back to the beginning.
    * Minor-league rows only from the start year onward.
    * Overall-season rows (split 1 = regular season) and postseason rows
      (split 21 = playoffs, as far as I can tell). The left/right-handed
      split rows are skipped.
    * Re-run the importer after each new export. Seasons are keyed by year, so
      loading the result again replaces the in-progress season.
"""
import argparse
import json
import os

import pandas as pd

POS = {1: "P", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "LF", 8: "CF", 9: "RF", 10: "DH"}
ROLE = {11: "SP", 12: "RP", 13: "CL"}
SPLITS = {1: "regular", 21: "playoffs"}

BAT_COLS = ["g", "gs", "pa", "ab", "h", "d", "t", "hr", "r", "rbi", "bb", "ibb", "k",
            "hp", "sf", "sh", "gdp", "sb", "cs", "war"]
PIT_COLS = ["g", "gs", "w", "l", "s", "hld", "qs", "cg", "sho", "outs", "ha", "hra",
            "r", "er", "bb", "k", "bf", "hp", "wp", "bk", "war"]


def read(csv_dir, name, cols=None):
    return pd.read_csv(os.path.join(csv_dir, name + ".csv"), usecols=cols, low_memory=False)


def clean(value):
    """JSON-safe plain Python value."""
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float):
        return round(value, 3)
    return value


def write_jsonl(path, rows):
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n


def ratio(num, den, places=3):
    return round(num / den, places) if den else None


def batting_rows(df, team_names):
    for r in df.itertuples(index=False):
        ab, h, d, t, hr = r.ab, r.h, r.d, r.t, r.hr
        tb = h + d + 2 * t + 3 * hr
        obp_den = ab + r.bb + r.hp + r.sf
        stats = {c: clean(getattr(r, c)) for c in BAT_COLS}
        stats.update({
            "avg": ratio(h, ab),
            "obp": ratio(h + r.bb + r.hp, obp_den),
            "slg": ratio(tb, ab),
        })
        stats["ops"] = (round(stats["obp"] + stats["slg"], 3)
                        if stats["obp"] is not None and stats["slg"] is not None else None)
        yield {
            "external_id": str(r.player_id), "year": int(r.year), "category": "batting",
            "team_id": int(r.team_id), "team": team_names.get(int(r.team_id), ""),
            "level": int(r.level_id), "stint": int(r.stint), "split": SPLITS[int(r.split_id)],
            "games": int(r.g), "stats": stats,
        }


def pitching_rows(df, team_names):
    for r in df.itertuples(index=False):
        outs = int(r.outs)
        stats = {c: clean(getattr(r, c)) for c in PIT_COLS}
        stats["ip"] = f"{outs // 3}.{outs % 3}"
        stats["era"] = ratio(r.er * 27, outs, 2)
        stats["whip"] = ratio((r.ha + r.bb) * 3, outs, 2)
        yield {
            "external_id": str(r.player_id), "year": int(r.year), "category": "pitching",
            "team_id": int(r.team_id), "team": team_names.get(int(r.team_id), ""),
            "level": int(r.level_id), "stint": int(r.stint), "split": SPLITS[int(r.split_id)],
            "games": int(r.g), "stats": stats,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--start-year", type=int, help="first season you actually played "
                    "(default: the league's current/start season)")
    ap.add_argument("--team-id", type=int, help="your team (default: the human-controlled team)")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    teams = read(args.csv_dir, "teams", ["team_id", "name", "nickname", "human_team", "league_id"])
    team_names = {int(r.team_id): f"{r.name} {r.nickname}" for r in teams.itertuples()}
    if args.team_id:
        mine = teams[teams.team_id == args.team_id].iloc[0]
    else:
        mine = teams[teams.human_team == 1].iloc[0]
    my_id, my_league = int(mine.team_id), int(mine.league_id)

    leagues = read(args.csv_dir, "leagues", ["league_id", "name", "season_year"])
    league = leagues[leagues.league_id == my_league].iloc[0]
    current_year = int(league.season_year)
    start_year = args.start_year or current_year

    # ---- stats -------------------------------------------------------------
    keep = lambda df: df[df.split_id.isin(SPLITS) & ((df.level_id == 1) | (df.year >= start_year))]
    bat = keep(read(args.csv_dir, "players_career_batting_stats",
                    ["player_id", "year", "team_id", "level_id", "split_id", "stint"] + BAT_COLS[:-1] + ["war"]))
    pit = keep(read(args.csv_dir, "players_career_pitching_stats",
                    ["player_id", "year", "team_id", "level_id", "split_id", "stint"] + PIT_COLS[:-1] + ["war"]))
    n_stats = write_jsonl(os.path.join(args.out_dir, "season_stats.jsonl"),
                          list(batting_rows(bat, team_names)) + list(pitching_rows(pit, team_names)))

    # ---- players -----------------------------------------------------------
    ids = set(bat.player_id) | set(pit.player_id)
    pl = read(args.csv_dir, "players", ["player_id", "first_name", "last_name", "position", "role",
                                        "bats", "throws", "date_of_birth", "retired"])
    pl = pl[pl.player_id.isin(ids)]

    def players():
        for r in pl.itertuples(index=False):
            yield {
                "external_id": str(r.player_id),
                "full_name": f"{r.first_name} {r.last_name}".strip(),
                "primary_pos": ROLE.get(r.role) or POS.get(r.position),
                "bats": {1: "R", 2: "L", 3: "S"}.get(r.bats),
                "throws": {1: "R", 2: "L"}.get(r.throws),
                "date_of_birth": clean(r.date_of_birth),
                "retired": bool(r.retired),
            }
    n_players = write_jsonl(os.path.join(args.out_dir, "players.jsonl"), players())

    # ---- seasons (with your team's record) ---------------------------------
    hist = read(args.csv_dir, "team_history_record", ["team_id", "year", "g", "w", "l", "pos"])
    hist = hist[hist.team_id == my_id]
    cur = read(args.csv_dir, "team_record", ["team_id", "g", "w", "l", "pos"])
    cur = cur[cur.team_id == my_id]
    records = {int(r.year): {"g": int(r.g), "w": int(r.w), "l": int(r.l), "finish": int(r.pos)}
               for r in hist.itertuples()}
    for r in cur.itertuples():
        records[current_year] = {"g": int(r.g), "w": int(r.w), "l": int(r.l), "finish": int(r.pos)}
    years = sorted(set(bat.year) | set(pit.year) | set(records))

    def seasons():
        for y in years:
            rec = records.get(y)
            yield {"year": y, "in_dynasty": y >= start_year, "in_progress": y == current_year,
                   "record_overall": f"{rec['w']}-{rec['l']}" if rec else None,
                   "summary": {"team_record": rec} if rec else {}}
    n_seasons = write_jsonl(os.path.join(args.out_dir, "seasons.jsonl"), seasons())

    # ---- matches: your regular-season games since the start year ----------
    g = read(args.csv_dir, "games", ["game_id", "league_id", "home_team", "away_team", "date",
                                     "game_type", "played", "runs0", "runs1"])
    g = g[(g.played == 1) & (g.game_type == 0) & ((g.home_team == my_id) | (g.away_team == my_id))]
    g = g.assign(d=pd.to_datetime(g.date, format="%Y-%m-%d", errors="coerce"))
    g = g[g.d.dt.year >= start_year].sort_values("d")
    wins = losses = 0

    def matches():
        nonlocal wins, losses
        for r in g.itertuples(index=False):
            home = int(r.home_team) == my_id
            # runs0 is the away side, runs1 the home side
            pf, pa = (int(r.runs1), int(r.runs0)) if home else (int(r.runs0), int(r.runs1))
            res = "W" if pf > pa else "L" if pf < pa else "T"
            wins += res == "W"
            losses += res == "L"
            opp = int(r.away_team if home else r.home_team)
            yield {"external_id": str(r.game_id), "year": int(r.d.year), "played_on": r.d.strftime("%Y-%m-%d"),
                   "opponent": team_names.get(opp), "home_away": "home" if home else "away",
                   "result": res, "points_for": pf, "points_against": pa}
    n_matches = write_jsonl(os.path.join(args.out_dir, "matches.jsonl"), matches())

    # ---- dynasty + summary -------------------------------------------------
    dynasty = {"game": "ootp", "name": team_names[my_id], "league": league["name"],
               "external_team_id": my_id, "start_year": start_year, "current_year": current_year,
               "status": "current"}
    json.dump(dynasty, open(os.path.join(args.out_dir, "dynasty.json"), "w"), indent=2)

    check = records.get(current_year)
    summary = {
        "dynasty": dynasty,
        "counts": {"players": n_players, "season_stat_rows": n_stats, "seasons": n_seasons,
                   "matches": n_matches, "first_year": min(years), "last_year": max(years)},
        "sanity": {"matches_record": f"{wins}-{losses}",
                   "team_record_table": f"{check['w']}-{check['l']}" if check else None},
    }
    json.dump(summary, open(os.path.join(args.out_dir, "summary.json"), "w"), indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
