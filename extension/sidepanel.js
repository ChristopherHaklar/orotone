import { getSelectionText } from './selection.js';
import {
  CONTEXTS, activeCount, activeRules, builtinChanges, cleanEntry, defaultFor, examplesFor, expandAbbreviations,
  exportAbbreviations, importAbbreviations, isUsableAbbreviation, joinSentences, listAbbreviations, loadAbbreviations, ordinalDates,
  putAbbreviation, removeAbbreviation, restoreBuiltins, restoreDefault, saveAbbreviations, setEnabled,
} from './abbreviations.js';
import {
  applyPronunciations, loadPronunciations, savePronunciations, previewInput, isUsable, PHONEME_FORBIDDEN,
  exportPronunciations, importPronunciations,
} from './pronunciations.js';

const DEFAULTS = { server: 'http://localhost:8000/v1', voice: 'af_heart', speed: 1.5, follow: true, usePronunciations: true, expandAbbreviations: true, ordinalDates: true };
const FALLBACK_VOICES = [
  { voice: 'af_heart', lang: 'en-US' },
  { voice: 'jf_alpha', lang: 'ja-JP' },
  { voice: 'mix', lang: 'en-US', description: 'Auto-detect EN/JA' },
];
const AHEAD = 3;          // sentences to prefetch past the current one
const KEEP_BEHIND = 2;    // decoded sentences kept for quick "previous"
const SENTENCE_GAP = 0.15;
const PARAGRAPH_GAP = 0.4;
const MAX_CHUNK = 300;    // long sentences are split at clause boundaries to keep latency low
const JA_RE = /[　-ヿ一-鿿＀-￯]/;
const EN_RE = /[A-Za-z]/;

const $ = (id) => document.getElementById(id);
const el = {
  play: $('play'), prev: $('prev'), next: $('next'), stop: $('stop'),
  status: $('status'), lang: $('lang'), seek: $('seek'), count: $('count'), error: $('error'), errorText: $('error-text'), errorSettings: $('error-settings'),
  empty: $('empty'), doc: $('doc'), paste: $('paste'),
  voice: $('voice'), speed: $('speed'), speedValue: $('speed-value'), follow: $('follow'),
  settings: $('settings'), server: $('server'), serverResult: $('server-result'),
};

let settings = { ...DEFAULTS };
let voices = FALLBACK_VOICES;
let pronunciations = [];
let abbreviations = { custom: [], edits: {}, disabled: [], removed: [] };
let abbrRules = [];
let sentences = [];       // { text, display, para, lang }
let spans = [];
let current = -1;
let playingIndex = -1;    // sentence whose audio is actually playing (vs. still loading)
let running = false;      // a playback chain is active (playing, loading or paused)
let paused = false;
let gen = 0;              // bumped on every jump/stop; stale async work checks it and bails
const player = new Audio();
player.preservesPitch = true; // speed changes tempo only; Kokoro's own speed param clips vowels
const cache = new Map();  // index -> { promise (resolves to a blob URL or null), controller, done, failed }

// ---------- text splitting ----------

const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

function splitLong(sentence) {
  if (sentence.length <= MAX_CHUNK) return [sentence];
  const parts = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(...[', ', '; ', ': ', '、', ' — ', ' '].map((d) => {
      const at = window.lastIndexOf(d);
      return at > MAX_CHUNK / 3 ? at + d.length : -1;
    }));
    const at = cut > 0 ? cut : MAX_CHUNK;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}

function langOf(text) {
  const ja = JA_RE.test(text);
  const en = EN_RE.test(text);
  return ja && en ? 'EN+JA' : ja ? 'JA' : 'EN';
}

function splitText(text) {
  const out = [];
  text.split(/\n+/).map((p) => p.trim()).filter(Boolean).forEach((paragraph, para) => {
    const pieces = joinSentences([...segmenter.segment(paragraph)].map((x) => x.segment), abbreviations);
    for (const segment of pieces) {
      for (const display of splitLong(segment)) {
        const text = display.trim();
        if (text) out.push({ text, display, para, lang: langOf(text) });
      }
    }
  });
  return out;
}

// ---------- audio fetching ----------

