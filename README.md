<p align="center"><img src="assets/logo.svg" alt="" width="112"></p>

<h1 align="center">paroli</h1>

A lightweight TTS (text-to-speech) REST server built on [Kokoro](https://github.com/hexgrad/kokoro), with support for English and Japanese voices and automatic language mixing.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1` | Health check |
| GET | `/v1/models` | List available models |
| GET | `/v1/voices` | List available voices |
| POST | `/v1/audio/speech` | Generate speech (streaming WAV) |
| POST | `/v1/audio/speech/create` | Alias for the above |
| POST | `/v1/pronunciations/suggest` | Turn a "sounds like" respelling into phoneme candidates |

### Voices

| Voice | Language | Notes |
|-------|----------|-------|
| `af_heart` | English (US) | Default |
| `jf_alpha` | Japanese | |
| `mix` | EN + JA | Auto-detects and switches per segment |

### Request parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input` | string | — | Text to synthesize (required) |
| `voice` | string | `af_heart` | Voice ID |
| `speed` | float | `1.5` | Playback speed, `0.25`–`4.0` |

Unknown fields (e.g. `model`) are silently ignored, so OpenAI-compatible TTS clients can point at this server without modification.

### Custom pronunciations

English input accepts inline phoneme overrides in misaki's link syntax, e.g. `"I use [Paroli](/pɑɹˈOli/) daily"`. Japanese has no equivalent, so substitute the reading (`主` → `ぬし`) in the text instead.

`POST /v1/pronunciations/suggest` takes `{"phrase": "Paroli", "sounds_like": "pah-ROH-lee", "lang": "en"}` and returns the phrase's current phonemes (`original`), a list of `candidates` (`{phonemes, label}`, best guess first, with the capitalized syllable stressed and the alternatives stressing each other syllable), and the model's phoneme `alphabet`. With `"lang": "ja"`, the candidate is just the reading.

### Response format

Streaming WAV — 24 kHz, mono, 16-bit PCM. The `Content-Type` is `audio/wav` and the body is chunked, so playback can begin before synthesis is complete.

### Example request

```bash
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world", "voice": "af_heart", "speed": 1.5}' \
  --output speech.wav
```

## Browser integration — Paroli Reader extension

`extension/` contains a Chrome extension built for this server. It splits text into sentences, requests one sentence at a time while prefetching the next few, and starts speaking as soon as the first sentence is ready instead of waiting for the whole selection.

**Install:** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `extension/` folder (Chrome 116+).

**Use:** select text and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>, or right-click → **Read with Paroli**. The side panel shows the text with the current sentence highlighted.

- Click any sentence, or drag the progress bar, to jump there
- Transport: play/pause, stop, previous/next sentence
- Speed changes apply instantly and keep the voice's pitch (playback is sped up in the browser; the server always synthesizes at 1.0×). Voice changes apply from the next sentence
- **Pronunciations** (Settings → Pronunciations, modeled on Apple's Spoken Content screen): add a phrase, type how it sounds (`pah-ROH-lee`), listen to the suggested options and pick one. Or select a word in the reader and click **Fix pronunciation**. English entries become phoneme overrides, which you can also edit by hand; Japanese entries take a kana reading. They're stored in the extension and apply to every voice that speaks the entry's language
- With the `mix` voice, a badge shows whether the current sentence is EN, JA or EN+JA
- Panel shortcuts: <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> sentence, <kbd>[</kbd>/<kbd>]</kbd> speed, <kbd>Esc</kbd> stop
- Server URL is set in the panel's settings (default `http://localhost:8000/v1`); the global shortcut can be changed at `chrome://extensions/shortcuts`

## Browser integration — Read Aloud extension

A key use case for this server is pairing it with the [Read Aloud: A Text to Speech Voice Reader](https://chromewebstore.google.com/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp) Chrome extension. This lets you highlight any text on a webpage and have it read aloud using your local Kokoro models, including seamless switching between English and Japanese within the same selection.

**Setup:**

1. Open the Read Aloud extension settings
2. Go to the **Voice** tab and scroll to the bottom
3. Click **"Enable Custom Voices..."**
4. Under the **OpenAI** option, set:
   - **API URL:** `http://localhost:8000/v1`
   - **Voice List:**
     ```json
     [
       { "lang": "en-US", "model": "tts-1", "voice": "af_heart" },
       { "lang": "ja-JP", "model": "tts-1", "voice": "jf_alpha" },
       { "lang": "en-US", "model": "tts-1", "voice": "mix" }
     ]
     ```

The `mix` voice is the standout option here — it auto-detects Japanese script within English text and switches pipelines per segment, so you can read mixed-language pages without manually changing voices or limiting your selection to one language. For example, selecting a sentence like "今日 was a great day, but 明日 will be even better!" will read the Japanese words in Japanese and the English words in English, seamlessly.

## Running

**Docker (recommended):**

```bash
docker build -t paroli .
docker run -d --restart unless-stopped --name paroli --gpus all -p 8000:8000 paroli
```

The build bakes the Kokoro model weights directly into the image, so startup is fast but the image is large (~a few GB). No model downloads happen at runtime.

The server uses CUDA if available and falls back to CPU automatically. GPU mode requires driver 535+ (CUDA 12.2+) and [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. The image ships PyTorch cu121 wheels, which are compatible with any driver that supports CUDA 12.1 or later.

The server sets `X-Accel-Buffering: no` on responses, so streaming works correctly behind an nginx reverse proxy.

**Local (venv):**

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

## Testing

```bash
source venv/bin/activate
pip install pytest
pytest test_server.py -v
```
