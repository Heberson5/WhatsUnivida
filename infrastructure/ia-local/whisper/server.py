"""Transcrição de áudio do Assistente Virtual — Whisper large-v3-turbo (faster-whisper), na própria VPS.

POST /transcribe?language=pt  corpo = o arquivo de áudio (ogg/opus do WhatsApp, mp3, m4a...) -> {"text": "..."}
GET  /health                   -> {"ready": true|false, "model": "..."}

Um áudio por vez (a VPS tem poucos núcleos); os outros esperam na fila. Nada sai da VPS: o modelo é baixado uma
vez para o volume /models e o áudio nunca vai para fora.
"""
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "2"))
MAX_BYTES = int(os.environ.get("WHISPER_MAX_MB", "25")) * 1024 * 1024
PORT = int(os.environ.get("PORT", "9000"))

state = {"model": None, "error": None}
lock = threading.Lock()


def load_model():
    try:
        from faster_whisper import WhisperModel

        state["model"] = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS, download_root="/models")
        print(f"modelo {MODEL_NAME} pronto", flush=True)
    except Exception as exc:  # noqa: BLE001 — reported on /health, retried on the next request
        state["error"] = str(exc)
        print(f"falha ao carregar o modelo: {exc}", flush=True)


def ensure_model():
    """Loads the model once — the startup thread and a request arriving meanwhile never load it twice."""
    with lock:
        if state["model"] is None:
            load_model()
    return state["model"]


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):  # quiet: only errors are printed
        pass

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._json(200, {"ready": state["model"] is not None, "model": MODEL_NAME, "error": state["error"]})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {"error": "áudio vazio ou grande demais"})
        audio = self.rfile.read(length)
        if ensure_model() is None:
            return self._json(503, {"error": "modelo ainda não está pronto", "detail": state["error"]})
        language = parse_qs(url.query).get("language", ["pt"])[0]
        with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
            tmp.write(audio)
            tmp.flush()
            try:
                with lock:
                    segments, _info = state["model"].transcribe(tmp.name, language=language, beam_size=1, vad_filter=True)
                    text = " ".join(segment.text.strip() for segment in segments).strip()
            except Exception as exc:  # noqa: BLE001
                return self._json(422, {"error": f"não foi possível transcrever: {exc}"})
        return self._json(200, {"text": text})


if __name__ == "__main__":
    threading.Thread(target=ensure_model, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
