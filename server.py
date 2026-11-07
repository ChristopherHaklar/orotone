import os
import re
import struct
import logging
import time
import warnings
import itertools
import threading
import numpy as np
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import torch
from kokoro import KPipeline

warnings.filterwarnings("ignore", category=UserWarning, module="torch")
warnings.filterwarnings("ignore", category=FutureWarning, module="torch")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("misaki").setLevel(logging.ERROR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)
_req_id = itertools.count(1)
VERBOSE = os.getenv("OROTONE_VERBOSE", "").lower() in ("1", "true", "yes")

log.info("device=%s", "cuda" if torch.cuda.is_available() else "cpu")

SILENCE_THRESH = 1e-4
SR = 24000

app = FastAPI()


@app.middleware("http")
async def log_request_body(request: Request, call_next):
    if VERBOSE and request.method == "POST":
        body = await request.body()
        log.info("POST %s body: %s", request.url.path, body.decode())
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

voice2lang = {
    "af_heart": "a",
    "jf_alpha": "j",
    "mix":      "mix",
}

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

pipelines = {
    "a": KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=DEVICE),
    "j": KPipeline(lang_code="j", repo_id="hexgrad/Kokoro-82M", device=DEVICE),
}

DEFAULT_VOICE = "af_heart"

# Kokoro pipelines aren't safe to drive concurrently; serialize synthesis steps
_synth_lock = threading.Lock()

_jp_re = re.compile(r"[　-ヿ一-鿿]+")


def segment_text(text):
    parts = _jp_re.split(text)
    splits = _jp_re.findall(text)
    runs = []
    for i, part in enumerate(parts):
        if part:
            runs.append(("a", part))
        if i < len(splits):
            runs.append(("j", splits[i]))
    return runs


@app.get("/v1")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    return {"data": [{"id": "tts-1", "object": "model"}]}


@app.get("/v1/voices")
async def voices():
    return {
        "voices": [
            {"voice": "af_heart", "lang": "en-US", "description": ""},
            {"voice": "jf_alpha", "lang": "ja-JP", "description": ""},
            {"voice": "mix",      "lang": "en-US", "description": "Auto-detect EN/JA"},
        ]
    }


def trim_silence(wave, thresh=SILENCE_THRESH):
    wave = np.asarray(wave)
    mask = np.abs(wave) > thresh
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return np.zeros((0,), dtype=wave.dtype)
    return wave[idx[0]:idx[-1] + 1]


def _wav_header(sample_rate=SR, channels=1, bits=16) -> bytes:
    # 0xFFFFFFFF signals unknown/streaming size to compliant WAV parsers
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 0xFFFFFFFF, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits,
        b"data", 0xFFFFFFFF,
    )