// Repackages the server's streaming WAV (sizes marked unknown) as a complete file <audio> can seek
function toWavUrl(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let sampleRate = 24000;
  let offset = 12;
  let dataStart = 44;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(arrayBuffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
    if (id === 'data') { dataStart = offset + 8; break; }
    offset += 8 + size;
  }
  const bytes = Math.floor((arrayBuffer.byteLength - dataStart) / 2) * 2;
  if (bytes <= 0) return null;
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (at, str) => [...str].forEach((c, k) => header.setUint8(at + k, c.charCodeAt(0)));
  ascii(0, 'RIFF'); header.setUint32(4, 36 + bytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true); header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true); header.setUint16(34, 16, true);
  ascii(36, 'data'); header.setUint32(40, bytes, true);
  const blob = new Blob([header, new Uint8Array(arrayBuffer, dataStart, bytes)], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

async function synthesize(input, voice, signal) {
  const res = await fetch(`${settings.server}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, voice, speed: 1 }),
    signal,
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  return toWavUrl(await res.arrayBuffer());
}

// Languages a voice speaks, used to decide which pronunciations apply to it
function langsFor(voiceId) {
  if (voiceId === 'mix') return new Set(['en', 'ja']);
  const voice = voices.find((v) => v.voice === voiceId);
  return new Set([voice?.lang?.startsWith('ja') ? 'ja' : 'en']);
}

function fetchAudio(sentence, signal) {
  const langs = langsFor(settings.voice);
  let input = settings.usePronunciations ? applyPronunciations(sentence.text, pronunciations, langs) : sentence.text;
  if (settings.expandAbbreviations && langs.has('en')) {
    input = expandAbbreviations(input, abbrRules);
    if (settings.ordinalDates) input = ordinalDates(input);
  }
  return synthesize(input, settings.voice, signal);
}

function dropEntry(entry) {
  entry.controller.abort();
  entry.promise.then((url) => url && URL.revokeObjectURL(url), () => {});
}

function startFetch(i) {
  const controller = new AbortController();
  const entry = { controller, done: false, failed: false };
  entry.promise = fetchAudio(sentences[i], controller.signal);
  entry.promise
    .catch(() => { entry.failed = true; })
    .finally(() => { entry.done = true; pump(); });
  cache.set(i, entry);
  return entry;
}

function getAudio(i) {
  let entry = cache.get(i);
  if (!entry || entry.failed) entry = startFetch(i);
  return entry.promise;
}

// Keeps one background request in flight for the nearest sentence that isn't fetched yet.
// The server serializes synthesis, so more parallelism would only delay the current sentence.
function pump() {
  if (current < 0) return;
  const lo = current - KEEP_BEHIND;
  const hi = Math.min(current + AHEAD, sentences.length - 1);
  for (const [i, entry] of cache) {
    if (i < lo || i > hi) {
      dropEntry(entry);
      cache.delete(i);
    }
  }
  if (!running) return;
  if ([...cache.values()].some((e) => !e.done)) return;
  for (let i = playingIndex === current ? current + 1 : current; i <= hi; i++) {
    if (!cache.has(i)) {
      startFetch(i);
      return;
    }
  }
}

function invalidateAudio() {
  for (const [i, entry] of cache) {
    // Keep the sentence that's playing so it can finish; everything else refetches
    if (i === playingIndex) continue;
    dropEntry(entry);
    cache.delete(i);
  }
  if (running && playingIndex !== current) playIndex(current);
  else pump();
}

// ---------- playback ----------

function stopAudio() {
  player.onended = null;
  player.pause();
}

function playCurrent() {
  player.play().catch((err) => {
    // Autoplay can be refused when no user gesture reached the panel; wait for the play button
    if (err.name === 'NotAllowedError') {
      paused = true;
      updateUI();
    }
  });
}

function gapAfter(i) {
  if (i + 1 >= sentences.length) return 0;
  return sentences[i + 1].para !== sentences[i].para ? PARAGRAPH_GAP : SENTENCE_GAP;
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function playIndex(i, delay = 0) {
  const token = ++gen;
  stopAudio();
  playingIndex = -1;
  if (i >= sentences.length) {
    running = false;
    setCurrent(sentences.length, false);
    updateUI('Finished');
    return;
  }
  running = true;
  setCurrent(i);
  setLoading(true);
  pump();

  let url;
  try {
    url = await getAudio(i);
  } catch (err) {
    if (token !== gen) return;
    stop();
    if (err.name === 'TypeError') unreachable();
    else showError(err.message);
    return;
  }
  if (token !== gen) return;
  setLoading(false);
  if (!url) {
    playIndex(i + 1);
    return;
  }

  player.src = url;
  // Loading a new src resets playbackRate to defaultPlaybackRate
  player.defaultPlaybackRate = player.playbackRate = settings.speed;
  player.onended = () => {
    if (token === gen) playIndex(i + 1, gapAfter(i));
  };
  playingIndex = i;
  updateUI();
  pump();
  if (delay) await sleep(delay / settings.speed);
  if (token === gen && !paused) playCurrent();
}

function start(i) {
  if (!sentences.length) return;
  hideError();
  paused = false;
  playIndex(i);
}

function togglePlay() {
  if (!sentences.length) {
    readSelection();
  } else if (!running) {
    start(current >= 0 && current < sentences.length ? current : 0);
  } else if (paused) {
    paused = false;
    if (playingIndex === current) playCurrent();
    updateUI();
  } else {
    paused = true;
    player.pause();
    updateUI();
  }
}

function stop() {
  gen++;
  stopAudio();
  running = false;
  playingIndex = -1;
  paused = false;
  setLoading(false);
  pump();
  updateUI('Stopped');
}

function jump(i) {
  if (!sentences.length) return;
  i = Math.max(0, Math.min(i, sentences.length - 1));
  paused = false;
  if (running) playIndex(i);
  else start(i);
}

// ---------- rendering ----------

function loadText(text, autoplay) {
  stop();
  for (const entry of cache.values()) dropEntry(entry);
  cache.clear();
  sentences = splitText(text);
  current = sentences.length ? 0 : -1;
  renderDoc();
  if (autoplay) start(0);
  else updateUI('Ready');
}

function renderDoc() {
  el.doc.replaceChildren();
  spans = [];
  let p = null;
  sentences.forEach((s, i) => {
    if (!p || s.para !== sentences[i - 1].para) {
      p = document.createElement('p');
      el.doc.append(p);
    }
    const span = document.createElement('span');
    span.className = 'sentence';
    span.textContent = s.display;
    span.dataset.i = i;
    p.append(span);
    spans.push(span);
  });
  el.empty.hidden = sentences.length > 0;
  el.doc.hidden = sentences.length === 0;
  el.seek.max = Math.max(sentences.length - 1, 0);
  el.seek.disabled = sentences.length === 0;
}

function setCurrent(i, scroll = true) {
  const prev = current;
  current = i;
  const [lo, hi] = prev < i ? [prev, i] : [i, prev];
  for (let k = Math.max(lo, 0); k <= Math.min(hi, spans.length - 1); k++) {
    spans[k].classList.toggle('read', k < i);
    spans[k].classList.toggle('current', k === i);
  }
  if (scroll && settings.follow && spans[i]) {
    spans[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateUI();
}

function setLoading(on) {
  document.body.classList.toggle('loading', on);
}

let statusOverride = 'Ready';
function updateUI(status) {
  if (status) statusOverride = status;
  const total = sentences.length;
  const playing = running && !paused;
  document.body.classList.toggle('playing', playing);
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');

  if (running) {
    const loading = document.body.classList.contains('loading');
    el.status.textContent = paused ? 'Paused' : loading ? 'Generating' : 'Playing';
  } else {
    el.status.textContent = total ? statusOverride : 'Ready';
  }

  const shown = Math.min(Math.max(current, 0), Math.max(total - 1, 0));
  el.seek.value = shown;
  const done = current >= total ? total : current;
  el.count.textContent = total ? `${shown + 1} / ${total} · ${Math.round((done / total) * 100)}%` : '';

  const s = sentences[current];
  el.lang.hidden = !(settings.voice === 'mix' && s);
  if (s) el.lang.textContent = s.lang;

  for (const b of [el.prev, el.next, el.stop]) b.disabled = !total;
}

function showError(message, { offerSettings = false } = {}) {
  el.errorText.textContent = message;
  el.errorSettings.hidden = !offerSettings;
  el.error.hidden = false;
}

function unreachable() {
  showError(`Can't reach the server at ${settings.server}.`, { offerSettings: true });
}

function hideError() {
  el.error.hidden = true;
}

// ---------- settings ----------

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  el.speed.value = settings.speed;
  el.speedValue.textContent = `${Number(settings.speed).toFixed(1)}×`;
  el.follow.setAttribute('aria-pressed', settings.follow);
  el.server.value = settings.server;
  syncSwitches();
}

function saveSetting(key, value) {
  settings[key] = value;
  chrome.storage.local.set({ [key]: value });
}

async function fetchVoices(server = settings.server) {
  const res = await fetch(`${server}/voices`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()).voices;
}

async function loadVoices() {
  try {
    voices = await fetchVoices();
    hideError();
  } catch {
    voices = FALLBACK_VOICES;
    unreachable();
  }
  el.voice.replaceChildren(...voices.map((v) => {
    const label = v.description ? `${v.voice} — ${v.description}` : `${v.voice} (${v.lang})`;
    return new Option(label, v.voice, false, v.voice === settings.voice);
  }));
  if (!voices.some((v) => v.voice === settings.voice)) saveSetting('voice', el.voice.value);
}

function changeSpeed(value) {
  value = Math.round(Math.max(0.5, Math.min(3, value)) * 10) / 10;
  el.speed.value = value;
  el.speedValue.textContent = `${value.toFixed(1)}×`;
  if (value === settings.speed) return;
  saveSetting('speed', value);
  player.defaultPlaybackRate = player.playbackRate = value;
}

// ---------- input ----------

async function readSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let text = '';
  try {
    text = tab ? await getSelectionText(tab.id) : '';
  } catch {
    showError("Can't read this page's selection. Use right-click → Read with Orotone, or paste the text.");
    return;
  }
  if (text.trim()) loadText(text, true);
  else showError('Nothing is selected on the current page.');
}

