# HOUZE

Track finder for house DJs: paste a title or a link, get extended tracks (5:00+) that mix well, with BPM, key and a two-deck practice mixer.

Styles (chips under the search box): All, Soulful house, House, Classic house, Deep house, Tech house.

Run locally: `node server.js` (Node 18+, no dependencies) → http://localhost:3000

## Environment variables (Render → Environment)

| Name | What it does |
|---|---|
| `LASTFM_API_KEY` | similar tracks, genre tags (soulful / house / classic / deep / tech), match % |
| `YOUTUBE_API_KEY` | full-track playback in the bottom player |
| `GETSONGBPM_API_KEY` | BPM, key and Camelot (also used as the BPM hint for the mixer) |
| `DISCOGS_TOKEN` | "Discogs · same era" tab (older / rarer releases) |
| `AI_BLOCKLIST` | optional, comma-separated artist names to hide (AI music) |

## Files

- `server.js` — API + static server (put in the repo folder `similar-tracks`)
- `public/index.html` — the whole site (put in `similar-tracks/public`)
- `package.json`

## Notes

- Render free plan sleeps when idle; first load can take ~1 minute.
- When the site is renamed or a domain is bought, update: Render service name / custom domain, the Last.fm application homepage, the GetSongBPM backlink, the footer.
