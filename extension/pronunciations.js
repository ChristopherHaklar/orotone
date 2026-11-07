// Custom pronunciations: { id, phrase, lang: 'en' | 'ja', soundsLike, phonemes, ignoreCase }.
// English entries are sent as Kokoro/misaki inline overrides ("[Paroli](/pɑɹˈOli/)"); Japanese has no
// such syntax, so a Japanese entry's reading (soundsLike, in kana) simply replaces the phrase.

const KEY = 'pronunciations';
const PLACEHOLDER = 0xe000; // private-use range, so replaced spans can't be matched again
const PUA_RE = /[-]/g;

export const PHONEME_FORBIDDEN = /[[\]()/]/;

export async function loadPronunciations() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return list;
}

export function savePronunciations(list) {
  return chrome.storage.local.set({ [KEY]: list });
}

// Portable file format, so lists can move between browsers, profiles and other clients
export function exportPronunciations(list) {
  const entries = list.map(({ phrase, lang, soundsLike, phonemes, ignoreCase }) =>
    ({ phrase, lang, soundsLike, phonemes, ignoreCase }));
  return JSON.stringify({ format: 'paroli-pronunciations', version: 1, entries }, null, 2);
}

// Parses an export (or a bare array of entries) and merges it in: imported entries replace
// existing ones with the same phrase and language. Returns { list, added, replaced, skipped }.
export function importPronunciations(json, existing) {
  const data = JSON.parse(json);
  const raw = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(raw)) throw new Error('Not a Paroli pronunciations file.');
  const key = (e) => `${e.lang}\u0000${e.phrase.trim().toLowerCase()}`;
  const byKey = new Map(existing.map((e) => [key(e), e]));
  let added = 0, replaced = 0, skipped = 0;
  for (const item of raw) {
    const entry = {
      phrase: String(item?.phrase ?? '').trim(),
      lang: item?.lang === 'ja' ? 'ja' : 'en',
      soundsLike: String(item?.soundsLike ?? '').trim(),
      phonemes: item?.lang === 'ja' ? '' : String(item?.phonemes ?? '').trim(),
      ignoreCase: item?.ignoreCase !== false,
    };
    if (!isUsable(entry) || PHONEME_FORBIDDEN.test(entry.phonemes)) { skipped++; continue; }
    const old = byKey.get(key(entry));
    entry.id = old?.id ?? crypto.randomUUID();
    if (old) replaced++; else added++;
    byKey.set(key(entry), entry);
  }
  return { list: [...byKey.values()], added, replaced, skipped };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(entry) {
  const body = escapeRe(entry.phrase.trim()).replace(/\s+/g, '\\s+');
  // Japanese has no spaces between words, so match anywhere; English matches whole words only
  if (entry.lang === 'ja') return new RegExp(body, 'gu');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, entry.ignoreCase ? 'giu' : 'gu');
}

export function isUsable(entry) {
  if (!entry.phrase?.trim()) return false;
  return entry.lang === 'ja' ? !!entry.soundsLike?.trim() : !!entry.phonemes?.trim();
}

// Rewrites text for the server. `langs` is the set of languages the current voice speaks.
export function applyPronunciations(text, entries, langs) {
  const active = entries
    .filter((e) => langs.has(e.lang) && isUsable(e))
    .sort((a, b) => b.phrase.trim().length - a.phrase.trim().length); // longest phrase wins
  if (!active.length) return text;
  const out = [];
  text = text.replace(PUA_RE, '');
  for (const entry of active) {
    text = text.replace(matcher(entry), (match) => {
      out.push(entry.lang === 'ja'
        ? entry.soundsLike.trim()
        : `[${match.replace(/[[\]]/g, '')}](/${entry.phonemes.trim()}/)`);
      return String.fromCharCode(PLACEHOLDER + out.length - 1);
    });
  }
  return text.replace(PUA_RE, (c) => out[c.charCodeAt(0) - PLACEHOLDER]);
}

// Input that previews one entry on its own
export function previewInput(entry, phonemes = entry.phonemes) {
  const phrase = entry.phrase.trim();
  if (entry.lang === 'ja') return entry.soundsLike?.trim() || phrase;
  return phonemes?.trim() ? `[${phrase.replace(/[[\]]/g, '')}](/${phonemes.trim()}/)` : phrase;
}