let windowId;
async function takePending() {
  const key = `pending:${windowId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  await chrome.storage.session.remove(key);
  hideError();
  loadText(pending.text, true);
}

el.play.addEventListener('click', togglePlay);
el.stop.addEventListener('click', stop);
el.prev.addEventListener('click', () => jump(current - 1));
el.next.addEventListener('click', () => jump(current + 1));
el.seek.addEventListener('input', () => {
  el.count.textContent = `${Number(el.seek.value) + 1} / ${sentences.length}`;
});
el.seek.addEventListener('change', () => jump(Number(el.seek.value)));
el.doc.addEventListener('click', (e) => {
  const span = e.target.closest('.sentence');
  if (span && !getSelection().toString()) jump(Number(span.dataset.i));
});

$('read-selection').addEventListener('click', readSelection);
$('read-paste').addEventListener('click', () => {
  if (el.paste.value.trim()) loadText(el.paste.value, true);
});
$('new').addEventListener('click', () => {
  loadText('', false);
  el.paste.value = '';
  hideError();
});

el.voice.addEventListener('change', () => {
  saveSetting('voice', el.voice.value);
  updateUI();
  invalidateAudio();
});
el.speed.addEventListener('input', () => changeSpeed(Number(el.speed.value)));

// On/off switches for the speech options, on the settings screen and at the top of each page
function syncSwitches() {
  for (const input of document.querySelectorAll('input[data-setting]')) input.checked = settings[input.dataset.setting];
  $('pron-row').classList.toggle('off', !settings.usePronunciations);
  $('abbr-row').classList.toggle('off', !settings.expandAbbreviations);
  $('abbr-builtin').classList.toggle('dimmed', !settings.expandAbbreviations);
  $('abbr-custom').classList.toggle('dimmed', !settings.expandAbbreviations);
  $('dates-row').classList.toggle('dimmed', !settings.expandAbbreviations);
  $('pron-list').classList.toggle('dimmed', !settings.usePronunciations);
}
for (const input of document.querySelectorAll('input[data-setting]')) {
  input.addEventListener('change', () => {
    saveSetting(input.dataset.setting, input.checked);
    syncSwitches();
    invalidateAudio();
  });
}

el.follow.addEventListener('click', () => {
  saveSetting('follow', !settings.follow);
  el.follow.setAttribute('aria-pressed', settings.follow);
  if (settings.follow) spans[current]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

function openSettings() {
  el.server.value = settings.server;
  el.serverResult.textContent = '';
  el.settings.returnValue = '';
  el.settings.showModal();
}

$('open-settings').addEventListener('click', openSettings);
el.errorSettings.addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => el.settings.close());
$('test-server').addEventListener('click', async () => {
  const server = el.server.value.replace(/\/+$/, '');
  el.serverResult.textContent = 'Testing…';
  try {
    const voices = await fetchVoices(server);
    el.serverResult.textContent = `Connected · ${voices.length} voices`;
  } catch (err) {
    el.serverResult.textContent = `Failed: ${err.message}`;
  }
});
el.settings.addEventListener('close', () => {
  if (el.settings.returnValue !== 'save') return;
  const server = el.server.value.trim().replace(/\/+$/, '');
  if (!server || server === settings.server) return;
  saveSetting('server', server);
  loadVoices();
  invalidateAudio();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  const actions = {
    ' ': togglePlay,
    ArrowLeft: () => jump(current - 1),
    ArrowRight: () => jump(current + 1),
    Escape: stop,
    '[': () => changeSpeed(settings.speed - 0.1),
    ']': () => changeSpeed(settings.speed + 0.1),
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[`pending:${windowId}`]?.newValue) takePending();
});

// ---------- pronunciations ----------

const pron = {
  sheet: $('pron'), listView: $('pron-list-view'), editView: $('pron-edit-view'),
  list: $('pron-list'), empty: $('pron-empty'), search: $('pron-search'), count: $('pron-count'),
  title: $('pron-edit-title'), phrase: $('pron-phrase'), original: $('pron-original'),
  sounds: $('pron-sounds'), soundsLabel: $('pron-sounds-label'), soundsHint: $('pron-sounds-hint'),
  candidates: $('pron-candidates'), candidatesStatus: $('pron-candidates-status'),
  advanced: $('pron-advanced'), phonemes: $('pron-phonemes'), phonemesWarning: $('pron-phonemes-warning'),
  ignoreCase: $('pron-ignore-case'), dup: $('pron-dup'), del: $('pron-delete'), save: $('pron-save'),
  fix: $('fix-selection'),
};
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>';
let editing = null;        // id of the entry being edited, or null for a new one
let candidates = [];
let autoPick = true;       // follow the top suggestion until the user picks or types phonemes
let alphabet = '';
let suggestToken = 0;
let suggestTimer;
const previewPlayer = new Audio();
previewPlayer.preservesPitch = true;
let previewController;
let previewButton;

const editLang = () => pron.editView.elements['pron-lang'].value;

function updatePronCount() {
  pron.count.textContent = pronunciations.length || '';
}

function voiceFor(lang) {
  if (langsFor(settings.voice).has(lang)) return settings.voice;
  return voices.find((v) => langsFor(v.voice).has(lang) && v.voice !== 'mix')?.voice ?? (lang === 'ja' ? 'jf_alpha' : 'af_heart');
}

function endPreview() {
  previewController?.abort();
  previewPlayer.pause();
  previewButton?.classList.remove('playing');
  previewButton = null;
}

async function preview(entry, button, phonemes) {
  const wasThis = previewButton === button;
  endPreview();
  if (wasThis || !entry.phrase.trim()) return;
  if (running && !paused) togglePlay(); // don't talk over the reader
  previewButton = button;
  button.classList.add('playing');
  const controller = previewController = new AbortController();
  try {
    const url = await synthesize(previewInput(entry, phonemes), voiceFor(entry.lang), controller.signal);
    if (controller.signal.aborted || !url) return;
    previewPlayer.src = url;
    previewPlayer.playbackRate = settings.speed;
    previewPlayer.onended = () => { URL.revokeObjectURL(url); if (previewButton === button) endPreview(); };
    await previewPlayer.play();
  } catch (err) {
    if (err.name === 'AbortError') return;
    endPreview();
    pron.candidatesStatus.textContent = err.name === 'TypeError' ? `Can't reach the server at ${settings.server}.` : err.message;
  }
}

function playButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon';
  b.title = b.ariaLabel = label;
  b.innerHTML = PLAY_ICON;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
  return b;
}

function renderPronList() {
  const q = pron.search.value.trim().toLowerCase();
  const shown = pronunciations
    .filter((e) => !q || e.phrase.toLowerCase().includes(q) || (e.soundsLike ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.phrase.localeCompare(b.phrase));
  pron.list.replaceChildren(...shown.map((entry) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.tabIndex = 0;
    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('strong');
    name.textContent = entry.phrase;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = [entry.soundsLike, entry.lang === 'en' && entry.phonemes && `/${entry.phonemes}/`].filter(Boolean).join('  ·  ');
    main.append(name, detail);
    li.append(main);
    if (entry.lang === 'ja') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'JA';
      li.append(badge);
    }
    li.append(playButton(`Play ${entry.phrase}`, (b) => preview(entry, b)));
    li.addEventListener('click', () => openEditor(entry));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEditor(entry); });
    return li;
  }));
  pron.empty.hidden = pronunciations.length > 0;
  $('pron-export').disabled = !pronunciations.length;
  pron.search.hidden = pronunciations.length < 6;
}

function showView(view) {
  endPreview();
  pron.listView.hidden = view !== 'list';
  pron.editView.hidden = view !== 'edit';
  if (view === 'list') renderPronList();
}

