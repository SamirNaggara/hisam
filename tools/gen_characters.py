#!/usr/bin/env python3
"""Genere assets/characters.png + characters.json : avatars pixel art 16x20,
4 directions x 3 frames, une ligne par variante de palette.

    python3 tools/gen_characters.py              # ecrit assets/characters.{png,json}
    python3 tools/gen_characters.py --preview /tmp/chars.png   # apercu 4x

Les sprites sont dessines dans des templates ASCII (voir legende ci-dessous),
aucun asset externe. Licence CC0 comme le reste du projet.
"""
import argparse
import json
import os

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PNG = os.path.join(ROOT, "assets", "characters.png")
OUT_JSON = os.path.join(ROOT, "assets", "characters.json")

W, H = 16, 20
DIRS = ["down", "left", "right", "up"]  # ordre des colonnes dans la planche
FRAMES_PER_DIR = 3                       # 0 idle, 1 pas A, 2 pas B
WALK_CYCLE = [1, 0, 2, 0]
FPS = 8

# Legende : . transparent, K contour, S peau, s ombre peau, H cheveux, h ombre cheveux,
# E oeil, T tee-shirt, t ombre tee-shirt, P pantalon, B chaussures

DOWN_IDLE = [
    "................",
    "....KKKKKKKK....",
    "...KHHHHHHHHK...",
    "..KHHHHHHHHHHK..",
    "..KHHhHHHHhHHK..",
    "..KHSSSSSSSSHK..",
    "..KHSSSSSSSSHK..",
    "..KSSESSSSESSK..",
    "..KSSESSSSESSK..",
    "...KSSSssSSSK...",
    "....KSSSSSSK....",
    "...KTTTTTTTTK...",
    "..KSTTTtTTTTSK..",
    "..KSTTTTTTTTSK..",
    "..KSTTtTTTTtSK..",
    "...KPPPPPPPPK...",
    "...KPPPKKPPPK...",
    "...KPPK..KPPK...",
    "...KBBK..KBBK...",
    "...KKKK..KKKK...",
]

UP_IDLE = [
    "................",
    "....KKKKKKKK....",
    "...KHHHHHHHHK...",
    "..KHHHHHHHHHHK..",
    "..KHHHHHHHHHHK..",
    "..KHHhHHHHHhHK..",
    "..KHHHHHHHHHHK..",
    "..KHHHHHHHHHHK..",
    "..KHHHHhHHHHHK..",
    "...KHHHHHHHHK...",
    "....KSSSSSSK....",
    "...KTTTTTTTTK...",
    "..KSTTTTTTTTSK..",
    "..KSTTTTTTTTSK..",
    "..KSTTTTTTTTSK..",
    "...KPPPPPPPPK...",
    "...KPPPKKPPPK...",
    "...KPPK..KPPK...",
    "...KBBK..KBBK...",
    "...KKKK..KKKK...",
]

RIGHT_IDLE = [
    "................",
    "....KKKKKKKK....",
    "...KHHHHHHHHK...",
    "..KHHHHHHHHHHK..",
    "..KHHHHHhHHHHK..",
    "..KHHHHSSSSSHK..",
    "..KHHHSSSSSSSK..",
    "..KHHHSSSSESSK..",
    "..KHHHSSSSESSK..",
    "...KHHSSSSSSK...",
    "....KSSSSSSK....",
    "....KTTTTTTK....",
    "...KTTTTTTTTK...",
    "...KTTTTSTTTK...",
    "...KTTTTSTTTK...",
    "....KPPPPPPK....",
    "....KPPPPPPK....",
    "....KPPPPPPK....",
    "....KBBBBBBK....",
    "....KKKKKKKK....",
]

# Frames de marche vue de face / de dos : le corps monte d'un pixel ("bob"),
# une jambe est tendue, l'autre repliee.
FRONT_LEGS_A = [
    "...KPPPKKPPPK...",
    "...KPPK..KPPK...",
    "...KBBK..KPPK...",
    "...KKKK..KBBK...",
    ".........KKKK...",
]

# Profil : jambes ecartees (A) puis jambes qui se croisent (B)
SIDE_LEGS_A = [
    "....KPPPPPPK....",
    "...KPPPKPPPPK...",
    "..KPPPK..KPPPK..",
    "..KBBBK..KBBBK..",
    "..KKKKK..KKKKK..",
]
SIDE_LEGS_B = [
    "....KPPPPPPK....",
    "....KPPPPPPK....",
    "....KPPKKPPK....",
    "....KBBK.KBBK...",
    "....KKKK.KKKK...",
]


