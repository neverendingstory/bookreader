"""
Local server for the book reader.
- Serves static files from the project root.
- Exposes /api/tts that proxies text → edge-tts → audio/mpeg.
- Exposes /api/voices that lists available edge-tts voices.
Run: python3 server.py [port]
"""
from __future__ import annotations
import sys
import asyncio
import logging
import re
from pathlib import Path
from typing import List, Dict, Optional

import edge_tts
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bookreader")

ROOT = Path(__file__).parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

app = FastAPI(title="Book Reader", docs_url=None, redoc_url=None)

# --- TTS API ----------------------------------------------------------------

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"   # warm Chinese female voice
DEFAULT_RATE  = "+0%"
DEFAULT_PITCH = "+0Hz"

# Voices are loaded once at startup (small list, fast)
_VOICE_CACHE: Optional[List[Dict]] = None

@app.on_event("startup")
async def _load_voices():
    global _VOICE_CACHE
    try:
        voices = await edge_tts.list_voices()
        _VOICE_CACHE = [
            {
                "name": v["Name"],
                "short": v["ShortName"],
                "gender": v["Gender"],
                "locale": v["Locale"],
                "friendly": v.get("FriendlyName", v["Name"]),
            }
            for v in voices
        ]
        log.info("loaded %d voices", len(_VOICE_CACHE))
    except Exception as e:
        log.warning("could not list voices at startup: %s", e)
        _VOICE_CACHE = []

@app.get("/api/voices")
async def voices(locale: Optional[str] = Query(default=None)):
    if _VOICE_CACHE is None:
        return JSONResponse([])
    if locale:
        locale = locale.lower()
        return JSONResponse([v for v in _VOICE_CACHE if v["locale"].lower().startswith(locale)])
    return JSONResponse(_VOICE_CACHE)

def _split_for_tts(text: str, max_len: int = 3000) -> List[str]:
    """Split long text on paragraph/sentence boundaries so each TTS request stays under edge-tts limits."""
    if len(text) <= max_len:
        return [text]
    chunks, buf = [], ""
    for piece in re.split(r"(\n\n+|\.\s+)", text):
        if len(buf) + len(piece) > max_len and buf:
            chunks.append(buf.strip())
            buf = piece
        else:
            buf += piece
    if buf.strip():
        chunks.append(buf.strip())
    return chunks

@app.get("/api/tts")
async def tts(
    text: str = Query(..., min_length=1, max_length=20000),
    voice: str = Query(default=DEFAULT_VOICE),
    rate: str = Query(default=DEFAULT_RATE, pattern=r"^[+-]\d+%$"),
    pitch: str = Query(default=DEFAULT_PITCH, pattern=r"^[+-]\d+(Hz|%)$"),
):
    """Stream TTS audio as audio/mpeg. Multi-chunk for long text."""
    text = text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    chunks = _split_for_tts(text)
    log.info("tts: %d chars, %d chunk(s), voice=%s rate=%s", len(text), len(chunks), voice, rate)

    async def stream():
        for i, chunk in enumerate(chunks):
            try:
                communicate = edge_tts.Communicate(chunk, voice, rate=rate, pitch=pitch)
                async for ev in communicate.stream():
                    if ev["type"] == "audio":
                        yield ev["data"]
            except Exception as e:
                log.error("tts chunk %d failed: %s", i, e)
                return

    return StreamingResponse(stream(), media_type="audio/mpeg",
                            headers={"Cache-Control": "no-store"})

# --- Static files (must come AFTER API routes) ------------------------------

app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="static")

if __name__ == "__main__":
    log.info("serving %s on http://127.0.0.1:%d", ROOT, PORT)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
