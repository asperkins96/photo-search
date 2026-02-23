#!/usr/bin/env python3
import json
import os
import sys

import open_clip
import torch

MODEL_NAME = os.getenv("OPENCLIP_MODEL", "ViT-B-32")
MODEL_PRETRAINED = os.getenv("OPENCLIP_PRETRAINED", "laion2b_s34b_b79k")
DEVICE = os.getenv("EMBED_DEVICE", "cpu")

MODEL, _, _ = open_clip.create_model_and_transforms(
    MODEL_NAME, pretrained=MODEL_PRETRAINED, device=DEVICE
)
TOKENIZER = open_clip.get_tokenizer(MODEL_NAME)
MODEL.eval()


def embed_text(query: str) -> list[float]:
    tokens = TOKENIZER([query]).to(DEVICE)
    with torch.no_grad():
        features = MODEL.encode_text(tokens)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().tolist()


def write_message(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            req_id = msg.get("id")
            query = str(msg.get("q", "")).strip()
            if not query:
                write_message({"id": req_id, "error": "empty query"})
                continue
            vector = embed_text(query)
            write_message({"id": req_id, "vector": vector})
        except Exception as exc:  # noqa: BLE001
            write_message({"id": None, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