function openPronunciations() {
  if (el.settings.open) el.settings.close();
  pron.search.value = '';
  $('pron-transfer-result').textContent = '';
  showView('list');
  if (!pron.sheet.open) pron.sheet.showModal();
}

function openEditor(entry = {}, { fresh = !entry.id } = {}) {
  editing = entry.id ?? null;
  pron.title.textContent = editing ? 'Edit Pronunciation' : 'New Pronunciation';
  pron.phrase.value = entry.phrase ?? '';
  pron.sounds.value = entry.soundsLike ?? '';
  pron.phonemes.value = entry.phonemes ?? '';
  pron.ignoreCase.checked = entry.ignoreCase ?? true;
  pron.editView.elements['pron-lang'].value = entry.lang ?? (JA_RE.test(entry.phrase ?? '') ? 'ja' : 'en');
  pron.del.hidden = !editing;
  pron.advanced.open = false;
  autoPick = fresh;
  candidates = [];
  pron.original.textContent = '';
  pron.candidatesStatus.textContent = '';
  if (!pron.sheet.open) pron.sheet.showModal();
  showView('edit');
  syncLang();
  suggest(0);
  (pron.phrase.value ? pron.sounds : pron.phrase).focus();
}

function syncLang() {
  const ja = editLang() === 'ja';
  pron.soundsLabel.textContent = ja ? 'Reading' : 'Sounds like';
  pron.sounds.placeholder = ja ? 'e.g. ぬし' : 'e.g. pah-ROH-lee';
  pron.soundsHint.textContent = ja
    ? 'Type the reading in hiragana or katakana. It replaces the phrase when spoken.'
    : 'Spell it the way it sounds. Separate syllables with hyphens and capitalize the stressed one.';
  pron.advanced.hidden = ja;
  pron.ignoreCase.closest('label').hidden = ja;
}

function suggest(delay = 350) {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggest, delay);
}

async function runSuggest() {
  const token = ++suggestToken;
  const body = { phrase: pron.phrase.value.trim(), sounds_like: pron.sounds.value.trim(), lang: editLang() };
  if (!body.phrase && !body.sounds_like) {
    candidates = [];
    pron.original.textContent = '';
    renderCandidates();
    return;
  }
  try {
    const res = await fetch(`${settings.server}/pronunciations/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'This server is too old to suggest pronunciations — update Orotone.' : `Server returned ${res.status}`);
    const data = await res.json();
    if (token !== suggestToken) return;
    candidates = data.candidates;
    alphabet = data.alphabet || alphabet;
    pron.original.textContent = data.original ? `Currently: /${data.original}/` : '';
    pron.candidatesStatus.textContent = '';
    if (autoPick && editLang() === 'en') pron.phonemes.value = candidates[0]?.phonemes ?? '';
  } catch (err) {
    if (token !== suggestToken) return;
    candidates = [];
    pron.candidatesStatus.textContent = err.name === 'TypeError'
      ? `Can't reach the server for suggestions. You can still type phonemes under Phonemes.`
      : err.message;
  }
  renderCandidates();
}

function currentEntry() {
  return {
    phrase: pron.phrase.value, lang: editLang(), soundsLike: pron.sounds.value,
    phonemes: pron.phonemes.value, ignoreCase: pron.ignoreCase.checked,
  };
}

function renderCandidates() {
  const ja = editLang() === 'ja';
  const chosen = pron.phonemes.value.trim();
  const rows = ja ? candidates.slice(0, 1) : [...candidates];
  if (!ja && chosen && !rows.some((c) => c.phonemes === chosen)) rows.unshift({ phonemes: chosen, label: 'Custom' });
  pron.candidates.replaceChildren(...rows.map((c) => {
    const li = document.createElement('li');
    const checked = ja || c.phonemes === chosen;
    li.setAttribute('role', 'radio');
    li.setAttribute('aria-checked', checked);
    li.tabIndex = 0;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = '✓';
    const main = document.createElement('div');
    main.className = 'row-main';
    const label = document.createElement('strong');
    label.textContent = c.label;
    const ph = document.createElement('span');
    ph.className = 'phon';
    ph.textContent = `/${c.phonemes}/`;
    main.append(label, ph);
    const pick = () => {
      if (ja) return;
      autoPick = false;
      pron.phonemes.value = c.phonemes;
      renderCandidates();
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); } });
    li.append(tick, main, playButton(`Play ${c.label}`, (b) => { pick(); preview(currentEntry(), b, c.phonemes); }));
    return li;
  }));
  if (!rows.length && !pron.candidatesStatus.textContent) {
    pron.candidatesStatus.textContent = pron.sounds.value.trim()
      ? (pron.phrase.value.trim() ? 'No suggestions — try a different spelling.' : '')
      : `Type how it ${ja ? 'reads' : 'sounds'} to see options you can listen to.`;
  }
  validate();
}

