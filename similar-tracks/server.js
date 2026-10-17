// Similar Tracks – απλός server χωρίς εξαρτήσεις (χρειάζεται Node 18+)
// Εκκίνηση:  node server.js   →   http://localhost:3000
// Για φίλτρο είδους (house) χρειάζεται δωρεάν LASTFM_API_KEY.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LASTFM = process.env.LASTFM_API_KEY || '';
const DISCOGS = (process.env.DISCOGS_TOKEN || '').trim(); // Discogs: προσωπικό token (discogs.com/settings/developers)
const GSB = process.env.GETSONGBPM_API_KEY || ''; // BPM + tonality (getsongbpm.com)
const UA = 'SimilarTracksApp/1.0 (personal project)';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Δίκτυο ----------
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
async function lf(method, params) {
  const q = new URLSearchParams({ method, api_key: LASTFM, format: 'json', autocorrect: '1', ...params });
  return getJSON('https://ws.audioscrobbler.com/2.0/?' + q);
}

// Μικρή cache στη μνήμη (μειώνει τις κλήσεις και επιταχύνει τις επαναλήψεις)
const cache = new Map();
async function cached(key, fn, ttl = 3600e3) {
  const c = cache.get(key);
  if (c && c.t > Date.now()) return c.v;
  const v = await fn();
  if (v === null && key.startsWith('yt:')) return v;
  cache.set(key, { v, t: Date.now() + ttl });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return v;
}

// Παράλληλες κλήσεις σε μικρές παρτίδες, για να μην χτυπάμε τα όρια του Deezer
async function pmap(items, fn, size = 5, gap = 500) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const r = await Promise.all(items.slice(i, i + size).map((x, j) => fn(x, i + j).catch(() => null)));
    out.push(...r);
    if (i + size < items.length) await sleep(gap);
  }
  return out;
}

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
  if ((m = s.match(/^(.+)\s+by\s+(.+?)(?:\s+on\s+(?:Beatport|Bandcamp|SoundCloud|Traxsource|Juno).*)?$/i)))
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
  attempts.push(async () => {
    const d = await getJSON('https://api.song.link/v1-alpha.1/links?url=' + enc(u));
    const e = d.entitiesByUniqueId && d.entitiesByUniqueId[d.entityUniqueId];
    if (!e || !e.title) throw new Error('no odesli');
    return e.artistName ? { artist: clean(e.artistName), title: clean(e.title) } : parseTitleString(e.title);
  });
  attempts.push(async () => {
    const html = await getText(u);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const t = (og && og[1]) || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (!t) throw new Error('no title');
    const decoded = t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s*\|\s*(?:Releases?|Discogs|Traxsource|Juno).*$/i, '')
      .replace(/\s*[-–—|]\s*(?:Juno (?:Records|Download)|Traxsource|Discogs)\s*$/i, '')
      .replace(/\s*\((?:\d+|vinyl|12"|cd)[^)]*\)\s*$/i, '');
    return parseTitleString(decoded);
  });

  for (const fn of attempts) {
    try {
      const r = await fn();
      if (r && r.title) return r;
    } catch (_) { /* δοκίμασε την επόμενη μέθοδο */ }
  }
  throw Object.assign(new Error('Δεν κατάφερα να διαβάσω τίτλο από αυτό το link. Δοκίμασε να γράψεις "Καλλιτέχνης - Τίτλος".'), { code: 'nourl' });
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
    duration: t.duration || 0,
  };
}

async function findSeed({ artist, title }) {
  const tries = [];
  if (artist) tries.push(`artist:"${artist}" track:"${baseTitle(title)}"`);
  if (artist) tries.push(`${artist} ${baseTitle(title)}`);
  tries.push(`${baseTitle(title)}`);
  for (const q of tries) {
    try {
      const r = (await dz(`/search?q=${enc(q)}&limit=10`)).data || [];
      if (r.length) {
        // προτίμησε την extended έκδοση αν ο χρήστης την ζήτησε
        const wantExt = /extended|club/i.test(title);
        const pick = (wantExt && r.find((x) => /extended|club/i.test(x.title))) || r[0];
        return mapTrack(pick);
      }
    } catch (_) {}
  }
  return null;
}

