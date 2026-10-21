"""Local NLLB-200 translation server for Nightbeacon (TRANSLATION_PROVIDER=…,nllb).

Meta's NLLB-200 distilled model, converted for CTranslate2 (fast, int8,
CPU). Free, unlimited, offline. Set up once with tools/nllb/setup.ps1, then
it's started by start.cmd. Listens on 127.0.0.1:6060 (NLLB_PORT).

POST /translate  {"text": "...", "src": "arb_Arab"}  ->  {"text": "..."}
GET  /health                                         ->  {"ok": true}
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctranslate2
import transformers

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("NLLB_MODEL_DIR", os.path.join(HERE, "model"))
PORT = int(os.environ.get("NLLB_PORT", "6060"))
MAX_TOKENS = 200  # per piece; longer lines are split on sentence ends

tokenizer = transformers.AutoTokenizer.from_pretrained(MODEL_DIR)
translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8", intra_threads=os.cpu_count() or 4)


def pieces(text):
    """Lines, with long lines split into sentences, keeping empty lines."""
    for line in text.split("\n"):
        if not line.strip():
            yield ""
            continue
        if len(tokenizer.tokenize(line)) <= MAX_TOKENS:
            yield line
            continue
        for sentence in re.split(r"(?<=[.!?؟。])\s+", line):
            if sentence.strip():
                yield sentence


def translate(text, src):
    tokenizer.src_lang = src
    parts = list(pieces(text))
    todo = [i for i, p in enumerate(parts) if p]
    if not todo:
        return text
    batch = [tokenizer.convert_ids_to_tokens(tokenizer.encode(parts[i])) for i in todo]
    results = translator.translate_batch(
        batch, target_prefix=[["eng_Latn"]] * len(batch), beam_size=2, max_decoding_length=MAX_TOKENS * 2
    )
    out = list(parts)
    for i, r in zip(todo, results):
        tokens = r.hypotheses[0][1:]  # drop the target-language token
        out[i] = tokenizer.decode(tokenizer.convert_tokens_to_ids(tokens), skip_special_tokens=True)
    return "\n".join(out)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/translate":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text, src = body.get("text", ""), body.get("src", "")
            if not text or not re.fullmatch(r"[a-z]{3}_[A-Za-z]{4}", src):
                return self._send(400, {"error": "text and src (e.g. arb_Arab) are required"})
            self._send(200, {"text": translate(text, src)})
        except Exception as e:  # keep serving; the caller tries another provider
            self._send(500, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"NLLB translation server on http://127.0.0.1:{PORT} (model: {MODEL_DIR})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