function validate() {
  const entry = currentEntry();
  const ph = entry.phonemes.trim();
  let warning = '';
  if (entry.lang === 'en' && ph) {
    if (PHONEME_FORBIDDEN.test(ph)) warning = 'Phonemes can’t contain [ ] ( ) or /.';
    else if (alphabet) {
      const unknown = [...new Set([...ph].filter((c) => !alphabet.includes(c)))];
      if (unknown.length) warning = `Kokoro will skip these unknown symbols: ${unknown.join(' ')}`;
    }
  }
  pron.phonemesWarning.textContent = warning;
  pron.phonemesWarning.hidden = !warning;
  if (warning) pron.advanced.open = true;
  const key = entry.phrase.trim().toLowerCase();
  const dup = key && pronunciations.find((e) => e.id !== editing && e.lang === entry.lang && e.phrase.trim().toLowerCase() === key);
  pron.dup.textContent = dup ? `Saving replaces the existing pronunciation for “${dup.phrase}”.` : '';
  pron.dup.hidden = !dup;
  pron.save.disabled = !isUsable(entry) || PHONEME_FORBIDDEN.test(ph);
}

async function commitPronunciations(list) {
  pronunciations = list;
  await savePronunciations(list);
  updatePronCount();
  invalidateAudio();
}

pron.editView.addEventListener('submit', async (e) => {
  e.preventDefault();
  const entry = currentEntry();
  if (pron.save.disabled) return;
  entry.phrase = entry.phrase.trim();
  entry.soundsLike = entry.soundsLike.trim();
  entry.phonemes = entry.lang === 'en' ? entry.phonemes.trim() : '';
  entry.id = editing ?? crypto.randomUUID();
  const key = entry.phrase.toLowerCase();
  const rest = pronunciations.filter((x) => x.id !== entry.id && !(x.lang === entry.lang && x.phrase.trim().toLowerCase() === key));
  await commitPronunciations([...rest, entry]);
  showView('list');
});
pron.del.addEventListener('click', async () => {
  await commitPronunciations(pronunciations.filter((x) => x.id !== editing));
  showView('list');
});

pron.phrase.addEventListener('input', () => { suggest(); validate(); });
pron.sounds.addEventListener('input', () => { autoPick ||= !pron.phonemes.value.trim(); suggest(); validate(); });
pron.phonemes.addEventListener('input', () => { autoPick = false; renderCandidates(); });
pron.editView.addEventListener('change', (e) => {
  if (e.target.name !== 'pron-lang') return;
  syncLang();
  suggest(0);
});
pron.ignoreCase.addEventListener('change', validate);
$('pron-play-original').addEventListener('click', (e) => {
  preview({ phrase: pron.phrase.value, lang: editLang() }, e.currentTarget);
});
$('pron-play-phonemes').addEventListener('click', (e) => preview(currentEntry(), e.currentTarget));
$('pron-add').addEventListener('click', () => openEditor());
$('pron-back').addEventListener('click', () => showView('list'));
$('pron-close').addEventListener('click', () => pron.sheet.close());
$('open-pron').addEventListener('click', openPronunciations);
pron.search.addEventListener('input', renderPronList);
$('pron-export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportPronunciations(pronunciations)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'orotone-pronunciations.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('pron-import').addEventListener('click', () => $('pron-file').click());
$('pron-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const result = $('pron-transfer-result');
  try {
    const { list, added, replaced, skipped } = importPronunciations(await file.text(), pronunciations);
    await commitPronunciations(list);
    renderPronList();
    result.textContent = [`Imported ${added} new`, replaced && `${replaced} updated`, skipped && `${skipped} skipped`]
      .filter(Boolean).join(' · ');
  } catch (err) {
    result.textContent = `Couldn’t import: ${err instanceof SyntaxError ? 'the file isn’t valid JSON.' : err.message}`;
  }
});
pron.sheet.addEventListener('close', endPreview);
// Esc inside the editor goes back to the list instead of closing the whole sheet
pron.sheet.addEventListener('cancel', (e) => {
  if (pron.editView.hidden) return;
  e.preventDefault();
  showView('list');
});

// Selecting a word in the reader offers a shortcut to fix how it's said
function selectedPhrase() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !el.doc.contains(sel.anchorNode)) return '';
  const text = sel.toString().trim();
  return text && text.length <= 60 && !/\n/.test(text) ? text : '';
}