// ---------- Κανόνες για "DJ friendly" ----------
const isRadio = (t) => /(radio (edit|mix|version)|short (edit|mix|version)|\bradio\b)/i.test(t || '');
const isExtendedTitle = (t) => /(extended|club mix|original mix|dub mix|full length)/i.test(t || '');
function lenScore(t) {
  return (isExtendedTitle(t.title) ? 0.25 : 0) + (t.duration >= 330 && t.duration <= 480 ? 0.15 : 0);
}
// Φίλτρο για AI μουσική: λέξεις-κλειδιά στον τίτλο/καλλιτέχνη/άλμπουμ + λίστα αποκλεισμού (env AI_BLOCKLIST, χωρισμένη με κόμμα)
const AI_WORDS = /\b(suno|udio|ai[\s_-]?generated|generated\s+(?:by\s+|with\s+|using\s+)?ai|ai[\s_-]?music|ai[\s_-]?cover|made\s+(?:by|with)\s+ai|artificial\s+intelligence|text[\s-]?to[\s-]?music)\b/i;
const AI_BLOCK = new Set(['xania monet', 'breaking rust', 'velvet sundown', 'the velvet sundown', ...(process.env.AI_BLOCKLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);
function isAI(t) {
  const artist = String(t.artist || '');
  if (AI_BLOCK.has(artist.toLowerCase())) return true;
  if (/(^|[\s(\[])AI([\s)\]]|$)/.test(artist)) return true; // «AI» με κεφαλαία στο όνομα καλλιτέχνη
  return AI_WORDS.test(`${artist} ${t.title || ''} ${t.album || ''}`);
}
const passLen = (t, minDur) => !isAI(t) && (!minDur || (t.duration >= minDur && !isRadio(t.title)));

// ---------- Είδος μέσω Last.fm tags (αν υπάρχει key) ----------
const REJECT_RE = /(techno|trance|progressive|melodic|minimal|dubstep|drum and bass|dnb|hardstyle|hardcore|\bpop\b|rock|hip.?hop|\brap\b|metal|big room|electro house|future house|trap|\bedm\b|reggaeton|latin)/;
async function artistKind(name) {
  if (!LASTFM) return 'neutral';
  const tags = await cached('tags:' + norm(name), async () => {
    const d = await lf('artist.gettoptags', { artist: name });
    return ((d.toptags && d.toptags.tag) || []).slice(0, 8).map((t) => String(t.name).toLowerCase());
  });
  if (!tags.length) return 'neutral';
  const house = tags.slice(0, 6).some((t) => /house/.test(t) && !/electro house|big room|future house/.test(t));
  if (house) return 'house';
  if (tags.slice(0, 3).some((t) => REJECT_RE.test(t))) return 'reject';
  return 'neutral';
}

// ---------- Tags (Last.fm) με βάρη ----------
// Κάθε tag έχει βάρος 0..100 (πόσοι ακροατές το έβαλαν). Τα κρατάμε για είδος ΚΑΙ για ομοιότητα ήχου.
const JUNK_TAG = /seen live|favou?rite|albums? i own|^my |spotify|^\d{2,4}s?$|awesome|^good|^best|^love$|^beautiful$/;
function cleanTags(arr) {
  return (Array.isArray(arr) ? arr : arr ? [arr] : [])
    .map((x) => ({ n: String(x.name || '').toLowerCase().trim(), c: Number(x.count) || 0 }))
    .filter((x) => x.n && !JUNK_TAG.test(x.n))
    .slice(0, 15);
}
async function artistTags(name) {
  return cached('atv:' + norm(name), async () => {
    const d = await lf('artist.gettoptags', { artist: name });
    return cleanTags(d.toptags && d.toptags.tag);
  }, 7 * 24 * 3600e3);
}
// Tags του κομματιού· αν το κομμάτι έχει λίγα, παίρνουμε του καλλιτέχνη
async function tagsOf(artist, title) {
  if (!LASTFM || !artist) return { list: [], src: '' };
  try {
    const tt = await cached('ttv:' + norm(artist) + '|' + norm(baseTitle(title)), async () => {
      const d = await lf('track.gettoptags', { artist, track: baseTitle(title) });
      return cleanTags(d.toptags && d.toptags.tag);
    }, 7 * 24 * 3600e3);
    if (tt.filter((x) => x.c > 0).length >= 3) return { list: tt, src: 'track' };
    const at = await artistTags(artist);
    return at.length ? { list: at, src: 'artist' } : { list: tt, src: 'track' };
  } catch (_) { return { list: [], src: '' }; }
}

// ---------- Είδος (genre) ανά κομμάτι ----------
const GENRES = [
  ['deep house', /deep.?house/],
  ['tech house', /tech.?house/],
  ['soulful house', /soulful.?house|vocal house|gospel house|soulful/],
  ['classic house', /classic house|chicago house|old.?school house|garage house|disco house|funky house|acid house/],
  ['afro house', /afro.?house/],
];
// Είδη που δεν θέλουμε ποτέ (ούτε στο All)
const EXCLUDE_RE = /techno|trance|progressive|melodic|minimal|\belectro\b|big room|future house|\bedm\b|dubstep|drum.?(and|n|&).?bass|\bdnb\b|hardstyle|hard.?house|hardcore|psy|trap|ambient|downtempo/;
const PLAIN_HOUSE = (tg) => /\bhouse\b/.test(tg) && !/electro house|big room|future house/.test(tg);
// Διαβάζει τα tags με σειρά δημοφιλίας και βγάζει το κύριο είδος.
//  - Αν πριν από κάθε house tag υπάρχει techno / progressive κ.λπ. → excluded
//  - Σκέτο «house» + δυνατό υπο-είδος (≥70%) → το υπο-είδος (π.χ. house 100, deep house 80 → deep house)
//  - mixed = ΜΟΝΟ όταν συγκρούονται δύο πραγματικά διαφορετικά υφάκια (tech house με deep / soulful / classic)
function classify(list) {
  const fam = [];
  for (const x of list.slice(0, 10)) {
    const tg = x.n;
    if (EXCLUDE_RE.test(tg) && !/tech.?house|deep.?house|soulful/.test(tg)) {
      if (!fam.length) return { genre: '', excluded: true, mixed: false };
      continue;
    }
    let g = '';
    for (const [name, re] of GENRES) if (re.test(tg)) { g = name; break; }
    if (!g && PLAIN_HOUSE(tg)) g = 'house';
    if (g && !fam.some((f) => f.g === g)) fam.push({ g, c: x.c || 1 });
  }
  if (!fam.length) return { genre: '', excluded: false, mixed: false };
  const subs = fam.filter((f) => f.g !== 'house');
  let main = fam[0];
  if (main.g === 'house' && subs.length && subs[0].c >= 0.7 * main.c) main = subs[0];
  const strong = subs.filter((f) => f.c >= 0.7 * Math.max(main.c, subs[0] ? subs[0].c : 0));
  const hasTech = strong.some((f) => f.g === 'tech house');
  const hasOther = strong.some((f) => f.g !== 'tech house');
  return { genre: main.g, excluded: false, mixed: hasTech && hasOther };
}
const pickGenre = (names) => classify(names.map((n) => ({ n, c: 0 }))).genre;
// Είδος + πόσο σίγουρο είναι. sure=false ΜΟΝΟ όταν: τα tags συγκρούονται (π.χ. deep και tech εξίσου)
// ή το BPM είναι εκτός house (και όχι μισό / διπλό τέμπο).
async function genreInfo(artist, title, bpm) {
  if (!LASTFM || !artist) return { genre: '', excluded: false, sure: true, note: '' };
  // Πρώτα τα tags του ίδιου του κομματιού (ακόμα κι αν είναι λίγα)· αλλιώς του καλλιτέχνη
  let tt = [];
  try {
    tt = await cached('ttv:' + norm(artist) + '|' + norm(baseTitle(title)), async () => {
      const d = await lf('track.gettoptags', { artist, track: baseTitle(title) });
      return cleanTags(d.toptags && d.toptags.tag);
    }, 7 * 24 * 3600e3);
  } catch (_) {}
  let c = classify(tt);
  if (!c.genre && !c.excluded) {
    try { const c2 = classify(await artistTags(artist)); if (c2.genre || c2.excluded) c = c2; } catch (_) {}
  }
  let note = '';
  if (c.genre) {
    const inHouse = (b) => b >= 108 && b <= 135;
    if (c.mixed) note = 'mixed';
    else if (bpm && !inHouse(bpm) && !inHouse(bpm * 2) && !inHouse(bpm / 2)) note = 'bpm';
  }
  return { genre: c.genre, excluded: c.excluded, sure: !note, note };
}
async function genreOf(artist, title) { return (await genreInfo(artist, title)).genre; }

// ---------- Ομοιότητα ----------
// Ήχος: cosine ανάμεσα στα tags (με βάρη) του δικού σου κομματιού και του υποψήφιου
const GENERIC_TAG = /^(electronic|electronica|dance|house|club|music|edm)$/;
function tagVec(list) {
  const v = new Map();
  for (const x of list) v.set(x.n, (v.get(x.n) || 0) + ((x.c || 1) / 100) * (GENERIC_TAG.test(x.n) ? 0.4 : 1));
  return v;
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; if (b.has(k)) d += x * b.get(k); }
  for (const x of b.values()) nb += x * x;
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
// Tempo: ίδιο (±2%) = 1, πάνω από ±8% = 0
function bpmSim(a, b) {
  if (!a || !b) return null;
  const d = Math.abs(b - a) / a;
  return d <= 0.02 ? 1 : d >= 0.08 ? 0 : 1 - (d - 0.02) / 0.06;
}
// Κλειδί: πόσο αρμονικά δένει (Camelot)
const KEY_SIM = { same: 1, smooth: 0.9, relative: 0.85, boost: 0.6, clash: 0.1 };
function keySim(a, b) { const r = camRel(a, b); return r === 'unknown' ? null : KEY_SIM[r]; }
// Τελικό match: ακροατές 40% · ήχος (tags) 30% · BPM 15% · κλειδί 15%.
// Αν λείπει κάποιο στοιχείο, το match μειώνεται: 90%+ μόνο όταν ταιριάζουν ΟΛΑ.
const W = { cf: 0.4, tag: 0.3, bpm: 0.15, key: 0.15 };
function scoreOf(x) {
  const parts = { cf: x.cf, tag: x.tagSim, bpm: x.bpmSim, key: x.keySim };
  let s = 0, w = 0;
  for (const k in W) if (parts[k] != null) { s += W[k] * parts[k]; w += W[k]; }
  return w ? (s / w) * (0.7 + 0.3 * w) : 0;
}
const pct100 = (v) => (v == null ? null : Math.round(v * 100));
// Επιλογή είδους → ακριβές είδος που κρατάμε («house» = μόνο σκέτο house)
const GENRE_NAME = { house: 'house', soulful: 'soulful house', classic: 'classic house', deep: 'deep house', tech: 'tech house' };
const wantedGenre = (g) => (LASTFM && GENRE_NAME[g]) || '';
const GENRE_KEY_OF = { house: 'house', 'deep house': 'deep', 'soulful house': 'soulful', 'classic house': 'classic', 'tech house': 'tech' };
// «auto»: διαλέγει το είδος του κομματιού που έψαξες (αλλιώς All)
// «auto» (νέα αναζήτηση): ΔΕΝ κλειδώνει σε είδος. Ψάχνει με βάση το ύφος σε όλα τα house είδη
// και απλώς μας λέει τι είδος είναι το δικό σου κομμάτι. Φίλτρο είδους μόνο όταν το πατήσεις εσύ.
async function resolveGenre(g, seed) {
  const gi = LASTFM ? await genreInfo(seed.artist, seed.title).catch(() => null) : null;
  return { genre: g === 'auto' ? 'any' : g, seedGenre: gi, seedKey: (gi && GENRE_KEY_OF[gi.genre]) || '' };
}
// Κρατάει μόνο το επιλεγμένο είδος και πετάει πάντα techno / progressive κ.λπ.
async function genreFilter(list, g) {
  if (!LASTFM) return list;
  const want = wantedGenre(g);
  await pmap(list, async (x) => { const gi = await genreInfo(x.artist, x.title); x.genre = gi.genre; x.genreSure = gi.sure; x.excluded = gi.excluded; }, 5, 250);
  return list.filter((x) => !x.excluded && (!want || x.genre === want));
}

// ---------- Πηγές αποτελεσμάτων ----------
async function dzTop(artistId) {
  return cached('top:' + artistId, async () => {
    const r = (await dz(`/artist/${artistId}/top?limit=50`)).data || [];
    return r.map(mapTrack);
  });
}
async function resolveDzArtist(name) {
  return cached('art:' + norm(name), async () => {
    const r = (await dz(`/search/artist?q=${enc(name)}&limit=3`)).data || [];
    return r.find((x) => norm(x.name) === norm(name)) || null;
  });
}

async function findVersions(seed, input, opts) {
  const base = baseTitle(input.title || seed.title);
  const nb = norm(base);
  const r = (await dz(`/search?q=${enc(`track:"${base}"`)}&limit=50`)).data || [];
  const VERSION_WORDS = /(remix|mix|edit|bootleg|rework|version|dub|vip|flip|extended)/i;
  const score = (t) =>
    (norm(t.artist) === norm(seed.artist) ? 2 : 0) + (VERSION_WORDS.test(t.title) ? 1 : 0) + lenScore(t);
  return r
    .map(mapTrack)
    .filter((t) => t.id !== seed.id && norm(t.title).includes(nb) && passLen(t, opts.minDur))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 15);
}

async function sameArtist(seed, opts) {
  if (!seed.artistId) return [];
  const r = await dzTop(seed.artistId);
  return r
    .filter((t) => t.id !== seed.id && passLen(t, opts.minDur))
    .sort((a, b) => lenScore(b) - lenScore(a))
    .slice(0, 20);
}

async function lastfmSimilar(artist, title) {
  if (!LASTFM || !artist) return [];
  const d = await lf('track.getsimilar', { artist, track: baseTitle(title), limit: '40' });
  const list = (d.similartracks && d.similartracks.track) || [];
  const out = await pmap(list, async (t) => {
    const r = ((await dz(`/search?q=${enc(`artist:"${t.artist.name}" track:"${baseTitle(t.name)}"`)}&limit=5`)).data || []).map(mapTrack);
    const same = r.filter((x) => norm(baseTitle(x.title)) === norm(baseTitle(t.name)));
    const pool = same.length ? same : r;
    if (!pool.length) return null;
    // προτίμησε τη μεγαλύτερη (extended) έκδοση
    const best = pool.sort((a, b) => b.duration - a.duration)[0];
    return { ...best, match: Number(t.match) || 0 };
  }, 5, 500);
  return out.filter(Boolean);
}

async function artistPool(seed) {
  const names = new Set([norm(seed.artist)]);
  const dzList = seed.artistId
    ? ((await dz(`/artist/${seed.artistId}/related?limit=25`)).data || []).map((a) => ({ id: a.id, name: a.name }))
    : [];
  let lfList = [];
  if (LASTFM && seed.artist) {
    try {
      const d = await lf('artist.getsimilar', { artist: seed.artist, limit: '30' });
      lfList = ((d.similarartists && d.similarartists.artist) || []).map((a) => ({ id: null, name: a.name, sim: Math.max(0, Math.min(1, Number(a.match) || 0)) }));
    } catch (_) {}
  }
  // εναλλάξ Last.fm / Deezer, χωρίς διπλότυπα
  const out = [];
  for (let i = 0; i < Math.max(dzList.length, lfList.length); i++) {
    for (const a of [lfList[i], dzList[i]]) {
      if (a && !names.has(norm(a.name))) { names.add(norm(a.name)); out.push({ ...a }); }
    }
  }
  return out.slice(0, 40);
}

const GENRE_KEYS = ['any', 'house', 'soulful', 'classic', 'deep', 'tech'];
async function similar(seed, opts) {
  const { minDur, house } = opts;
  const want = wantedGenre(opts.genre);
  const cap = opts.cap || 40;
  const useHouse = !!LASTFM; // techno / progressive κ.λπ. φεύγουν πάντα, ακόμα και στο All

  const [lfTracks, pool] = await Promise.all([
    lastfmSimilar(seed.artist, seed.title).catch(() => []),
    artistPool(seed).catch(() => []),
  ]);

  // Γρήγορο πρώτο φίλτρο: πετάμε καλλιτέχνες που δεν είναι house (techno, pop κ.λπ.)
  const kinds = {};
  if (useHouse) {
    const names = [...new Set([...lfTracks.map((t) => t.artist), ...pool.map((a) => a.name)])].slice(0, 70);
    await pmap(names, async (n) => { kinds[norm(n)] = await artistKind(n); }, 6, 250);
  }
  const kind = (n) => kinds[norm(n)] || 'neutral';
  const ok = (t) => passLen(t, minDur) && !(useHouse && kind(t.artist) === 'reject');

  // 1) Υποψήφιοι + «ακροατές» (cf): πόσο συχνά τα ακούει ο ίδιος κόσμος
  const seedKey = norm(seed.artist) + '|' + norm(baseTitle(seed.title));
  const cands = new Map();
  const add = (t, cf) => {
    const k = norm(t.artist) + '|' + norm(baseTitle(t.title));
    if (k === seedKey) return;
    const c = cands.get(k);
    if (!c || cf > c.cf) cands.set(k, { ...t, cf });
  };
  for (const t of lfTracks) if (ok(t)) add(t, Math.sqrt(Math.max(0, Math.min(1, t.match || 0))));
  const usable = pool.filter((a) => !(useHouse && kind(a.name) === 'reject')).slice(0, want || cap > 40 ? 26 : 18);
  const tops = await pmap(usable, async (a, i) => {
    if (!a.id) {
      const r = await resolveDzArtist(a.name);
      if (!r) return [];
      a.id = r.id;
    }
    // ίδιος κόσμος ακούει τον καλλιτέχνη, όχι απαραίτητα αυτό το κομμάτι → 75% του artist match
    const aSim = a.sim != null ? a.sim : 0.2 + 0.5 * (1 - i / usable.length);
    const top = await dzTop(a.id);
    return top.filter(ok).slice(0, 8).map((t, j) => ({ t, cf: 0.75 * aSim * (1 - 0.04 * j) }));
  }, 4, 500);
  for (const arr of tops) if (arr) for (const { t, cf } of arr) add(t, cf);

  let list = [...cands.values()].sort((a, b) => b.cf + lenScore(b) * 0.2 - (a.cf + lenScore(a) * 0.2));
  const per = {};
  list = list.filter((x) => { const a = norm(x.artist); per[a] = (per[a] || 0) + 1; return per[a] <= 4; })
    .slice(0, want ? (cap > 40 ? 110 : 90) : (cap > 40 ? 90 : 60));

  // 2) Ήχος (tags) + είδος
  if (LASTFM) {
    const sv = tagVec((await tagsOf(seed.artist, seed.title)).list);
    await pmap(list, async (x) => {
      const tg = await tagsOf(x.artist, x.title);
      x.tagSim = sv.size && tg.list.length ? cosine(sv, tagVec(tg.list)) : null;
      const gi = await genreInfo(x.artist, x.title);
      x.genre = gi.genre; x.genreSure = gi.sure; x.excluded = gi.excluded;
    }, 5, 250);
    // Αυστηρό είδος: House = μόνο house, Deep = μόνο deep κ.λπ. (All = όλα, χωρίς techno / progressive)
    list = list.filter((x) => !x.excluded && (!want || x.genre === want));
  }

  // 3) BPM + κλειδί για τους καλύτερους υποψήφιους
  list.forEach((x) => { x.score = scoreOf(x); });
  list.sort((a, b) => b.score - a.score);
  if (GSB) {
    const si = await trackInfo(seed.artist, seed.title);
    const top = list.slice(0, 30);
    const infos = await pmap(top, (x) => trackInfo(x.artist, x.title), 6, 200);
    top.forEach((x, i) => {
      const inf = infos[i];
      x.bpmSim = si && inf ? bpmSim(si.bpm, inf.bpm) : null;
      x.keySim = si && inf ? keySim(si.camelot, inf.camelot) : null;
      x.score = scoreOf(x);
    });
    list.sort((a, b) => b.score - a.score);
  }

  // 4) Τελική λίστα: έως 3 ανά καλλιτέχνη
  const perArtist = {};
  const out = [];
  for (const x of list) {
    const a = norm(x.artist);
    if ((perArtist[a] || 0) >= 3) continue;
    perArtist[a] = (perArtist[a] || 0) + 1;
    x.pct = Math.max(5, Math.min(99, Math.round(x.score * 100)));
    x.why = { cf: pct100(x.cf), tag: pct100(x.tagSim), bpm: pct100(x.bpmSim), key: pct100(x.keySim) };
    out.push(x);
    if (out.length >= cap) break;
  }
  return { list: out, houseFilter: useHouse };
}

// ---------- BPM + tonality (GetSongBPM) ----------
const CAM_MAJ = { C: '8B', G: '9B', D: '10B', A: '11B', E: '12B', B: '1B', 'F#': '2B', Gb: '2B', 'C#': '3B', Db: '3B', 'G#': '4B', Ab: '4B', 'D#': '5B', Eb: '5B', 'A#': '6B', Bb: '6B', F: '7B' };
const CAM_MIN = { A: '8A', E: '9A', B: '10A', 'F#': '11A', Gb: '11A', 'C#': '12A', Db: '12A', 'G#': '1A', Ab: '1A', 'D#': '2A', Eb: '2A', 'A#': '3A', Bb: '3A', F: '4A', C: '5A', G: '6A', D: '7A' };
function toCamelot(k) {
  if (!k) return '';
  let s = String(k).replace(/♯/g, '#').replace(/♭/g, 'b').trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const m = s.match(/^([A-G][#b]?)(m|min|minor)?$/);
  if (!m) return '';
  return (m[2] ? CAM_MIN[m[1]] : CAM_MAJ[m[1]]) || '';
}
async function gsb(p, params) {
  const q = new URLSearchParams({ api_key: GSB, ...params });
  return getJSON('https://api.getsong.co' + p + '?' + q);
}
async function trackInfo(artist, title) {
  if (!GSB || !artist || !title) return null;
  const key = 'gsb:' + norm(artist) + '|' + norm(baseTitle(title));
  try {
    return await cached(key, async () => {
      const s = await gsb('/search/', { type: 'both', lookup: `song:${baseTitle(title)} artist:${artist}`, limit: '5' });
      const list = Array.isArray(s.search) ? s.search : [];
      if (!list.length) return null;
      const pick = list.find((x) => x.artist && norm(x.artist.name) === norm(artist)) || list[0];
      let tempo = pick.tempo, keyOf = pick.key_of;
      if (!tempo || !keyOf) {
        const d = await gsb('/song/', { id: pick.id });
        const sg = d.song || {};
        tempo = tempo || sg.tempo;
        keyOf = keyOf || sg.key_of;
      }
      const bpm = Number(tempo) || 0;
      if (!bpm && !keyOf) return null;
      return { bpm, key: keyOf || '', camelot: toCamelot(keyOf) };
    }, 7 * 24 * 3600e3);
  } catch (_) {
    return null; // λάθος δικτύου / όριο αιτημάτων: δεν αποθηκεύεται στη cache
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// ---------- DJ set builder ----------
function compat(c) {
  const n = parseInt(c, 10), L = c.slice(-1), O = L === 'A' ? 'B' : 'A';
  return { same: c, smooth: [(((n + 10) % 12) + 1) + L, ((n % 12) + 1) + L], relative: n + O, boost: (((n + 1) % 12) + 1) + L };
}
function camRel(a, b) {
  if (!a || !b) return 'unknown';
  if (a === b) return 'same';
  const x = compat(a);
  if (x.smooth.includes(b)) return 'smooth';
  if (x.relative === b) return 'relative';
  if (x.boost === b) return 'boost';
  return 'clash';
}
const KEY_COST = { same: 0, smooth: 0.5, relative: 0.7, boost: 1.5, unknown: 2.5, clash: 6 };
// Ενέργεια ανά θέση p (0..1): άνοδος μέχρι ~55%, κορυφή μέχρι ~75%, ήπια πτώση στο τέλος
function arcAt(i, N) {
  const p = N > 1 ? i / (N - 1) : 0;
  if (p <= 0.55) return p / 0.55;
  if (p <= 0.75) return 1;
  return 1 - 0.75 * ((p - 0.75) / 0.25);
}
function sectionAt(i, N) {
  const p = N > 1 ? i / (N - 1) : 0;
  return p < 0.15 ? 'intro' : p < 0.45 ? 'build' : p < 0.8 ? 'peak' : 'outro';
}
function slotOfRole(role, N) {
  return role === 'open' ? 0 : role === 'close' ? N - 1 : Math.round((N - 1) * 0.65);
}
const BLEND_SEC = 60; // μέση επικάλυψη ανά μετάβαση

// ---- Ρόλος του DJ: ο ρόλος αλλάζει την ΕΝΕΡΓΕΙΑ μέσα στο ίδιο στυλ (όλοι μπορεί να παίζουν deep house) ----
// Ενέργεια από tags του Last.fm (χαλαρό ↔ δυναμικό) και από το BPM όταν υπάρχει.
const LOW_TAG = /chill|mellow|relax|smooth|lounge|ambient|downtempo|sunset|late.?night|dreamy|calm|warm|laid.?back|intimate|cozy|slow/;
const HIGH_TAG = /energetic|energy|dance|party|club|upbeat|banger|driving|peak|hard|bounce|groovy|funky|jackin|festival|rave|pumping|heavy|dancefloor/;
const EMO_TAG = /uplifting|euphoric|emotional|soulful|vocal|melodic|anthem|feel.?good|happy|summer|hands.?up|gospel|joy|beautiful|love/;
async function ttagsOf(artist, title) {
  return (await tagsOf(artist, title)).list.map((x) => x.n);
}
function energyRaw(t) {
  let e = 0.5;
  for (const tg of t.tags || []) { if (LOW_TAG.test(tg)) e -= 0.12; if (HIGH_TAG.test(tg)) e += 0.12; }
  e = Math.max(0.05, Math.min(0.95, e));
  const b = t.info && t.info.bpm;
  return b ? 0.6 * Math.max(0, Math.min(1, (b - 116) / 16)) + 0.4 * e : e;
}
function emotiveOf(t) {
  let e = 0.4;
  for (const tg of t.tags || []) if (EMO_TAG.test(tg)) e += 0.2;
  return Math.min(1, e);
}
// Στόχος (σε ποσοστιαία κλίμακα 0..1 μέσα στους υποψήφιους) στη θέση i του set
function roleEnergy(role, i, N) {
  const p = N > 1 ? i / (N - 1) : 0;
  if (role === 'open') return 0.08 + 0.37 * p;                     // opener: πιο χαλαρά, ανεβαίνει σιγά-σιγά
  if (role === 'close') return 0.82 - 0.17 * p;                    // closer: δυναμικά και χορευτικά, αλλά με άλλο χρώμα
  return p < 0.4 ? 0.5 + 0.4 * (p / 0.4) : 0.9 - 0.05 * ((p - 0.4) / 0.6); // headliner: πολύ υψηλή ενέργεια
}
async function buildSet(seed, pool, role, N = 10) {
  const slot = slotOfRole(role, N);
  const seen = new Set([norm(seed.artist) + '|' + norm(baseTitle(seed.title))]);
  const cands = [];
  for (const t of pool) {
    const k = norm(t.artist) + '|' + norm(baseTitle(t.title));
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push({ ...t });
    if (cands.length >= Math.min(60, N * 3)) break;
  }

  // BPM + tonality για το seed και τους υποψήφιους
  if (LASTFM) await pmap([seed, ...cands], async (t) => { t.genre = await genreOf(t.artist, t.title); t.tags = await ttagsOf(t.artist, t.title); }, 5, 200);
  const infos = await pmap([seed, ...cands], (t) => trackInfo(t.artist, t.title), 6, 200);
  seed.info = infos[0] || null;
  cands.forEach((t, i) => { t.info = infos[i + 1] || null; });

  // Η ενέργεια κάθε υποψηφίου σε σχέση με τους υπόλοιπους (0 = ο πιο χαλαρός, 1 = ο πιο δυναμικός)
  const raws = cands.map(energyRaw);
  const sorted = [...raws].sort((x, y) => x - y);
  cands.forEach((t, i) => {
    const lo = sorted.indexOf(raws[i]), hi = sorted.lastIndexOf(raws[i]);
    t.eRank = cands.length > 1 ? (lo + hi) / 2 / (cands.length - 1) : 0.5;
  });
  const sBpm = seed.info && seed.info.bpm;
  const known = cands.filter((t) => t.info && t.info.bpm).length;
  const useBpm = !!sBpm && known >= 6;

  let pickable = cands;
  let target = () => 0;
  if (useBpm) {
    // κράτα όσα είναι σε λογικό εύρος γύρω από το seed (±8%) ή δεν έχουν BPM
    pickable = cands.filter((t) => !(t.info && t.info.bpm) || Math.abs(t.info.bpm - sBpm) / sBpm <= 0.08);
    const span = 0.06;
    const low = sBpm / (1 + span * arcAt(slot, N));
    target = (i) => low * (1 + span * arcAt(i, N));
  }

  const picked = new Array(N).fill(null);
  picked[slot] = seed;
  const used = new Set();
  const order = [];
  for (let i = slot + 1; i < N; i++) order.push([i, i - 1]);
  for (let i = slot - 1; i >= 0; i--) order.push([i, i + 1]);

  for (const [i, ref] of order) {
    const refT = picked[ref];
    let best = null, bestCost = Infinity;
    pickable.forEach((c, idx) => {
      if (used.has(c.id)) return;
      let cost = 0;
      if (useBpm) {
        const b = c.info && c.info.bpm;
        const tg = target(i);
        cost += b ? (Math.abs(b - tg) / tg) * 200 : 3;
        cost += KEY_COST[camRel(refT.info && refT.info.camelot, c.info && c.info.camelot)];
        if (b && refT.info && refT.info.bpm) cost += (Math.abs(b - refT.info.bpm) / refT.info.bpm) * 50;
      } else {
        cost += idx * 0.15; // χωρίς BPM: σειρά ομοιότητας
      }
      cost += Math.abs((c.eRank == null ? 0.5 : c.eRank) - roleEnergy(role, i, N)) * 5; // ρόλος: ενέργεια μέσα στο ίδιο στυλ
      if (role === 'close') cost += (1 - emotiveOf(c)) * 1.2; // closer: δυναμικό αλλά με πιο μελωδικό / uplifting χρώμα
      if (picked.some((p) => p && norm(p.artist) === norm(c.artist))) cost += 2;
      const d = c.duration || 0;
      if (d < 360) cost += 0.8;
      if (d > 540) cost += 0.5;
      if (cost < bestCost) { best = c; bestCost = cost; }
    });
    if (!best) continue;
    picked[i] = best;
    used.add(best.id);
  }

  const items = [];
  picked.forEach((t, i) => { if (t) items.push({ t, section: sectionAt(i, N), isSeed: i === slot }); });
  const set = items.map(({ t, section, isSeed }, idx) => {
    const prev = idx > 0 ? items[idx - 1].t : null;
    let transition = null;
    if (prev) {
      const pb = prev.info && prev.info.bpm, cb = t.info && t.info.bpm;
      transition = {
        bpmPct: pb && cb ? Math.round(((cb - pb) / pb) * 1000) / 10 : null,
        key: camRel(prev.info && prev.info.camelot, t.info && t.info.camelot),
        from: (prev.info && prev.info.camelot) || '',
        to: (t.info && t.info.camelot) || '',
      };
    }
    return {
      id: t.id, title: t.title, artist: t.artist, cover: t.cover, preview: t.preview, link: t.link,
      duration: t.duration || 0, section, isSeed, genre: t.genre || '',
      bpm: (t.info && t.info.bpm) || 0, key: (t.info && t.info.key) || '', camelot: (t.info && t.info.camelot) || '',
      transition,
    };
  });
  const totalSec = set.reduce((a, x) => a + x.duration, 0);
  const mixedSec = Math.max(0, totalSec - Math.max(0, set.length - 1) * BLEND_SEC);
  return { set, totalSec, mixedSec, bpmUsed: useBpm };
}

// ---------- API ----------
async function handleSet(q, role, minutes, genre) {
  const input = await resolveInput(q);
  const seed = await findSeed(input);
  if (!seed) return { error: 'Δεν βρέθηκε το τραγούδι στο Deezer.', code: 'notfound' };
  const rg = await resolveGenre(genre, seed);
  genre = rg.genre;
  const N = Math.max(6, Math.min(24, Math.round(minutes / 6))); // ~6 λεπτά ανά κομμάτι: 60'→10, 90'→15, 120'→20
  const big = N > 12;
  const opts = { minDur: 300, house: genre !== 'any', genre, cap: big ? 70 : 40 };
  const [sim, same] = await Promise.all([
    similar(seed, opts).catch(() => ({ list: [], houseFilter: false })),
    sameArtist(seed, opts).then((l) => genreFilter(l, genre)).catch(() => []),
  ]);
  const built = await buildSet(seed, [...sim.list, ...same.slice(0, big ? 10 : 6)], role, N);
  if (LASTFM && Array.isArray(built.set)) {
    await pmap(built.set, async (x) => { const gi = await genreInfo(x.artist, x.title, x.bpm); x.genre = gi.genre; x.genreSure = gi.sure; x.genreNote = gi.note; }, 5, 200);
  }
  return { seed, role, minutes, wanted: N, genre, seedGenreKey: rg.seedKey, bpmEnabled: !!(GSB || LASTFM), houseFilter: sim.houseFilter, ...built };
}

// ---------- Discogs: παλιά / σπάνια κομμάτια ίδιας εποχής και στυλ ----------
async function dcGet(pathq) {
  const r = await fetch('https://api.discogs.com' + pathq, {
    headers: { 'User-Agent': UA, Authorization: 'Discogs token=' + DISCOGS },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('discogs ' + r.status);
  return r.json();
}
const HOUSE_STYLE = /house|garage|disco|acid|chicago|tribal|funk|soul|balearic|progressive|afro|latin|breakbeat|deep|tech/i;
function dcSplit(title) {
  const m = String(title || '').match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].replace(/\s*\(\d+\)$/, '').trim(), title: m[2].trim() } : { artist: '', title: String(title || '') };
}
const DC_STYLE = { house: 'House', soulful: 'Garage House', classic: 'Chicago House', deep: 'Deep House', tech: 'Tech House' };
async function discogsSimilar(seed, genre) {
  if (!DISCOGS || !seed || !seed.artist) return [];
  const any = genre === 'any';
  return cached('dc:' + (genre || 'house') + ':' + norm(seed.artist) + '|' + norm(baseTitle(seed.title)), async () => {
    const q1 = new URLSearchParams({ type: 'release', artist: seed.artist, track: baseTitle(seed.title), per_page: '8' });
    const base = ((await dcGet('/database/search?' + q1)).results || []);
    let hits = any ? base : base.filter((x) => (x.genre || []).includes('Electronic') || (x.style || []).some((s) => HOUSE_STYLE.test(s)));
    if (!hits.length) hits = base;
    const styleCount = {};
    const years = [];
    for (const h of hits) {
      for (const s of h.style || []) if (any || HOUSE_STYLE.test(s)) styleCount[s] = (styleCount[s] || 0) + 1;
      const y = Number(h.year); if (y > 1970) years.push(y);
    }
    let seedStyles = Object.keys(styleCount).sort((a, b) => styleCount[b] - styleCount[a]).slice(0, 3);
    if (DC_STYLE[genre]) seedStyles = [DC_STYLE[genre]];
    const dcGenre = any ? ((hits[0] && (hits[0].genre || [])[0]) || 'Electronic') : 'Electronic';
    if (!seedStyles.length) return [];
    years.sort((a, b) => a - b);
    const year = years.length ? years[Math.floor(years.length / 2)] : 0;
    const jobs = [];
    const yrs = year ? [year - 1, year, year + 1] : [0];
    for (const y of yrs) {
      const p = { type: 'release', genre: dcGenre, style: seedStyles[0], sort: 'have', sort_order: 'desc', per_page: '40' };
      if (y) p.year = String(y);
      jobs.push(dcGet('/database/search?' + new URLSearchParams(p)).then((d) => d.results || []).catch(() => []));
    }
    const all = (await Promise.all(jobs)).flat();
    const seen = new Set([norm(seed.artist) + '|' + norm(baseTitle(seed.title))]);
    const perArtist = {};
    const out = [];
    for (const x of all) {
      const { artist, title } = dcSplit(x.title);
      if (!artist || /various/i.test(artist)) continue;
      const k = norm(artist) + '|' + norm(baseTitle(title));
      const an = norm(artist);
      if (seen.has(k) || (perArtist[an] || 0) >= 2) continue;
      seen.add(k); perArtist[an] = (perArtist[an] || 0) + 1;
      if ((x.style || []).some((s) => /techno|trance|progressive|minimal|electro|dubstep|drum n bass|hardstyle|psy/i.test(s)) && !(x.style || []).some((s) => /house|garage|disco/i.test(s))) continue;
      const xs = (x.style || []).filter((s) => any || HOUSE_STYLE.test(s));
      const overlap = seedStyles.filter((s) => xs.includes(s)).length / seedStyles.length;
      const dy = year && Number(x.year) ? Math.abs(Number(x.year) - year) : 5;
      const pct = Math.max(5, Math.min(95, Math.round(25 + 40 * overlap + 30 * Math.max(0, 1 - dy / 6))));
      out.push({
        id: 'dc' + x.id, title, artist, year: x.year || '', label: ((x.label || [])[0] || '').replace(/\s*\(\d+\)$/, ''),
        genre: (xs[0] || (x.style || [])[0] || '').toLowerCase(), cover: x.thumb || '', link: 'https://www.discogs.com' + (x.uri || ''),
        preview: '', duration: 0, pct, have: (x.community && x.community.have) || 0, discogs: true,
      });
    }
    out.sort((a, b) => b.pct - a.pct || b.have - a.have);
    return out.slice(0, 40);
  }, 6 * 3600e3);
}

async function handleSearch(q, opts) {
  const input = await resolveInput(q);
  const seed = await findSeed(input);
  if (!seed) {
    return { input, seed: null, code: 'notfound', error: 'Δεν βρέθηκε το τραγούδι στο Deezer. Δοκίμασε "Καλλιτέχνης - Τίτλος".' };
  }
  const rg = await resolveGenre(opts.genre, seed);
  opts = { ...opts, genre: rg.genre, house: rg.genre !== 'any' };
  if (rg.seedGenre) { seed.genre = rg.seedGenre.genre; seed.genreSure = rg.seedGenre.sure; seed.genreNote = rg.seedGenre.note; }
  seed.genreKey = rg.seedKey;
  const [sim, versions, same, dc] = await Promise.all([
    similar(seed, opts).catch(() => ({ list: [], houseFilter: false })),
    findVersions(seed, input, opts).then((l) => genreFilter(l, opts.genre)).catch(() => []),
    sameArtist(seed, opts).then((l) => genreFilter(l, opts.genre)).catch(() => []),
    discogsSimilar(seed, opts.genre).catch((e) => { console.log('discogs error', e.message); return []; }),
  ]);
  return {
    input, seed,
    similar: sim.list, versions, sameArtist: same, discogs: dc, discogsEnabled: !!DISCOGS,
    lastfm: !!LASTFM, houseFilter: sim.houseFilter, genre: opts.genre, seedGenreKey: rg.seedKey, minDur: opts.minDur, bpmEnabled: !!(GSB || LASTFM),
  };
}

/* ---------- Πλήρες κομμάτι: βρίσκει βίντεο στο YouTube ---------- */
const YTKEY = (process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY || '').trim();
console.log('YouTube key loaded:', !!YTKEY, '| env names:', Object.keys(process.env).filter((k) => /API|KEY/i.test(k)).join(','));
const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee'];
async function ytFind(artist, title, why) {
  const q = `${artist} ${title}`.replace(/\s+/g, ' ').trim();
  return cached('yt:' + q.toLowerCase(), async () => {
    // 1) Επίσημο YouTube API (αν υπάρχει key)
    if (YTKEY) {
      try {
        const j = await getJSON('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&videoEmbeddable=true&q=' + encodeURIComponent(q + ' extended') + '&key=' + YTKEY);
        const it = (j.items || []).find((x) => x.id && x.id.videoId);
        if (it) return it.id.videoId;
      } catch (e) { if (why) why.push('api:' + e.message.slice(0, 60)); }
    }
    // 2) Piped (ανοιχτά instances)
    for (const base of PIPED) {
      try {
        const j = await getJSON(base + '/search?q=' + encodeURIComponent(q + ' extended') + '&filter=videos');
        const it = (j.items || []).find((x) => x.url && /watch\?v=/.test(x.url) && x.duration > 240);
        if (it) return it.url.split('v=')[1].slice(0, 11);
      } catch (e) { if (why) why.push('piped:' + e.message.slice(0, 40)); }
    }
    // 3) Σελίδα αναζήτησης YouTube
    try {
      const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q + ' extended') + '&hl=en', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
        signal: AbortSignal.timeout(10000),
      });
      const html = await r.text();
      const m = /"videoId":"([\w-]{11})"/.exec(html);
      if (m) return m[1];
      if (why) why.push('yt:status ' + r.status + ' len ' + html.length);
    } catch (e) { if (why) why.push('yt:' + e.message.slice(0, 40)); }
    return null;
  }, 7 * 864e5);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/audio') {
    try {
      const src = new URL(u.searchParams.get('u') || '');
      if (src.protocol !== 'https:' || !/(^|\.)dzcdn\.net$/.test(src.hostname)) { res.statusCode = 400; return res.end('bad url'); }
      // Deezer: απαγορεύεται η αποθήκευση ήχου. Το preview περνάει κατευθείαν στον browser (για τον mixer),
      // χωρίς να κρατιέται στον server και χωρίς cache στον browser.
      const r = await fetch(src.href, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 3e6) throw new Error('too big');
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    } catch (_) { res.statusCode = 502; return res.end('audio unavailable'); }
  }
  if (u.pathname === '/api/yt') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const why = [];
      const id = await ytFind(u.searchParams.get('artist') || '', u.searchParams.get('title') || '', why);
      return res.end(JSON.stringify(u.searchParams.get('debug') ? { id, why, key: !!YTKEY, envNames: Object.keys(process.env).filter((k) => /API|KEY/i.test(k)), v: 3 } : { id }));
    } catch (_) { return res.end(JSON.stringify({ id: null })); }
  }
  if (u.pathname === '/api/info' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = (body.tracks || []).slice(0, 20);
      const info = {};
      if (GSB || LASTFM) {
        const r = await pmap(list, async (t) => {
          const bk = await trackInfo(t.artist, t.title);
          const gi = await genreInfo(t.artist, t.title, bk && bk.bpm);
          return { id: t.id, info: bk || gi.genre ? { ...(bk || {}), genre: gi.genre || '', genreSure: gi.sure, genreNote: gi.note } : null };
        }, 4, 300);
        for (const x of r) if (x && x.info) info[x.id] = x.info;
      }
      return res.end(JSON.stringify({ enabled: !!(GSB || LASTFM), info }));
    } catch (_) {
      return res.end(JSON.stringify({ enabled: !!(GSB || LASTFM), info: {} }));
    }
  }
  if (u.pathname === '/api/set') {
    const q = (u.searchParams.get('q') || '').trim();
    const role = ['open', 'peak', 'close'].includes(u.searchParams.get('role')) ? u.searchParams.get('role') : 'peak';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Γράψε τίτλο ή link.' })); }
    try {
      const minutes = [60, 90, 120].includes(Number(u.searchParams.get('len'))) ? Number(u.searchParams.get('len')) : 120;
      const g = [...GENRE_KEYS, 'auto'].includes(u.searchParams.get('genre')) ? u.searchParams.get('genre') : 'auto';
      return res.end(JSON.stringify(await handleSet(q, role, minutes, g)));
    } catch (e) {
      return res.end(JSON.stringify({ error: e.message || 'Κάτι πήγε στραβά.', code: e.code || 'generic' }));
    }
  }
  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim();
    const opts = {
      minDur: Math.max(0, Number(u.searchParams.get('min') ?? 300) || 0),
      genre: [...GENRE_KEYS, 'auto'].includes(u.searchParams.get('genre')) ? u.searchParams.get('genre') : 'auto',
    };
    opts.house = opts.genre !== 'any' && u.searchParams.get('house') !== '0';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Γράψε τίτλο ή link.' })); }
    try {
      res.end(JSON.stringify(await handleSearch(q, opts)));
    } catch (e) {
      res.statusCode = 200;
      res.end(JSON.stringify({ error: e.message || 'Κάτι πήγε στραβά.', code: e.code || 'generic' }));
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