def walk_frame(idle, legs):
    """Corps decale d'un pixel vers le haut + nouvelles jambes."""
    body = idle[1:15]  # 14 lignes (la ligne 0 est vide)
    return body + legs + [] if len(body + legs) == H else body + legs + ["................"] * (H - len(body + legs))


def mirror_rows(rows):
    return [r[::-1] for r in rows]


def build_templates():
    down_a = walk_frame(DOWN_IDLE, FRONT_LEGS_A)
    up_a = walk_frame(UP_IDLE, FRONT_LEGS_A)
    right_a = walk_frame(RIGHT_IDLE, SIDE_LEGS_A)
    right_b = walk_frame(RIGHT_IDLE, SIDE_LEGS_B)
    right = [RIGHT_IDLE, right_a, right_b]
    return {
        "down": [DOWN_IDLE, down_a, mirror_rows(down_a)],
        "up": [UP_IDLE, up_a, mirror_rows(up_a)],
        "right": right,
        "left": [mirror_rows(f) for f in right],
    }


VARIANTS = [
    {"name": "teal",   "skin": "#f1c27d", "hair": "#3b2314", "shirt": "#0d9488", "pants": "#2b3a67"},
    {"name": "rouge",  "skin": "#f1c27d", "hair": "#e8c15a", "shirt": "#dc4c4c", "pants": "#2a2a2a"},
    {"name": "bleu",   "skin": "#d9a066", "hair": "#1e1e28", "shirt": "#3b82f6", "pants": "#2b3a67"},
    {"name": "jaune",  "skin": "#8d5524", "hair": "#1e1e28", "shirt": "#f4b942", "pants": "#5a3d2b"},
    {"name": "vert",   "skin": "#f1c27d", "hair": "#c8452c", "shirt": "#3fae6e", "pants": "#2a2a2a"},
    {"name": "violet", "skin": "#d9a066", "hair": "#6b4423", "shirt": "#8b5cf6", "pants": "#2b3a67"},
    {"name": "blanc",  "skin": "#8d5524", "hair": "#3b2314", "shirt": "#e7e5e4", "pants": "#2a2a2a"},
    {"name": "rose",   "skin": "#f1c27d", "hair": "#d4d4d4", "shirt": "#ec6fa0", "pants": "#5a3d2b"},
]

OUTLINE = (26, 26, 46, 255)
SHOE = (40, 32, 32, 255)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def shade(rgb, f=0.82):
    return tuple(int(c * f) for c in rgb)


def palette(v):
    skin, hair, shirt, pants = (hex_rgb(v[k]) for k in ("skin", "hair", "shirt", "pants"))
    return {
        "K": OUTLINE,
        "E": OUTLINE,
        "S": skin + (255,), "s": shade(skin) + (255,),
        "H": hair + (255,), "h": shade(hair, 0.72) + (255,),
        "T": shirt + (255,), "t": shade(shirt) + (255,),
        "P": pants + (255,), "p": shade(pants) + (255,),
        "B": SHOE,
    }


def render(rows, pal):
    assert len(rows) == H, len(rows)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(rows):
        assert len(row) == W, (y, row)
        for x, ch in enumerate(row):
            if ch != ".":
                px[x, y] = pal[ch]
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", help="ecrit un apercu agrandi 4x a ce chemin")
    args = ap.parse_args()

    templates = build_templates()
    cols = len(DIRS) * FRAMES_PER_DIR
    sheet = Image.new("RGBA", (W * cols, H * len(VARIANTS)), (0, 0, 0, 0))
    for vi, variant in enumerate(VARIANTS):
        pal = palette(variant)
        for di, d in enumerate(DIRS):
            for fi in range(FRAMES_PER_DIR):
                sheet.paste(render(templates[d][fi], pal), ((di * FRAMES_PER_DIR + fi) * W, vi * H))

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    sheet.save(OUT_PNG, optimize=True)
    with open(OUT_JSON, "w") as f:
        json.dump({
            "frameW": W, "frameH": H,
            "dirs": DIRS, "framesPerDir": FRAMES_PER_DIR,
            "walkCycle": WALK_CYCLE, "fps": FPS,
            "variants": VARIANTS,
        }, f, indent=2, ensure_ascii=False)
    print(f"{OUT_PNG} {sheet.size[0]}x{sheet.size[1]} ({os.path.getsize(OUT_PNG)} octets), {len(VARIANTS)} variantes")

    if args.preview:
        big = sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (90, 90, 100, 255))
        bg.alpha_composite(big)
        bg.save(args.preview)
        print("apercu :", args.preview)


if __name__ == "__main__":
    main()
