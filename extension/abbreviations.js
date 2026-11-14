// Abbreviations that Kokoro's G2P (misaki) reads literally ("Nov." as "nahv", "ft." as "F-T"),
// expanded before the text goes to the server. Each entry only fires in a context that makes it
// unambiguous, e.g. "Mt." becomes "Mount" only before a capitalized word ("Mt. Everest").
// Runs after custom pronunciations, so a user's own pronunciation for a phrase always wins.
//
// Entry: { id, abbr, expansion, plural?, when, optionalDot? }. `plural` is used after any number but
// 1 ("5 ft." -> "5 feet", "1 ft." / "a 6-ft. fence" -> "foot"). `optionalDot` also matches the
// abbreviation without its period ("Nov 12").
//
// Saved state: { custom: [entry], edits: { builtinId: entry }, disabled: [id], removed: [builtinId] }.
// Built-ins live in code and the state only records changes, so "Restore Built-ins" just clears them
// and built-ins added in later versions show up on their own.

const KEY = 'abbreviations';
const FORMAT = 'orotone-abbreviations';

export const CONTEXTS = {
  'always': 'Always',
  'before-number': 'Before a number',
  'after-number': 'After a number',
  'before-name': 'Before a capitalized word',
  'after-name': 'After a capitalized word',
};

const b = (id, abbr, expansion, when, extra = {}) => ({ id, abbr, expansion, when, ...extra });
const month = (abbr, expansion) => b(`month-${abbr.toLowerCase()}`, `${abbr}.`, expansion, 'before-number', { optionalDot: true });
const unit = (id, abbr, singular, plural, optionalDot = true) => b(id, abbr, singular, 'after-number', { plural, optionalDot });

// Only abbreviations misaki gets wrong. "No.", "Mrs.", "vs.", "e.g." and "lbs" it already reads well.
export const BUILTIN_ABBREVIATIONS = [
  // "Nov 12" without the period too; "Mar" and "Jan" alone stay words and names
  month('Jan', 'January'), month('Feb', 'February'), month('Mar', 'March'), month('Apr', 'April'),
  month('Jun', 'June'), month('Jul', 'July'), month('Aug', 'August'), month('Sep', 'September'),
  month('Sept', 'September'), month('Oct', 'October'), month('Nov', 'November'), month('Dec', 'December'),

  b('saint', 'St.', 'Saint', 'before-name'),
  b('street', 'St.', 'Street', 'after-name'),
  b('avenue', 'Ave.', 'Avenue', 'always'),
  b('boulevard', 'Blvd.', 'Boulevard', 'always'),
  b('road', 'Rd.', 'Road', 'after-name'),
  b('drive', 'Dr.', 'Drive', 'after-name'), // misaki always says "doctor"; Doctor before a name below
  b('lane', 'Ln.', 'Lane', 'after-name'),
  b('court', 'Ct.', 'Court', 'after-name'),
  b('place', 'Pl.', 'Place', 'after-name'),
  b('square', 'Sq.', 'Square', 'after-name'),
  b('terrace', 'Ter.', 'Terrace', 'after-name'),
  b('circle', 'Cir.', 'Circle', 'after-name'),
  b('point', 'Pt.', 'Point', 'after-name'),
  b('highway', 'Hwy.', 'Highway', 'always'),
  b('parkway', 'Pkwy.', 'Parkway', 'always'),
  b('mount', 'Mt.', 'Mount', 'before-name'),
  b('fort', 'Ft.', 'Fort', 'before-name'),

  b('doctor', 'Dr.', 'Doctor', 'before-name'),
  b('junior', 'Jr.', 'Junior', 'always'),
  b('senior', 'Sr.', 'Senior', 'always'),
  b('governor', 'Gov.', 'Governor', 'before-name'),
  b('senator', 'Sen.', 'Senator', 'before-name'),
  b('representative', 'Rep.', 'Representative', 'before-name'),
  b('general', 'Gen.', 'General', 'before-name'),
  b('captain', 'Capt.', 'Captain', 'before-name'),
  b('lieutenant', 'Lt.', 'Lieutenant', 'before-name'),
  b('sergeant', 'Sgt.', 'Sergeant', 'before-name'),
  b('professor', 'Prof.', 'Professor', 'before-name'),

  b('incorporated', 'Inc.', 'Incorporated', 'always'),
  b('limited', 'Ltd.', 'Limited', 'always'),
  b('department', 'Dept.', 'Department', 'always'),
  b('university', 'Univ.', 'University', 'always'),
  b('approximately', 'approx.', 'approximately', 'always'),

  b('volume', 'vol.', 'volume', 'before-number'),
  b('chapter', 'ch.', 'chapter', 'before-number'),
  b('figure', 'fig.', 'figure', 'before-number'),
  b('pages', 'pp.', 'pages', 'before-number'),

  unit('square-feet', 'sq. ft.', 'square foot', 'square feet'),
  unit('feet', 'ft.', 'foot', 'feet'),
  unit('inches', 'in.', 'inch', 'inches', false), // "5 in a row" must stay a word
  unit('miles', 'mi.', 'mile', 'miles'),
  unit('yards', 'yd.', 'yard', 'yards'),
  unit('millimeters', 'mm', 'millimeter', 'millimeters'),
  unit('ounces', 'oz.', 'ounce', 'ounces'),
  unit('pounds', 'lb.', 'pound', 'pounds'),
  unit('teaspoons', 'tsp.', 'teaspoon', 'teaspoons'),
  unit('gallons', 'gal.', 'gallon', 'gallons'),
  unit('quarts', 'qt.', 'quart', 'quarts'),
  unit('hour', 'hr.', 'hour', 'hours'),
  unit('hours', 'hrs.', 'hour', 'hours'),
  unit('minute', 'min.', 'minute', 'minutes'),
  unit('minutes', 'mins.', 'minute', 'minutes'),
  unit('seconds', 'sec.', 'second', 'seconds'),
];
const BUILTIN_BY_ID = new Map(BUILTIN_ABBREVIATIONS.map((e) => [e.id, e]));