function placeFixButton() {
  const text = selectedPhrase();
  pron.fix.hidden = !text;
  if (!text) return;
  const rect = getSelection().getRangeAt(0).getBoundingClientRect();
  pron.fix.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 70), innerWidth - 70)}px`;
  pron.fix.style.top = `${Math.max(rect.top, 40)}px`;
}

document.addEventListener('selectionchange', () => { if (!selectedPhrase()) pron.fix.hidden = true; });
el.doc.addEventListener('mouseup', () => setTimeout(placeFixButton));
$('text').addEventListener('scroll', () => { pron.fix.hidden = true; });
pron.fix.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
pron.fix.addEventListener('click', () => {
  const phrase = selectedPhrase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  pron.fix.hidden = true;
  if (!phrase) return;
  const existing = pronunciations.find((e) => e.phrase.trim().toLowerCase() === phrase.toLowerCase());
  getSelection().removeAllRanges();
  openEditor(existing ?? { phrase });
});

// ---------- abbreviations ----------

const abbr = {
  sheet: $('abbr'), listView: $('abbr-list-view'), editView: $('abbr-edit-view'),
  custom: $('abbr-custom'), customEmpty: $('abbr-custom-empty'), builtin: $('abbr-builtin'), builtinEmpty: $('abbr-builtin-empty'),
  restoreAll: $('abbr-restore-all'), search: $('abbr-search'), count: $('abbr-count'), result: $('abbr-transfer-result'),
  title: $('abbr-edit-title'), text: $('abbr-text'), expansion: $('abbr-expansion'), expansionLabel: $('abbr-expansion-label'),
  plural: $('abbr-plural'), pluralRow: $('abbr-plural-row'), pluralHint: $('abbr-plural-hint'),
  optionalDot: $('abbr-optional-dot'), optionalDotRow: $('abbr-optional-dot-row'), when: $('abbr-when'),
  examples: $('abbr-examples'), dup: $('abbr-dup'), defaultNote: $('abbr-default'),
  restore: $('abbr-restore'), del: $('abbr-delete'), save: $('abbr-save'),
};
let editingAbbr = null; // the entry being edited (from listAbbreviations), or null for a new one

abbr.when.append(...Object.entries(CONTEXTS).map(([value, label]) => new Option(label, value)));

function updateAbbrCount() {
  abbr.count.textContent = activeCount(abbreviations);
}

const contextLabel = (when) => CONTEXTS[when].toLowerCase();
const readAs = (e) => (e.plural ? `${e.expansion} / ${e.plural}` : e.expansion);

function abbrRow(entry) {
  const li = document.createElement('li');
  li.className = entry.enabled ? 'row' : 'row off';
  li.tabIndex = 0;
  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('strong');
  name.textContent = entry.abbr;
  const sub = document.createElement('span');
  sub.className = 'muted';
  sub.textContent = `${readAs(entry)}  ·  ${contextLabel(entry.when)}`;
  main.append(name, sub);
  li.append(main);
  if (entry.edited) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Edited';
    li.append(badge);
  }
  const toggle = document.createElement('span');
  toggle.className = 'switch';
  toggle.innerHTML = '<input type="checkbox" role="switch"><span></span>';
  const input = toggle.firstChild;
  input.checked = entry.enabled;
  input.ariaLabel = `${entry.abbr} → ${readAs(entry)}`;
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => commitAbbreviations(setEnabled(abbreviations, entry.id, input.checked)));
  li.append(toggle);
  li.addEventListener('click', () => openAbbrEditor(entry));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) openAbbrEditor(entry); });
  return li;
}

function renderAbbrList() {
  const q = abbr.search.value.trim().toLowerCase();
  const all = listAbbreviations(abbreviations);
  const shown = all.filter((e) => !q || [e.abbr, e.expansion, e.plural ?? ''].some((f) => f.toLowerCase().includes(q)));
  abbr.custom.replaceChildren(...shown.filter((e) => !e.builtin).sort((a, b) => a.abbr.localeCompare(b.abbr)).map(abbrRow));
  abbr.builtin.replaceChildren(...shown.filter((e) => e.builtin).map(abbrRow));
  abbr.customEmpty.hidden = all.some((e) => !e.builtin);
  abbr.builtinEmpty.hidden = all.some((e) => e.builtin);
  const changes = builtinChanges(abbreviations);
  abbr.restoreAll.disabled = !changes;
  abbr.restoreAll.textContent = changes ? `Restore Built-ins (${changes} changed)` : 'Restore Built-ins';
}

function showAbbrView(view) {
  abbr.listView.hidden = view !== 'list';
  abbr.editView.hidden = view !== 'edit';
  if (view === 'list') renderAbbrList();
}

function openAbbreviations() {
  if (el.settings.open) el.settings.close();
  abbr.search.value = '';
  abbr.result.textContent = '';
  showAbbrView('list');
  if (!abbr.sheet.open) abbr.sheet.showModal();
}

function currentAbbr() {
  return {
    id: editingAbbr?.id, abbr: abbr.text.value, expansion: abbr.expansion.value, plural: abbr.plural.value,
    when: abbr.when.value, optionalDot: abbr.optionalDot.checked,
  };
}

function validateAbbr() {
  const entry = currentAbbr();
  const counted = entry.when === 'after-number';
  abbr.pluralRow.hidden = abbr.pluralHint.hidden = !counted;
  abbr.expansionLabel.textContent = counted ? 'Read as (singular)' : 'Read as';
  abbr.optionalDotRow.hidden = !entry.abbr.trim().endsWith('.');

  const usable = isUsableAbbreviation(entry);
  abbr.examples.replaceChildren(...(usable ? examplesFor(entry) : []).map(([before, after]) => {
    const li = document.createElement('li');
    li.append('“', Object.assign(document.createElement('b'), { textContent: before }), '” is read as “',
      Object.assign(document.createElement('b'), { textContent: after }), '”');
    return li;
  }));

  const def = editingAbbr?.builtin && defaultFor(editingAbbr.id);
  const changed = def && JSON.stringify(cleanEntry(entry)) !== JSON.stringify(cleanEntry(def));
  abbr.restore.hidden = !changed;
  abbr.defaultNote.hidden = !changed;
  if (changed) abbr.defaultNote.textContent = `Default: “${def.abbr}” → “${readAs(def)}”, ${contextLabel(def.when)}.`;

  const key = entry.abbr.trim();
  const dup = key && listAbbreviations(abbreviations).find((e) => e.id !== entry.id && e.abbr === key && e.when === entry.when);
  abbr.dup.textContent = !dup ? ''
    : dup.builtin && !editingAbbr?.builtin ? `This takes priority over the built-in “${dup.abbr}” → “${readAs(dup)}”.`
    : dup.builtin ? `Another built-in already reads “${dup.abbr}” as “${readAs(dup)}” here.`
    : `Saving replaces your existing “${dup.abbr}” → “${readAs(dup)}”.`;
  abbr.dup.hidden = !dup;
  abbr.save.disabled = !usable;
}

function openAbbrEditor(entry = null) {
  editingAbbr = entry;
  abbr.title.textContent = entry ? 'Edit Abbreviation' : 'New Abbreviation';
  abbr.text.value = entry?.abbr ?? '';
  abbr.expansion.value = entry?.expansion ?? '';
  abbr.plural.value = entry?.plural ?? '';
  abbr.when.value = entry?.when ?? 'always';
  abbr.optionalDot.checked = !!entry?.optionalDot;
  abbr.del.hidden = !entry;
  if (!abbr.sheet.open) abbr.sheet.showModal();
  showAbbrView('edit');
  validateAbbr();
  (abbr.text.value ? abbr.expansion : abbr.text).focus();
}

async function commitAbbreviations(state) {
  abbreviations = state;
  abbrRules = activeRules(state);
  await saveAbbreviations(state);
  updateAbbrCount();
  invalidateAudio();
  if (!abbr.listView.hidden) renderAbbrList();
}

abbr.editView.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (abbr.save.disabled) return;
  await commitAbbreviations(putAbbreviation(abbreviations, currentAbbr()));
  showAbbrView('list');
});
abbr.restore.addEventListener('click', async () => {
  await commitAbbreviations(restoreDefault(abbreviations, editingAbbr.id));
  showAbbrView('list');
});
abbr.del.addEventListener('click', async () => {
  await commitAbbreviations(removeAbbreviation(abbreviations, editingAbbr.id));
  showAbbrView('list');
});
abbr.restoreAll.addEventListener('click', async () => {
  const n = builtinChanges(abbreviations);
  if (!confirm(`Restore ${n} built-in abbreviation${n === 1 ? '' : 's'} to the default? Your custom ones are kept.`)) return;
  await commitAbbreviations(restoreBuiltins(abbreviations));
});
for (const input of [abbr.text, abbr.expansion, abbr.plural, abbr.when, abbr.optionalDot]) input.addEventListener('input', validateAbbr);
$('abbr-add').addEventListener('click', () => openAbbrEditor());
$('abbr-back').addEventListener('click', () => showAbbrView('list'));
$('abbr-close').addEventListener('click', () => abbr.sheet.close());
$('open-abbr').addEventListener('click', openAbbreviations);
abbr.search.addEventListener('input', renderAbbrList);
abbr.sheet.addEventListener('cancel', (e) => {
  if (abbr.editView.hidden) return;
  e.preventDefault();
  showAbbrView('list');
});
$('abbr-export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportAbbreviations(abbreviations)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'orotone-abbreviations.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('abbr-import').addEventListener('click', () => $('abbr-file').click());
$('abbr-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { state, added, replaced, skipped } = importAbbreviations(await file.text(), abbreviations);
    await commitAbbreviations(state);
    abbr.result.textContent = [`Imported ${added} new`, replaced && `${replaced} updated`, skipped && `${skipped} skipped`]
      .filter(Boolean).join(' · ');
  } catch (err) {
    abbr.result.textContent = `Couldn’t import: ${err instanceof SyntaxError ? 'the file isn’t valid JSON.' : err.message}`;
  }
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await loadSettings();
  pronunciations = await loadPronunciations();
  updatePronCount();
  abbreviations = await loadAbbreviations();
  abbrRules = activeRules(abbreviations);
  updateAbbrCount();
  updateUI();
  await takePending();
  await loadVoices();
})();
