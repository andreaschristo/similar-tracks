// Similar Tracks – απλός server χωρίς εξαρτήσεις (χρειάζεται Node 18+)
// Εκκίνηση:  node server.js   →   http://localhost:3000
// Για φίλτρο είδους (house) χρειάζεται δωρεάν LASTFM_API_KEY.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LASTFM = process.env.LASTFM_API_KEY || '';
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
    const decoded = t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"');
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
const passLen = (t, minDur) => !minDur || (t.duration >= minDur && !isRadio(t.title));

// ---------- Είδος μέσω Last.fm tags (αν υπάρχει key) ----------
const REJECT_RE = /(techno|trance|dubstep|drum and bass|dnb|hardstyle|hardcore|\bpop\b|rock|hip.?hop|\brap\b|metal|big room|electro house|future house|trap|\bedm\b|reggaeton|latin)/;
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
  const d = await lf('track.getsimilar', { artist, track: baseTitle(title), limit: '25' });
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
      lfList = ((d.similarartists && d.similarartists.artist) || []).map((a) => ({ id: null, name: a.name }));
    } catch (_) {}
  }
  // εναλλάξ Last.fm / Deezer, χωρίς διπλότυπα
  const out = [];
  for (let i = 0; i < Math.max(dzList.length, lfList.length); i++) {
    for (const a of [lfList[i], dzList[i]]) {
      if (a && !names.has(norm(a.name))) { names.add(norm(a.name)); out.push({ ...a }); }
    }
  }
  return out.slice(0, 30);
}

async function similar(seed, opts) {
  const { minDur, house } = opts;
  const useHouse = house && !!LASTFM;

  const [lfTracks, pool] = await Promise.all([
    lastfmSimilar(seed.artist, seed.title).catch(() => []),
    artistPool(seed).catch(() => []),
  ]);

  // Τι είδος είναι κάθε καλλιτέχνης (house / ουδέτερο / όχι house)
  const kinds = {};
  if (useHouse) {
    const names = [...new Set([...lfTracks.map((t) => t.artist), ...pool.map((a) => a.name)])].slice(0, 45);
    await pmap(names, async (n) => { kinds[norm(n)] = await artistKind(n); }, 6, 250);
  }
  const kind = (n) => kinds[norm(n)] || 'neutral';
  const ok = (t) => passLen(t, minDur) && !(useHouse && kind(t.artist) === 'reject');
  const houseBonus = (n) => (useHouse && kind(n) === 'house' ? 0.3 : 0);

  const cands = [];
  for (const t of lfTracks) {
    if (ok(t)) cands.push({ ...t, score: 0.6 + 0.8 * (t.match || 0) + houseBonus(t.artist) + lenScore(t) });
  }

  const usable = pool.filter((a) => !(useHouse && kind(a.name) === 'reject')).slice(0, 16);
  const tops = await pmap(usable, async (a, i) => {
    if (!a.id) {
      const r = await resolveDzArtist(a.name);
      if (!r) return [];
      a.id = r.id;
    }
    const top = await dzTop(a.id);
    return top.filter(ok).map((t) => ({
      ...t,
      score: (1 - i / usable.length) * 0.6 + houseBonus(a.name) + lenScore(t),
    }));
  }, 4, 500);
  for (const arr of tops) if (arr) cands.push(...arr);

  cands.sort((a, b) => b.score - a.score);
  const seen = new Set([norm(seed.artist) + '|' + norm(baseTitle(seed.title))]);
  const perArtist = {};
  const out = [];
  for (const t of cands) {
    const k = norm(t.artist) + '|' + norm(baseTitle(t.title));
    const a = norm(t.artist);
    if (seen.has(k) || (perArtist[a] || 0) >= 3) continue;
    seen.add(k);
    perArtist[a] = (perArtist[a] || 0) + 1;
    out.push(t);
    if (out.length >= 40) break;
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
// Ενέργεια ανά θέση: σταδιακή άνοδος, κορυφή στη μέση, ήπια πτώση στο τέλος
const ARC = [0, 0.15, 0.35, 0.55, 0.75, 0.95, 1, 0.9, 0.55, 0.25];
const SECTION = ['intro', 'intro', 'build', 'build', 'build', 'peak', 'peak', 'peak', 'outro', 'outro'];
const SLOT_OF_ROLE = { open: 0, peak: 6, close: 9 };
const BLEND_SEC = 60; // μέση επικάλυψη ανά μετάβαση

async function buildSet(seed, pool, role) {
  const N = 10;
  const slot = SLOT_OF_ROLE[role] ?? 6;
  const seen = new Set([norm(seed.artist) + '|' + norm(baseTitle(seed.title))]);
  const cands = [];
  for (const t of pool) {
    const k = norm(t.artist) + '|' + norm(baseTitle(t.title));
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push({ ...t });
    if (cands.length >= 32) break;
  }

  // BPM + tonality για το seed και τους υποψήφιους
  const infos = await pmap([seed, ...cands], (t) => trackInfo(t.artist, t.title), 4, 300);
  seed.info = infos[0] || null;
  cands.forEach((t, i) => { t.info = infos[i + 1] || null; });

  const sBpm = seed.info && seed.info.bpm;
  const known = cands.filter((t) => t.info && t.info.bpm).length;
  const useBpm = !!sBpm && known >= 6;

  let pickable = cands;
  let target = () => 0;
  if (useBpm) {
    // κράτα όσα είναι σε λογικό εύρος γύρω από το seed (±8%) ή δεν έχουν BPM
    pickable = cands.filter((t) => !(t.info && t.info.bpm) || Math.abs(t.info.bpm - sBpm) / sBpm <= 0.08);
    const span = 0.06;
    const low = sBpm / (1 + span * ARC[slot]);
    target = (i) => low * (1 + span * ARC[i]);
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
  picked.forEach((t, i) => { if (t) items.push({ t, section: SECTION[i], isSeed: i === slot }); });
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
      duration: t.duration || 0, section, isSeed,
      bpm: (t.info && t.info.bpm) || 0, key: (t.info && t.info.key) || '', camelot: (t.info && t.info.camelot) || '',
      transition,
    };
  });
  const totalSec = set.reduce((a, x) => a + x.duration, 0);
  const mixedSec = Math.max(0, totalSec - Math.max(0, set.length - 1) * BLEND_SEC);
  return { set, totalSec, mixedSec, bpmUsed: useBpm };
}