const FIELDS = ['abbr', 'expansion', 'plural', 'when', 'optionalDot'];

// Keeps only the fields that describe a rule, trimmed, with empty optional ones dropped
export function cleanEntry(e) {
  const out = { abbr: String(e.abbr ?? '').trim(), expansion: String(e.expansion ?? '').trim(), when: e.when in CONTEXTS ? e.when : 'always' };
  const plural = String(e.plural ?? '').trim();
  if (plural && out.when === 'after-number') out.plural = plural;
  if (e.optionalDot && out.abbr.endsWith('.')) out.optionalDot = true;
  return out;
}

const sameRule = (a, b) => FIELDS.every((f) => (a[f] || '') === (b[f] || ''));
const keyOf = (e) => `${e.abbr.trim()}\u0000${e.when}`;

export const isUsableAbbreviation = (e) => !!e.abbr?.trim() && !!e.expansion?.trim() && e.when in CONTEXTS;

export async function loadAbbreviations() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  return { custom: s?.custom ?? [], edits: s?.edits ?? {}, disabled: s?.disabled ?? [], removed: s?.removed ?? [] };
}

export function saveAbbreviations(state) {
  const { custom, edits, disabled, removed } = state;
  return chrome.storage.local.set({ [KEY]: { custom, edits, disabled, removed } });
}

// Every entry as the user currently sees it:
// { ...rule, id, builtin, edited, enabled }, built-ins in their original order, then custom ones
export function listAbbreviations(state) {
  const builtins = BUILTIN_ABBREVIATIONS.filter((e) => !state.removed.includes(e.id)).map((e) => {
    const edit = state.edits[e.id];
    return { ...cleanEntry(edit ?? e), id: e.id, builtin: true, edited: !!edit, enabled: !state.disabled.includes(e.id) };
  });
  const custom = state.custom.map((e) => ({ ...cleanEntry(e), id: e.id, builtin: false, edited: false, enabled: !state.disabled.includes(e.id) }));
  return [...builtins, ...custom];
}

export const activeCount = (state) => listAbbreviations(state).filter((e) => e.enabled && isUsableAbbreviation(e)).length;

export const defaultFor = (id) => BUILTIN_BY_ID.get(id);

// Saves an entry, new or existing. An edit that matches the built-in's default clears the edit.
export function putAbbreviation(state, entry) {
  const rule = cleanEntry(entry);
  const builtin = BUILTIN_BY_ID.get(entry.id);
  if (builtin) {
    const edits = { ...state.edits };
    if (sameRule(rule, cleanEntry(builtin))) delete edits[entry.id];
    else edits[entry.id] = rule;
    return { ...state, edits };
  }
  const id = entry.id ?? crypto.randomUUID();
  // A custom entry with the same abbreviation and context replaces the old one
  const custom = state.custom.filter((e) => e.id !== id && keyOf(e) !== keyOf(rule));
  return { ...state, custom: [...custom, { id, ...rule }] };
}

