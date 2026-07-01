"""
Plan classifier inference server.

POST /classify
    Body:  {"text": "识别图片内容然后做成excel发给我"}
    Reply: {"plan": ["vision", "file", "slack"], "confidence": 0.94}

    Single-step example:
    Reply: {"plan": ["chat"], "confidence": 0.99}

GET /health
    Reply: {"ok": true}

Usage:
    python serve.py                        # default port 9876
    python serve.py --port 9876 --model-dir model/
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import BertTokenizer

SCRIPT_DIR = Path(__file__).parent

SEPARATOR = "→"

_tokenizer = None
_session   = None
_labels    = None


def load_model(model_dir: Path):
    global _tokenizer, _session, _labels
    import os
    _tokenizer = BertTokenizer.from_pretrained(str(model_dir))
    # onnxruntime resolves external data files relative to cwd, not the model path
    prev_cwd = os.getcwd()
    os.chdir(str(model_dir))
    try:
        _session = ort.InferenceSession("classifier.onnx")
    finally:
        os.chdir(prev_cwd)
    with open(model_dir / "labels.json") as f:
        _labels = json.load(f)
    print(f"Model loaded from {model_dir}  labels={_labels}")


def classify(text: str) -> tuple[list[str], float]:
    enc = _tokenizer(
        [text], return_tensors="np",
        padding=True, truncation=True, max_length=128,
    )
    logits = _session.run(
        None,
        {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]},
    )[0][0]
    probs = np.exp(logits) / np.exp(logits).sum()
    idx   = int(probs.argmax())
    label = _labels[idx]
    conf  = float(probs[idx])
    # Split "vision→file→slack" into ["vision", "file", "slack"]
    plan  = label.split(SEPARATOR)
    return plan, conf


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence access log

    def _send_json(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length))
        text   = body.get("text", "")
        if not text:
            self._send_json(400, {"error": "missing text"})
            return
        plan, confidence = classify(text)
        self._send_json(200, {"plan": plan, "confidence": confidence})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",      type=int, default=9876)
    parser.add_argument("--host",      default="127.0.0.1",
                        help="Bind address. Use 0.0.0.0 to allow LAN access.")
    parser.add_argument("--model-dir", default=str(SCRIPT_DIR / "model"))
    args = parser.parse_args()

    load_model(Path(args.model_dir))
    server = HTTPServer((args.host, args.port), Handler)
    print(f"Classifier listening on http://{args.host}:{args.port}")
    server.serve_forever()