// ---------- API ----------
async function handleSet(q, role) {
  const input = await resolveInput(q);
  const seed = await findSeed(input);
  if (!seed) return { error: 'Δεν βρέθηκε το τραγούδι στο Deezer.', code: 'notfound' };
  const opts = { minDur: 300, house: true };
  const [sim, same] = await Promise.all([
    similar(seed, opts).catch(() => ({ list: [], houseFilter: false })),
    sameArtist(seed, opts).catch(() => []),
  ]);
  const built = await buildSet(seed, [...sim.list, ...same.slice(0, 6)], role);
  return { seed, role, bpmEnabled: !!GSB, houseFilter: sim.houseFilter, ...built };
}

async function handleSearch(q, opts) {
  const input = await resolveInput(q);
  const seed = await findSeed(input);
  if (!seed) {
    return { input, seed: null, code: 'notfound', error: 'Δεν βρέθηκε το τραγούδι στο Deezer. Δοκίμασε "Καλλιτέχνης - Τίτλος".' };
  }
  const [sim, versions, same] = await Promise.all([
    similar(seed, opts).catch(() => ({ list: [], houseFilter: false })),
    findVersions(seed, input, opts).catch(() => []),
    sameArtist(seed, opts).catch(() => []),
  ]);
  return {
    input, seed,
    similar: sim.list, versions, sameArtist: same,
    lastfm: !!LASTFM, houseFilter: sim.houseFilter, minDur: opts.minDur, bpmEnabled: !!GSB,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/info' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = (body.tracks || []).slice(0, 20);
      const info = {};
      if (GSB) {
        const r = await pmap(list, async (t) => ({ id: t.id, info: await trackInfo(t.artist, t.title) }), 4, 300);
        for (const x of r) if (x && x.info) info[x.id] = x.info;
      }
      return res.end(JSON.stringify({ enabled: !!GSB, info }));
    } catch (_) {
      return res.end(JSON.stringify({ enabled: !!GSB, info: {} }));
    }
  }
  if (u.pathname === '/api/set') {
    const q = (u.searchParams.get('q') || '').trim();
    const role = ['open', 'peak', 'close'].includes(u.searchParams.get('role')) ? u.searchParams.get('role') : 'peak';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Γράψε τίτλο ή link.' })); }
    try {
      return res.end(JSON.stringify(await handleSet(q, role)));
    } catch (e) {
      return res.end(JSON.stringify({ error: e.message || 'Κάτι πήγε στραβά.', code: e.code || 'generic' }));
    }
  }
  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim();
    const opts = {
      minDur: Math.max(0, Number(u.searchParams.get('min') ?? 300) || 0),
      house: u.searchParams.get('house') !== '0',
    };
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
