#!/usr/bin/env python3
import json
import os
import sys

import open_clip
import torch
from PIL import Image

MODEL_NAME = os.getenv("OPENCLIP_MODEL", "ViT-B-32")
MODEL_PRETRAINED = os.getenv("OPENCLIP_PRETRAINED", "laion2b_s34b_b79k")
DEVICE = os.getenv("EMBED_DEVICE", "cpu")

MODEL, _, PREPROCESS = open_clip.create_model_and_transforms(
    MODEL_NAME, pretrained=MODEL_PRETRAINED, device=DEVICE
)
MODEL.eval()


def embed_image(image_path: str) -> list[float]:
    image = Image.open(image_path).convert("RGB")
    image_tensor = PREPROCESS(image).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        features = MODEL.encode_image(image_tensor)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().tolist()


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 embedder/embed.py /path/to/image.jpg", file=sys.stderr)
        return 1

    vector = embed_image(sys.argv[1])
    print(json.dumps(vector))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
