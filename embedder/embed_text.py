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


def main() -> int:
    if len(sys.argv) != 2:
        print('Usage: python3 embedder/embed_text.py "query string"', file=sys.stderr)
        return 1

    vector = embed_text(sys.argv[1].strip())
    print(json.dumps(vector))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
