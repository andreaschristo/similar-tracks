// Similar Tracks – απλός server χωρίς εξαρτήσεις (χρειάζεται Node 18+)
// Εκκίνηση:  node server.js   →   http://localhost:3000
// Προαιρετικό: LASTFM_API_KEY=xxxx node server.js  (καλύτερες προτάσεις "παρόμοιου" vibe)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LASTFM = process.env.LASTFM_API_KEY || '';
const UA = 'SimilarTracksApp/1.0 (personal project)';
const enc = encodeURIComponent;

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimilarTracksApp/1.0)' },
    signal: AbortSignal.timeout(10000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}
const dz = (p) => getJSON('https://api.deezer.com' + p);

// ---------- Καθάρισμα / ανάλυση τίτλων ----------
const NOISE = /\s*[\(\[][^\)\]]*(official|video|audio|lyric|free download|premiere|out now|\bhd\b|\bhq\b|visuali[sz]er|full track|preview)[^\)\]]*[\)\]]/gi;

function clean(s) {
  return (s || '')
    .replace(NOISE, '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function baseTitle(t) {
  return t.replace(/[\(\[].*?[\)\]]/g, '').replace(/\s+/g, ' ').trim();
}
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function parseTitleString(s) {
  s = clean(s);
  let m;
  if ((m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/))) return { artist: m[1].trim(), title: m[2].trim() };
  if ((m = s.match(/^(.+?),\s*by\s+(.+)$/i))) return { artist: m[2].trim(), title: m[1].trim() };
  if ((m = s.match(/^(.+)\s+by\s+(.+?)(?:\s+on\s+(?:Beatport|Bandcamp|SoundCloud).*)?$/i)))
    return { artist: m[2].trim(), title: m[1].trim() };
  return { artist: '', title: s };
}

// ---------- Αναγνώριση εισόδου (τίτλος ή URL) ----------
async function resolveUrl(u) {
  const host = new URL(u).hostname.replace(/^www\./, '');
  const attempts = [];

  if (/youtube\.com|youtu\.be|music\.youtube/.test(host)) {
    attempts.push(async () => {
      const d = await getJSON('https://www.youtube.com/oembed?format=json&url=' + enc(u));
      const p = parseTitleString(d.title);
      if (!p.artist) p.artist = clean(d.author_name);
      return p;
    });
  }
  if (/soundcloud\.com/.test(host)) {
    attempts.push(async () => {
      const d = await getJSON('https://soundcloud.com/oembed?format=json&url=' + enc(u));
      const p = parseTitleString(d.title);
      if (!p.artist) p.artist = clean(d.author_name);
      return p;
    });
  }
  // Odesli (song.link): Spotify, Apple Music, Deezer, Tidal, YouTube κ.ά.
  attempts.push(async () => {
    const d = await getJSON('https://api.song.link/v1-alpha.1/links?url=' + enc(u));
    const e = d.entitiesByUniqueId && d.entitiesByUniqueId[d.entityUniqueId];
    if (!e || !e.title) throw new Error('no odesli');
    return e.artistName ? { artist: clean(e.artistName), title: clean(e.title) } : parseTitleString(e.title);
  });
  // Γενικό: og:title / <title> της σελίδας (Beatport, Bandcamp, κ.λπ.)
  attempts.push(async () => {
    const html = await getText(u);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const t = (og && og[1]) || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (!t) throw new Error('no title');
    const decoded = t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');
    return parseTitleString(decoded);
  });

  for (const fn of attempts) {
    try {
      const r = await fn();
      if (r && r.title) return r;
    } catch (_) { /* δοκίμασε την επόμενη μέθοδο */ }
  }
  throw new Error('Δεν κατάφερα να διαβάσω τίτλο από αυτό το link. Δοκίμασε να γράψεις "Καλλιτέχνης - Τίτλος".');
}

async function resolveInput(q) {
  q = q.trim();
  if (/^https?:\/\//i.test(q)) return resolveUrl(q);
  return parseTitleString(q);
}

// ---------- Deezer ----------
function mapTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist && t.artist.name,
    artistId: t.artist && t.artist.id,
    album: t.album && t.album.title,
    cover: t.album && (t.album.cover_medium || t.album.cover),
    preview: t.preview || '',
    link: t.link,
  };
}