export function removeAbbreviation(state, id) {
  const disabled = state.disabled.filter((x) => x !== id);
  if (BUILTIN_BY_ID.has(id)) {
    const edits = { ...state.edits };
    delete edits[id];
    return { ...state, edits, disabled, removed: [...state.removed, id] };
  }
  return { ...state, disabled, custom: state.custom.filter((e) => e.id !== id) };
}

export function setEnabled(state, id, enabled) {
  const disabled = state.disabled.filter((x) => x !== id);
  return { ...state, disabled: enabled ? disabled : [...disabled, id] };
}

export function restoreDefault(state, id) {
  const edits = { ...state.edits };
  delete edits[id];
  return { ...state, edits };
}

// Built-ins that were edited, switched off or deleted
export const builtinChanges = (state) =>
  new Set([...Object.keys(state.edits), ...state.removed, ...state.disabled.filter((id) => BUILTIN_BY_ID.has(id))]).size;

export function restoreBuiltins(state) {
  return { ...state, edits: {}, removed: [], disabled: state.disabled.filter((id) => !BUILTIN_BY_ID.has(id)) };
}

export function exportAbbreviations(state) {
  const entries = listAbbreviations(state).map(({ id, builtin, edited, ...rest }) => rest);
  return JSON.stringify({ format: FORMAT, version: 1, entries }, null, 2);
}

// Merges a file in. An entry with the same abbreviation and context as a built-in becomes an edit
// of that built-in (and brings it back if it was deleted); others add or replace custom entries.
// Returns { state, added, replaced, skipped }.
export function importAbbreviations(json, state) {
  const data = JSON.parse(json);
  const raw = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(raw) || (data?.format && data.format !== FORMAT)) throw new Error('Not an Orotone abbreviations file.');
  let added = 0, replaced = 0, skipped = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !(item.when in CONTEXTS)) { skipped++; continue; }
    const rule = cleanEntry(item);
    if (!isUsableAbbreviation(rule)) { skipped++; continue; }
    const current = listAbbreviations(state);
    const builtin = current.find((e) => e.builtin && keyOf(e) === keyOf(rule))
      ?? BUILTIN_ABBREVIATIONS.find((e) => keyOf(e) === keyOf(rule));
    const existing = builtin ?? current.find((e) => !e.builtin && keyOf(e) === keyOf(rule));
    if (builtin) state = { ...state, removed: state.removed.filter((id) => id !== builtin.id) };
    state = putAbbreviation(state, { ...rule, id: existing?.id });
    const id = existing?.id ?? state.custom.at(-1).id;
    state = setEnabled(state, id, item.enabled !== false);
    if (existing && current.some((e) => e.id === existing.id)) replaced++; else added++;
  }
  return { state, added, replaced, skipped };
}

// ---------- sentence splitting ----------

// Capitalized words that start sentences far more often than they follow "St." or "Dr." as a name,
// so "Paul St. Then we left" reads Street and ends the sentence there
const STARTERS = ['The', 'Then', 'This', 'That', 'These', 'Those', 'There', 'It', 'Its', 'I', 'We', 'He', 'She',
  'They', 'You', 'A', 'An', 'But', 'And', 'So', 'In', 'On', 'At', 'After', 'Before', 'When', 'If', 'Our', 'His',
  'Her', 'My', 'Their', 'Your'];
const STARTER_RE = new RegExp(`^\\s*(?:${STARTERS.join('|')})(?![\\p{L}\\p{N}])`, 'u');

