#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

import torch
from PIL import Image
import open_clip

MODEL = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"
TOP_K = 12
MIN_SCORE = 0.03

# Broad but lightweight vocabulary for zero-shot tagging.
CANDIDATE_TAGS = [
    "person", "people", "man", "woman", "child", "baby", "family", "couple", "friends", "group",
    "portrait", "selfie", "wedding", "engagement", "kiss", "hug", "smiling", "laughing", "dancing", "walking",
    "running", "jumping", "sitting", "standing", "eating", "drinking", "cooking", "playing", "working", "travel",
    "city", "street", "building", "architecture", "bridge", "road", "car", "bus", "train", "bicycle",
    "boat", "ship", "airplane", "beach", "ocean", "sea", "lake", "river", "water", "wave",
    "mountain", "forest", "tree", "flower", "garden", "park", "nature", "landscape", "sky", "cloud",
    "sun", "sunset", "sunrise", "night", "day", "golden hour", "rain", "snow", "fog", "storm",
    "indoors", "outdoors", "restaurant", "cafe", "kitchen", "bedroom", "living room", "office", "school", "store",
    "food", "drink", "coffee", "tea", "dessert", "fruit", "dog", "cat", "bird", "horse",
    "sports", "soccer", "basketball", "tennis", "swimming", "hiking", "camping", "festival", "concert", "party",
    "documentary", "film", "vintage", "black and white", "color", "fashion", "close-up", "wide shot", "crowd", "market",
]

STOPWORDS = {
    "a", "an", "the", "of", "and", "in", "at", "on", "for", "with", "to", "from", "by", "scene", "photo"
}


def build_caption(tags):
    if not tags:
        return "photo"
    lead = tags[0]
    extras = tags[1:5]
    if not extras:
        return f"photo of {lead}"
    return f"photo of {lead} with {', '.join(extras)}"


def extract_tokens(caption):
    words = re.findall(r"[a-zA-Z0-9]+", caption.lower())
    out = []
    seen = set()
    for w in words:
        if len(w) <= 2 or w in STOPWORDS:
            continue
        if w not in seen:
            out.append(w)
            seen.add(w)
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: caption.py <image_path>", file=sys.stderr)
        sys.exit(2)

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        print(f"image not found: {image_path}", file=sys.stderr)
        sys.exit(2)

    device = "cuda" if torch.cuda.is_available() else "cpu"

    model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED, device=device)
    tokenizer = open_clip.get_tokenizer(MODEL)

    image = preprocess(Image.open(image_path).convert("RGB")).unsqueeze(0).to(device)
    prompts = [f"a photo of {label}" for label in CANDIDATE_TAGS]
    tokens = tokenizer(prompts).to(device)

    with torch.no_grad():
        image_features = model.encode_image(image)
        text_features = model.encode_text(tokens)
        image_features /= image_features.norm(dim=-1, keepdim=True)
        text_features /= text_features.norm(dim=-1, keepdim=True)
        logits = (100.0 * image_features @ text_features.T).squeeze(0)
        probs = logits.softmax(dim=0)

    sorted_idx = torch.argsort(probs, descending=True).tolist()
    selected = []
    for idx in sorted_idx:
        score = float(probs[idx].item())
        if len(selected) >= TOP_K:
            break
        if score < MIN_SCORE and len(selected) >= 5:
            break
        selected.append((CANDIDATE_TAGS[idx], score))

    tags = [tag for tag, _ in selected]
    caption = build_caption(tags)

    # Add useful lexical tokens from caption itself.
    merged = []
    seen = set()
    for tag in tags + extract_tokens(caption):
        t = tag.strip().lower()
        if not t or t in seen:
            continue
        seen.add(t)
        merged.append(t)

    print(json.dumps({"caption": caption, "tags": merged[:24]}))


if __name__ == "__main__":
    main()