async function findSeed({ artist, title }) {
  const tries = [];
  if (artist) tries.push(`artist:"${artist}" track:"${baseTitle(title)}"`);
  if (artist) tries.push(`${artist} ${baseTitle(title)}`);
  tries.push(`${baseTitle(title)}`);
  for (const q of tries) {
    try {
      const r = (await dz(`/search?q=${enc(q)}&limit=5`)).data || [];
      if (r.length) return mapTrack(r[0]);
    } catch (_) {}
  }
  return null;
}

const VERSION_WORDS = /(remix|mix|edit|bootleg|rework|version|dub|vip|flip|extended|radio)/i;

async function findVersions(seed, input) {
  const base = baseTitle(input.title || seed.title);
  const nb = norm(base);
  const r = (await dz(`/search?q=${enc(`track:"${base}"`)}&limit=50`)).data || [];
  const out = r
    .map(mapTrack)
    .filter((t) => t.id !== seed.id && norm(t.title).includes(nb))
    .sort((a, b) => score(b) - score(a));
  function score(t) {
    let s = 0;
    if (norm(t.artist) === norm(seed.artist)) s += 2;
    if (VERSION_WORDS.test(t.title)) s += 1;
    return s;
  }
  return out.slice(0, 15);
}

async function sameArtist(seed) {
  if (!seed.artistId) return [];
  const r = (await dz(`/artist/${seed.artistId}/top?limit=20`)).data || [];
  return r.map(mapTrack).filter((t) => t.id !== seed.id);
}

async function lastfmSimilar(artist, title) {
  if (!LASTFM || !artist) return [];
  const url = `https://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${enc(artist)}&track=${enc(baseTitle(title))}&limit=25&autocorrect=1&api_key=${LASTFM}&format=json`;
  const d = await getJSON(url);
  const list = (d.similartracks && d.similartracks.track) || [];
  const out = [];
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const res = await Promise.all(
      chunk.map(async (t) => {
        try {
          const r = (await dz(`/search?q=${enc(`artist:"${t.artist.name}" track:"${t.name}"`)}&limit=1`)).data || [];
          if (r[0]) return { ...mapTrack(r[0]), match: Number(t.match) };
        } catch (_) {}
        return { id: 'lf-' + t.name + t.artist.name, title: t.name, artist: t.artist.name, preview: '', cover: '', link: t.url, match: Number(t.match) };
      })
    );
    out.push(...res);
  }
  return out;
}

async function deezerSimilar(seed) {
  if (!seed.artistId) return [];
  const rel = (await dz(`/artist/${seed.artistId}/related?limit=10`)).data || [];
  const tops = await Promise.all(
    rel.slice(0, 8).map((a) =>
      dz(`/artist/${a.id}/top?limit=3`).then((r) => (r.data || []).map(mapTrack)).catch(() => [])
    )
  );
  // Εναλλάξ από κάθε καλλιτέχνη για ποικιλία
  const out = [];
  for (let i = 0; i < 3; i++) for (const arr of tops) if (arr[i]) out.push(arr[i]);
  return out;
}

async function similar(seed, input) {
  const [lf, dzs] = await Promise.all([
    lastfmSimilar(seed.artist, seed.title).catch(() => []),
    deezerSimilar(seed).catch(() => []),
  ]);
  const seen = new Set([norm(seed.artist) + '|' + norm(baseTitle(seed.title))]);
  const out = [];
  for (const t of [...lf, ...dzs]) {
    const k = norm(t.artist) + '|' + norm(baseTitle(t.title));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 40);
}

// ---------- API ----------
async function handleSearch(q) {
  const input = await resolveInput(q);
  const seed = await findSeed(input);
  if (!seed) {
    return { input, seed: null, error: 'Δεν βρέθηκε το τραγούδι στο Deezer. Δοκίμασε "Καλλιτέχνης - Τίτλος".' };
  }
  const [sim, versions, same] = await Promise.all([
    similar(seed, input).catch(() => []),
    findVersions(seed, input).catch(() => []),
    sameArtist(seed).catch(() => []),
  ]);
  return { input, seed, similar: sim, versions, sameArtist: same, lastfm: !!LASTFM };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Γράψε τίτλο ή link.' })); }
    try {
      res.end(JSON.stringify(await handleSearch(q)));
    } catch (e) {
      res.statusCode = 200;
      res.end(JSON.stringify({ error: e.message || 'Κάτι πήγε στραβά.' }));
    }
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => console.log(`Έτοιμο: http://localhost:${PORT}  (Last.fm: ${LASTFM ? 'ON' : 'OFF'})`));
