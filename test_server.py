"""
Quick functional test for the Orotone TTS server.
Run with: pytest test_server.py -v
"""
import struct
import pytest
from fastapi.testclient import TestClient
from server import app

client = TestClient(app)


def _check_wav(content: bytes):
    """Validate streaming WAV structure by parsing header bytes directly."""
    assert content[:4] == b"RIFF", "missing RIFF magic"
    assert content[8:12] == b"WAVE", "missing WAVE marker"
    assert content[12:16] == b"fmt ", "missing fmt chunk"
    sample_rate = struct.unpack_from("<I", content, 24)[0]
    assert sample_rate == 24000, f"unexpected sample rate {sample_rate}"
    assert content[36:40] == b"data", "missing data chunk"
    assert len(content) > 44, "no audio data after header"


def test_health():
    r = client.get("/v1")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_models():
    r = client.get("/v1/models")
    assert r.status_code == 200
    data = r.json()
    assert any(m["id"] == "tts-1" for m in data["data"])


def test_voices():
    r = client.get("/v1/voices")
    assert r.status_code == 200
    voice_ids = [v["voice"] for v in r.json()["voices"]]
    assert "af_heart" in voice_ids
    assert "jf_alpha" in voice_ids
    assert "mix" in voice_ids


def test_tts_english():
    r = client.post("/v1/audio/speech", json={"input": "Hello.", "voice": "af_heart"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    _check_wav(r.content)


def test_tts_japanese():
    r = client.post("/v1/audio/speech", json={"input": "こんにちは", "voice": "jf_alpha"})
    assert r.status_code == 200
    _check_wav(r.content)


def test_tts_mix():
    r = client.post("/v1/audio/speech", json={"input": "Hello こんにちは world", "voice": "mix"})
    assert r.status_code == 200
    _check_wav(r.content)


def test_tts_alias_endpoint():
    r = client.post("/v1/audio/speech/create", json={"input": "Test.", "voice": "af_heart"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"


def test_tts_default_voice():
    r = client.post("/v1/audio/speech", json={"input": "Default voice test."})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"


def test_suggest_english_respelling():
    r = client.post("/v1/pronunciations/suggest", json={"phrase": "Orotone", "sounds_like": "OR-oh-tone"})
    assert r.status_code == 200
    data = r.json()
    assert data["original"]
    assert data["alphabet"]
    first = data["candidates"][0]
    assert first["label"] == "OR-oh-tone"
    assert first["phonemes"].startswith("ˈɔ")  # stress lands on the capitalized syllable
    assert len({c["phonemes"] for c in data["candidates"]}) == len(data["candidates"])


def test_suggest_japanese_reading():
    r = client.post("/v1/pronunciations/suggest", json={"phrase": "主", "sounds_like": "ぬし", "lang": "ja"})
    assert r.status_code == 200
    assert r.json()["candidates"][0]["label"] == "ぬし"


def test_suggest_rejects_unknown_lang():
    r = client.post("/v1/pronunciations/suggest", json={"phrase": "x", "lang": "fr"})
    assert r.status_code == 422


def test_tts_inline_phoneme_override():
    r = client.post("/v1/audio/speech", json={"input": "ぬし said [Orotone](/ˈɔɹətˌOn/).", "voice": "mix"})
    assert r.status_code == 200
    _check_wav(r.content)