// Titles misaki already reads well, but that still end a "sentence" for Intl.Segmenter
const TITLES = ['Mr.', 'Mrs.', 'Ms.', 'Mx.'];
const LAST_WORD_RE = /(?:^|\s)[("'“‘\[]*(\S+\.)\s*$/u;

// Intl.Segmenter ends a sentence at "Oct." in "Oct. 24" and at "Dr." in "Dr. Smith", which reads
// "24" and "Smith" as sentences of their own, out of reach of the rules above. Rejoin a piece to the
// next when the period clearly isn't a full stop: the next piece starts with a number or a lowercase
// letter, or the word is an abbreviation that comes before names (any such entry, even if off).
export function joinSentences(pieces, state) {
  const names = new Set([...TITLES, ...listAbbreviations(state).filter((e) => e.when === 'before-name').map((e) => e.abbr)]);
  const out = [];
  for (const piece of pieces) {
    const prev = out.at(-1);
    const word = prev && LAST_WORD_RE.exec(prev)?.[1];
    const join = word && (/^\s*[\p{Ll}\p{N}]/u.test(piece) || (names.has(word) && !STARTER_RE.test(piece)));
    if (join) out[out.length - 1] = prev + piece;
    else out.push(piece);
  }
  return out;
}

// ---------- matching ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Context entries run first, so "St. Paul St." becomes "Saint Paul Street" and "Visit St. Paul"
// prefers Saint over Street. Longer abbreviations go first, so "sq. ft." wins over "ft.".
const PRIORITY = ['before-number', 'after-number', 'before-name', 'after-name', 'always'];

function compile(entry) {
  const { abbr, expansion, plural, when, optionalDot } = cleanEntry(entry);
  const dotted = abbr.endsWith('.');
  let body = escapeRe(abbr).replace(/\s+/g, '\\s*'); // "sq. ft." also matches "sq.ft."
  if (dotted && optionalDot) body = `${escapeRe(abbr.slice(0, -1)).replace(/\s+/g, '\\s*')}\\.?`;
  const start = '(?<![\\p{L}\\p{N}_.])';
  const end = dotted && !optionalDot ? '' : '(?![\\p{L}\\p{N}_])';
  const before = {
    // The number and what separates it are captured, for "1 ft." and "6-ft. fence" (singular)
    'after-number': '(?<=(?<![\\d.,])(?<num>\\d[\\d,]*(?:\\.\\d+)?)(?<sep>\\s*-?\\s*))',
    'after-name': "(?<=\\p{Lu}[\\p{L}'’-]*\\s+)",
  }[when] ?? '';
  const after = {
    'before-number': '(?=\\s+\\d)',
    'before-name': `(?=\\s+(?!(?:${STARTERS.join('|')})(?![\\p{L}\\p{N}]))\\p{Lu})`,
  }[when] ?? '';
  return { re: new RegExp(`${before}${start}${body}${end}${after}`, 'gu'), expansion, plural };
}

// The compiled rules for a saved state, in the order they should run
export function activeRules(state) {
  const rank = (e) => PRIORITY.indexOf(e.when) * 1000 - e.abbr.length;
  const on = listAbbreviations(state).filter((e) => e.enabled && isUsableAbbreviation(e));
  const custom = on.filter((e) => !e.builtin).sort((a, b) => rank(a) - rank(b));
  const builtin = on.filter((e) => e.builtin).sort((a, b) => rank(a) - rank(b));
  return [...custom, ...builtin].map(compile);
}

// Inline overrides such as [Orotone](/ˈɔɹətˌOn/) are passed through untouched
const OVERRIDE_RE = /(\[[^\]]*\]\(\/[^)]*\/\))/;

export function expandAbbreviations(text, rules) {
  if (!rules.length) return text;
  const parts = text.split(OVERRIDE_RE); // odd indexes are the overrides
  for (let i = 0; i < parts.length; i += 2) {
    for (const { re, expansion, plural } of rules) {
      parts[i] = parts[i].replace(re, (match, ...args) => {
        const groups = typeof args.at(-1) === 'object' ? args.at(-1) : null;
        const whole = groups ? args.at(-2) : args.at(-1);
        const offset = groups ? args.at(-3) : args.at(-2);
        const singular = !groups?.num || groups.num === '1' || groups.sep.includes('-');
        const word = plural && !singular ? plural : expansion;
        // The period is dropped mid-sentence ("Nov. 12" would pause like a full stop), but kept
        // when the abbreviation ends the sentence ("on Elm Ave.")
        const ends = match.endsWith('.') && i === parts.length - 1 && /^["'”’)\]]*\s*$/.test(whole.slice(offset + match.length));
        return ends ? `${word}.` : word;
      });
    }
  }
  return parts.join('');
}

const SAMPLE = {
  'always': (a) => [a],
  'before-number': (a) => [`${a} 12`],
  'after-number': (a) => [`5 ${a}`, `1 ${a}`],
  'before-name': (a) => [`${a} Smith`],
  'after-name': (a) => [`Elm ${a}`],
};

// Examples of an entry in use, for the editor: [["5 ft.", "5 feet"], ["1 ft.", "1 foot"]]
export function examplesFor(entry) {
  const rule = cleanEntry(entry);
  const samples = SAMPLE[rule.when](rule.abbr);
  if (!rule.plural) samples.splice(1);
  return samples.map((s) => [s, expandAbbreviations(`${s} x`, [compile(rule)]).slice(0, -2)]);
}