def _pcm16(chunk) -> bytes:
    arr = np.asarray(chunk)
    return (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


def _synth(lang, text, voice_id, speed):
    gen = pipelines[lang](text, voice=voice_id, speed=speed)
    while True:
        with _synth_lock:
            result = next(gen, None)
        if result is None:
            return
        trimmed = trim_silence(result[2])
        if len(trimmed) > 0:
            yield _pcm16(trimmed)


# Sync generator: StreamingResponse runs it in a threadpool, keeping the event loop free
def stream_tts(text: str, voice_id: str, speed: float = 1.0):
    yield _wav_header()

    if voice_id == "mix":
        for lang, seg in segment_text(text):
            if not seg.strip():
                continue
            vid = "jf_alpha" if lang == "j" else "af_heart"
            yield from _synth(lang, seg, vid, speed)
    else:
        yield from _synth(voice2lang.get(voice_id, "a"), text, voice_id, speed)


# ---------- custom pronunciations ----------
# The English G2P accepts inline overrides like "[Orotone](/ˈɔɹətˌOn/)", so clients store a phrase plus
# phonemes and wrap matches before sending. These helpers turn a "sounds like" respelling into
# phoneme candidates the user can audition, the way Apple's Pronunciations screen offers choices.

_STRESS = str.maketrans("", "", "ˈˌ")
_VOWELS = set("AIOQWYaeiouæɑɒɔəɛɜɪʊʌᵻɚɐ")
_SYLLABLE_SPLIT = re.compile(r"[\s\-.·]+")
MAX_CANDIDATES = 6


def g2p(lang, text):
    with _synth_lock:
        phonemes, _ = pipelines[lang].g2p(text)
    return phonemes.strip()


def _stress(syllable):
    for k, ch in enumerate(syllable):
        if ch in _VOWELS:
            return syllable[:k] + "ˈ" + syllable[k:]
    return "ˈ" + syllable


def suggest_en(sounds_like):
    """Phoneme candidates for an English respelling such as "pah-ROH-lee", best guess first."""
    text = sounds_like.strip()
    syllables = [s for s in _SYLLABLE_SPLIT.split(text) if s]
    candidates = []

    def add(phonemes, label):
        phonemes = phonemes.strip()
        if phonemes and "❓" not in phonemes and all(c["phonemes"] != phonemes for c in candidates):
            candidates.append({"phonemes": phonemes, "label": label})

    if len(syllables) > 1:
        # Capitals mark stress in respellings, but the G2P would spell them out as an acronym,
        # so phonemize each syllable in lowercase and place the stress ourselves
        bare = [g2p("a", s.lower()).translate(_STRESS).replace(" ", "") for s in syllables]
        marked = [i for i, s in enumerate(syllables) if s.isupper() and not text.isupper()]
        orders = ([marked] if marked else []) + [[i] for i in range(len(syllables)) if [i] != marked]
        for stressed in orders:
            phonemes = "".join(_stress(b) if i in stressed else b for i, b in enumerate(bare))
            label = "-".join(s.upper() if i in stressed else s.lower() for i, s in enumerate(syllables))
            add(phonemes, label)
    joined = "".join(syllables).lower()
    add(g2p("a", joined), joined)
    return candidates[:MAX_CANDIDATES]


class SuggestRequest(BaseModel):
    phrase: str = ""
    sounds_like: str = ""
    lang: str = Field("en", pattern="^(en|ja)$")


@app.post("/v1/pronunciations/suggest")
def suggest_pronunciation(req: SuggestRequest):
    pipe = "j" if req.lang == "ja" else "a"
    original = g2p(pipe, req.phrase) if req.phrase.strip() else ""
    if not req.sounds_like.strip():
        candidates = []
    elif req.lang == "ja":
        # Japanese has no inline phoneme override; the reading itself replaces the phrase
        candidates = [{"phonemes": g2p("j", req.sounds_like), "label": req.sounds_like.strip()}]
    else:
        candidates = suggest_en(req.sounds_like)
    alphabet = "".join(sorted(pipelines["a"].model.vocab)) if pipelines["a"].model else ""
    return {"original": original, "candidates": candidates, "alphabet": alphabet}


class TTSRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = Field(1.5, ge=0.25, le=4.0)


@app.post("/v1/audio/speech")
@app.post("/v1/audio/speech/create")
async def tts_create(req: TTSRequest):
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="input must not be empty")
    if req.voice not in voice2lang:
        raise HTTPException(status_code=400, detail=f"unknown voice '{req.voice}'")

    rid = next(_req_id)
    log.info("[%d] start voice=%s speed=%s chars=%d", rid, req.voice, req.speed, len(req.input))
    t0 = time.perf_counter()

    def timed_stream():
        first = True
        for chunk in stream_tts(req.input, req.voice, req.speed):
            if first:
                log.info("[%d] ttfb=%.3fs", rid, time.perf_counter() - t0)
                first = False
            yield chunk
        log.info("[%d] done total=%.3fs", rid, time.perf_counter() - t0)

    headers = {"X-Accel-Buffering": "no"}
    return StreamingResponse(timed_stream(), media_type="audio/wav", headers=headers)
