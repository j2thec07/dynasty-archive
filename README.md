# Dynasty Archive

A static website for your dynasty stories and stats. It runs on GitHub Pages: no server, no database, no accounts besides GitHub.

```
site/        the website (HTML, CSS, JS) and site/data, which the build tool generates
tools/       build.py plus the CFB27 and OOTP importers
content/     your stories, one markdown file each, in content/<dynasty>/
imports/     your raw exports (not uploaded to GitHub, see .gitignore)
dynasties.json   the list of dynasties, their colors, and where their data comes from
```

## Put it on GitHub (one time)

1. Create a new repository on github.com (public is fine; GitHub Pages on private repos needs a paid plan).
2. Upload this folder. The data folder has 100+ files, so the web uploader's 100-file limit will get in the way. Use **GitHub Desktop** (add the folder as a local repository, then Publish) or git on the command line.
3. In the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. The "Deploy site" workflow runs on every push to `main`, and your site appears at `https://<your-username>.github.io/<repo-name>/`.

## Add a CFB27 season

1. Export the "Season in Review" HTML report from the game.
2. Drop it in `imports/umass/` (the folder matches `source` in `dynasties.json`). Keep one file per season.
3. Run `pip install pandas beautifulsoup4 lxml py7zr`, then `python tools/build.py`.
4. Commit and push. The new season appears in the season dropdown, and every player's career totals update.

Player matching across seasons uses the name, since the report has no player IDs. Two players with the same name would be merged.

## Update the OOTP dynasty

1. Export all tables to CSV from OOTP and put the files in `imports/reds/csv/`.
2. Run `python tools/build.py`, then commit and push.
3. The build re-reads the whole export, so a mid-season re-export just refreshes the current season.

`start_year` in `dynasties.json` is the first season you actually played (1997 for your Reds save). Everything earlier is shown as history. Player pages show the full career with a "Dynasty begins" divider and separate **before dynasty** and **since dynasty began** totals. Milestone badges (50, 100, 200-game club) count only games since the dynasty began. If your first played season was 1996, change `start_year` to 1996.

## Control panel (create and delete dynasties from the site)

Open your site and click **Control Panel** in the sidebar (or go to `#/admin`). It lists your dynasties, lets you create a new one for any game, and lets you delete one. A static site can't save files, so the panel talks to GitHub from your browser and saves each change as a commit. The site then redeploys by itself.

First time only, connect it with a token:

1. Open https://github.com/settings/personal-access-tokens/new
2. Name it "Dynasty Archive", pick an expiration, choose **Only select repositories**, and pick this repo.
3. Under **Repository permissions**, set **Contents** to **Read and write**. Generate the token.
4. Paste it into the panel along with your GitHub username and repo name.

The token stays in your browser only. It is forgotten when you close the tab unless you tick "Remember on this device". Only someone with your token can change anything, so the public page can't be used to edit your site. Disconnect from the panel any time, and revoke the token on GitHub if you lose a device.

If you also build on your computer, pull the latest changes in GitHub Desktop first, so a build doesn't overwrite what you did in the panel.

## Add stories

**From the Control Panel (no build needed):** the Stories section has two tools. **Write a story** is a form for anything that isn't a game report: pick a type (recap, preview, season review, feature or other), a headline, the season, and the text. **Import story files** takes one or several .md files, shows a preview, and publishes them. For files with no front matter it fills in the season and type from the boxes. Both save the story to your repo and update the site, and you can delete stories from the list there too. Stories that came from a season report can't be deleted this way, since the next build would bring them back.

**Or by hand:** save each story as a markdown file in `content/<dynasty>/`. See `content/reds/_example.md` for the format. CFB27 recaps that are inside the season report are imported automatically.

## Add another dynasty

Add an entry to `dynasties.json` (copy an existing one) and give it colors. A dynasty with no `source` still appears, with stories only. Madden, Football Manager and NBA 2K importers can be added to `tools/build.py` the same way once there is an export to read.

## Preview locally

```
python tools/build.py
cd site
python -m http.server 8000
```

Then open http://localhost:8000.
