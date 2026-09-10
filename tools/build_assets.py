#!/usr/bin/env python3
"""Construit assets/tileset.png + assets/tileset.json.

Sources :
  - Kenney "Roguelike Modern City" et "Roguelike Indoors" (CC0), telecharges a la
    demande dans tools/.cache/ (ou fournis avec --zip-city / --zip-indoor)
  - tuiles procedurales dessinees ici (sols, murs, ecran, tableau blanc, cafe...)

Seules les tuiles listees dans MANIFEST sont extraites, pour que le depot n'embarque
qu'une petite planche. Pour choisir des indices :

    python3 tools/build_assets.py --contact-sheet /tmp/contact   # city.png / indoor.png numerotes
"""
import argparse
import io
import json
import math
import os
import re
import urllib.request
import zipfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
T = 16

PACKS = {
    "city": "https://kenney.nl/media/pages/assets/roguelike-modern-city/0ff3dfff2b-1677694743/kenney_roguelike-modern-city.zip",
    "indoor": "https://kenney.nl/media/pages/assets/roguelike-indoors/4d5b520b03-1702169567/kenney_roguelike-indoors.zip",
}

# ---------------------------------------------------------------------------
# Tuiles procedurales
# ---------------------------------------------------------------------------

def _noise(x, y, seed=0):
    v = math.sin(x * 12.9898 + y * 78.233 + seed * 3.7) * 43758.5453
    return v - math.floor(v)


def _fill_noise(im, base, amp=6, seed=0):
    px = im.load()
    for y in range(T):
        for x in range(T):
            n = int((_noise(x, y, seed) - 0.5) * 2 * amp)
            px[x, y] = tuple(max(0, min(255, c + n)) for c in base) + (255,)


def gen_floor_carpet(seed=1):
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (146, 158, 172), 5, seed)
    return im


def gen_floor_carpet_alt():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (140, 152, 166), 5, 2)
    return im


def gen_floor_wood():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (200, 164, 116), 4, 3)
    d = ImageDraw.Draw(im)
    for y in (3, 7, 11, 15):
        d.line([(0, y), (T - 1, y)], fill=(172, 136, 92, 255))
    d.line([(9, 0), (9, 3)], fill=(172, 136, 92, 255))
    d.line([(3, 4), (3, 7)], fill=(172, 136, 92, 255))
    d.line([(12, 8), (12, 11)], fill=(172, 136, 92, 255))
    d.line([(6, 12), (6, 15)], fill=(172, 136, 92, 255))
    return im


def gen_floor_tile():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (218, 218, 212), 3, 4)
    d = ImageDraw.Draw(im)
    d.line([(0, 7), (T - 1, 7)], fill=(190, 190, 184, 255))
    d.line([(0, 15), (T - 1, 15)], fill=(190, 190, 184, 255))
    d.line([(7, 0), (7, T - 1)], fill=(190, 190, 184, 255))
    d.line([(15, 0), (15, T - 1)], fill=(190, 190, 184, 255))
    return im


def gen_mat():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (128, 62, 54), 5, 5)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, T - 1, T - 1], outline=(96, 44, 40, 255))
    return im


def gen_grass():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (112, 168, 92), 7, 6)
    px = im.load()
    for (x, y) in ((2, 3), (9, 6), (5, 12), (13, 13), (11, 1)):
        px[x, y] = (86, 138, 70, 255)
    return im


def gen_pavement():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (176, 176, 170), 4, 7)
    d = ImageDraw.Draw(im)
    d.line([(0, 7), (T - 1, 7)], fill=(150, 150, 146, 255))
    d.line([(7, 0), (7, 7)], fill=(150, 150, 146, 255))
    d.line([(11, 8), (11, T - 1)], fill=(150, 150, 146, 255))
    return im


def gen_wall_top():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (92, 84, 96), 4, 8)
    d = ImageDraw.Draw(im)
    d.line([(0, 0), (T - 1, 0)], fill=(120, 112, 124, 255))
    return im


def gen_wall_face():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (226, 214, 190), 3, 9)
    d = ImageDraw.Draw(im)
    d.line([(0, 0), (T - 1, 0)], fill=(196, 182, 156, 255))
    d.rectangle([0, 13, T - 1, 15], fill=(170, 150, 120, 255))
    d.line([(0, 13), (T - 1, 13)], fill=(150, 130, 104, 255))
    return im


def gen_monitor_overlay():
    """Ecran + clavier a poser sur une table."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([3, 2, 12, 9], fill=(40, 40, 48, 255))
    d.rectangle([4, 3, 11, 8], fill=(120, 190, 220, 255))
    d.rectangle([5, 4, 8, 4], fill=(200, 235, 245, 255))
    d.rectangle([5, 6, 10, 6], fill=(90, 160, 200, 255))
    d.rectangle([7, 10, 8, 10], fill=(40, 40, 48, 255))
    d.rectangle([5, 11, 10, 11], fill=(40, 40, 48, 255))
    d.rectangle([4, 13, 11, 14], fill=(70, 70, 80, 255))
    d.line([(5, 13), (10, 13)], fill=(110, 110, 120, 255))
    return im


def gen_laptop_overlay():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, 11, 9], fill=(60, 60, 70, 255))
    d.rectangle([5, 5, 10, 8], fill=(130, 200, 225, 255))
    d.rectangle([3, 10, 12, 12], fill=(90, 90, 100, 255))
    d.line([(4, 11), (11, 11)], fill=(130, 130, 140, 255))
    return im


def gen_papers_overlay():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([4, 5, 10, 12], fill=(245, 243, 235, 255))
    d.rectangle([6, 4, 12, 11], fill=(250, 248, 240, 255), outline=(210, 205, 190, 255))
    for y in (6, 8, 10):
        d.line([(7, y), (11, y)], fill=(180, 180, 175, 255))
    d.rectangle([11, 9, 13, 13], fill=(60, 60, 70, 255))  # mug
    return im


def gen_whiteboard_overlay():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([1, 2, 14, 11], fill=(250, 250, 250, 255), outline=(150, 150, 160, 255))
    d.line([(3, 4), (9, 4)], fill=(13, 148, 136, 255))
    d.line([(3, 6), (11, 6)], fill=(60, 60, 70, 255))
    d.line([(3, 8), (7, 8)], fill=(220, 80, 80, 255))
    d.rectangle([9, 8, 11, 9], fill=(60, 60, 70, 255))
    d.rectangle([2, 11, 13, 12], fill=(170, 170, 180, 255))
    return im


def gen_coffee_overlay():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([4, 1, 11, 10], fill=(50, 50, 58, 255))
    d.rectangle([5, 2, 10, 4], fill=(90, 90, 100, 255))
    d.rectangle([6, 6, 9, 8], fill=(20, 20, 26, 255))
    d.point((10, 3), fill=(230, 60, 60, 255))
    d.rectangle([7, 8, 8, 9], fill=(230, 230, 230, 255))  # tasse
    return im


def gen_void():
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (38, 36, 40), 2, 10)
    return im


def gen_screen_overlay():
    """Ecran mural (salle de reunion)."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 2, 15, 11], fill=(215, 215, 220, 255))
    d.rectangle([1, 3, 14, 10], fill=(30, 32, 40, 255))
    d.line([(2, 4), (7, 4)], fill=(70, 80, 100, 255))
    d.rectangle([9, 4, 13, 8], fill=(60, 120, 150, 255))
    d.line([(2, 6), (6, 6)], fill=(13, 148, 136, 255))
    d.line([(2, 8), (7, 8)], fill=(90, 90, 110, 255))
    return im


WOOD = (196, 156, 104)
WOOD_EDGE = (140, 104, 62)
WOOD_LIGHT = (214, 178, 128)


def _bigtable(edges):
    """9-slice de grande table : edges = ensemble parmi {"t","b","l","r"}."""
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, WOOD, 3, 11)
    d = ImageDraw.Draw(im)
    if "t" in edges:
        d.line([(0, 0), (T - 1, 0)], fill=WOOD_EDGE + (255,))
        d.line([(0, 1), (T - 1, 1)], fill=WOOD_LIGHT + (255,))
    if "b" in edges:
        d.rectangle([0, 13, T - 1, 15], fill=WOOD_EDGE + (255,))
        d.line([(0, 12), (T - 1, 12)], fill=(120, 88, 52, 255))
    if "l" in edges:
        d.line([(0, 0), (0, T - 1)], fill=WOOD_EDGE + (255,))
        d.line([(1, 1), (1, T - 1)], fill=WOOD_LIGHT + (255,))
    if "r" in edges:
        d.line([(T - 1, 0), (T - 1, T - 1)], fill=WOOD_EDGE + (255,))
    return im


def gen_fruits_overlay():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([3, 6, 12, 11], fill=(120, 80, 50, 255))
    d.rectangle([4, 8, 11, 11], fill=(120, 80, 50, 255))
    for (x, y, c) in ((5, 5, (220, 60, 50)), (8, 4, (240, 170, 40)), (10, 6, (110, 180, 60)), (7, 7, (240, 100, 40))):
        d.ellipse([x, y, x + 2, y + 2], fill=c + (255,))
    return im


def gen_floor_marble():
    """Sol clair et chic pour les salles de reunion."""
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (236, 234, 228), 2, 12)
    d = ImageDraw.Draw(im)
    d.line([(0, 15), (T - 1, 15)], fill=(214, 210, 200, 255))
    d.line([(15, 0), (15, T - 1)], fill=(214, 210, 200, 255))
    d.line([(2, 11), (7, 4)], fill=(222, 218, 210, 255))
    d.line([(9, 13), (13, 8)], fill=(224, 220, 212, 255))
    return im


def _tv(part):
    """Grande tele sur pied, plusieurs tuiles de large (part = "l", "m" ou "r")."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x0 = 1 if part == "l" else 0
    x1 = T - 2 if part == "r" else T - 1
    d.rectangle([x0, 1, x1, 11], fill=(40, 40, 48, 255))          # cadre
    sx0 = x0 + 1 if part == "l" else 0
    sx1 = x1 - 1 if part == "r" else T - 1
    d.rectangle([sx0, 2, sx1, 10], fill=(52, 110, 150, 255))       # dalle
    if part == "l":
        d.line([(sx0 + 1, 3), (T - 1, 3)], fill=(140, 195, 225, 255))
        d.rectangle([13, 12, 15, 13], fill=(60, 60, 70, 255))       # pied
    elif part == "m":
        d.line([(0, 3), (T - 1, 3)], fill=(140, 195, 225, 255))
        d.rectangle([3, 5, 12, 8], fill=(80, 150, 190, 255))
        d.rectangle([0, 12, 15, 13], fill=(60, 60, 70, 255))
        d.rectangle([0, 14, 15, 14], fill=(90, 90, 100, 255))
    else:
        d.line([(0, 3), (sx1 - 1, 3)], fill=(140, 195, 225, 255))
        d.rectangle([0, 12, 2, 13], fill=(60, 60, 70, 255))
    return im


HIGH = (112, 78, 52)
HIGH_EDGE = (78, 52, 34)


def _hightable(part):
    """Table haute d'un seul tenant, 3 morceaux (l, m, r)."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x0 = 1 if part == "l" else 0
    x1 = T - 2 if part == "r" else T - 1
    d.rectangle([x0, 3, x1, 10], fill=HIGH + (255,))
    d.line([(x0, 3), (x1, 3)], fill=(140, 100, 70, 255))
    d.rectangle([x0, 10, x1, 11], fill=HIGH_EDGE + (255,))
    if part == "l":
        d.line([(x0, 3), (x0, 11)], fill=HIGH_EDGE + (255,))
        d.rectangle([2, 12, 3, 15], fill=HIGH_EDGE + (255,))
    if part == "r":
        d.line([(x1, 3), (x1, 11)], fill=HIGH_EDGE + (255,))
        d.rectangle([12, 12, 13, 15], fill=HIGH_EDGE + (255,))
    return im


# ---------------------------------------------------------------------------
# Coin salon : fauteuils cuir marron, canapes et table basse
# Les meubles multi-cases sont dessines d'un seul tenant puis decoupes, ce qui
# evite les raccords approximatifs d'une tuile a l'autre.
# ---------------------------------------------------------------------------

LEATHER = (124, 74, 42)      # dossiers et accoudoirs, dans l'ombre
LEATHER_HI = (190, 122, 70)  # coussins d'assise, en pleine lumiere
LEATHER_LO = (86, 50, 26)    # creux entre deux coussins
FRAME = (120, 84, 54)
FRAME_HI = (156, 116, 76)
FRAME_LO = (68, 46, 30)
RUG = (86, 116, 118)
RUG_DARK = (52, 78, 82)
RUG_LIGHT = (132, 162, 158)


def _a(c):
    return c + (255,)


_PIECE_CACHE = {}


def _piece(draw_fn, w, h):
    """Dessine un meuble de w x h cases et renvoie l'image complete (en cache)."""
    key = (draw_fn, w, h)
    im = _PIECE_CACHE.get(key)
    if im is None:
        im = Image.new("RGBA", (w * T, h * T), (0, 0, 0, 0))
        draw_fn(ImageDraw.Draw(im))
        _PIECE_CACHE[key] = im
    return im


def _cut(draw_fn, w, h, cx, cy, mirror=False):
    """Une case (cx, cy) d'un meuble de w x h cases, eventuellement en miroir."""
    im = _piece(draw_fn, w, h)
    if mirror:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
        cx = w - 1 - cx
    return im.crop((cx * T, cy * T, cx * T + T, cy * T + T))


def _draw_armchair_down(d):
    """Fauteuil club : dossier au nord, on s'y assoit face au sud."""
    d.rectangle([3, 13, 4, 15], fill=_a(FRAME_LO))                          # pieds
    d.rectangle([11, 13, 12, 15], fill=_a(FRAME_LO))
    d.rectangle([2, 1, 13, 6], fill=_a(LEATHER), outline=_a(FRAME_LO))      # dossier
    d.line([(3, 2), (12, 2)], fill=_a(LEATHER_HI))
    d.rectangle([1, 5, 4, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))      # accoudoirs
    d.rectangle([11, 5, 14, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))
    d.rectangle([4, 6, 11, 12], fill=_a(LEATHER_HI), outline=_a(FRAME_LO))  # coussin
    d.line([(5, 9), (10, 9)], fill=_a(LEATHER_LO))


def _draw_armchair_up(d):
    """Meme fauteuil vu de dos : on s'y assoit face au nord."""
    d.rectangle([3, 13, 4, 15], fill=_a(FRAME_LO))
    d.rectangle([11, 13, 12, 15], fill=_a(FRAME_LO))
    d.rectangle([4, 2, 11, 8], fill=_a(LEATHER_HI), outline=_a(FRAME_LO))   # coussin qui depasse
    d.rectangle([1, 4, 4, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))      # accoudoirs
    d.rectangle([11, 4, 14, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))
    d.rectangle([2, 7, 13, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))     # dossier de dos
    d.line([(3, 8), (12, 8)], fill=_a(LEATHER_HI))


def _draw_armchair_right(d):
    """Meme fauteuil de profil : dossier a l'ouest, on s'y assoit face a l'est."""
    d.rectangle([2, 13, 3, 15], fill=_a(FRAME_LO))
    d.rectangle([11, 13, 12, 15], fill=_a(FRAME_LO))
    d.rectangle([1, 2, 5, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))      # dossier
    d.line([(2, 3), (2, 12)], fill=_a(LEATHER_HI))
    d.rectangle([5, 1, 14, 4], fill=_a(LEATHER), outline=_a(FRAME_LO))      # accoudoirs
    d.rectangle([5, 11, 14, 14], fill=_a(LEATHER), outline=_a(FRAME_LO))
    d.rectangle([5, 4, 13, 11], fill=_a(LEATHER_HI), outline=_a(FRAME_LO))  # coussin
    d.line([(9, 5), (9, 10)], fill=_a(LEATHER_LO))


def _draw_sofa_up(d):
    """Canape trois places vu de dos : on s'y assoit face au nord."""
    for x in (2, 22, 42):                                                   # pieds
        d.rectangle([x, 13, x + 3, 15], fill=_a(FRAME_LO))
    d.rectangle([4, 1, 43, 7], fill=_a(LEATHER_HI), outline=_a(FRAME_LO))   # coussins qui depassent
    for x in (16, 17, 30, 31):
        d.line([(x, 2), (x, 6)], fill=_a(LEATHER_LO))
    d.rectangle([3, 6, 44, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))     # dossier de dos
    d.line([(4, 7), (43, 7)], fill=_a(LEATHER_HI))
    d.rectangle([0, 3, 4, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))      # accoudoirs
    d.rectangle([43, 3, 47, 13], fill=_a(LEATHER), outline=_a(FRAME_LO))


def _draw_sofa_east(d):
    """Canape trois places de profil : dossier a l'ouest, on s'y assoit face a l'est."""
    d.rectangle([2, 45, 4, 47], fill=_a(FRAME_LO))                          # pieds
    d.rectangle([11, 45, 13, 47], fill=_a(FRAME_LO))
    d.rectangle([1, 3, 5, 44], fill=_a(LEATHER), outline=_a(FRAME_LO))      # dossier
    d.line([(4, 4), (4, 43)], fill=_a(LEATHER_LO))
    d.rectangle([4, 1, 14, 5], fill=_a(LEATHER), outline=_a(FRAME_LO))      # accoudoirs
    d.rectangle([4, 42, 14, 46], fill=_a(LEATHER), outline=_a(FRAME_LO))
    d.rectangle([5, 5, 14, 42], fill=_a(LEATHER_HI), outline=_a(FRAME_LO))  # coussins
    for y in (16, 17, 30, 31):
        d.line([(6, y), (13, y)], fill=_a(LEATHER_LO))
    for y in (7, 20, 33):
        d.line([(7, y), (12, y)], fill=_a(WOOD_LIGHT))


def _draw_lowtable(d):
    """Table basse carree de deux cases de cote, plateau bois et pieds visibles."""
    d.rectangle([6, 22, 9, 28], fill=_a(FRAME_LO))                          # pieds avant
    d.rectangle([22, 22, 25, 28], fill=_a(FRAME_LO))
    d.rectangle([2, 3, 29, 23], fill=_a(WOOD), outline=_a(FRAME_LO))        # plateau
    d.line([(3, 4), (28, 4)], fill=_a(WOOD_LIGHT))
    d.rectangle([2, 21, 29, 23], fill=_a(FRAME))                            # chant
    d.rectangle([5, 7, 26, 18], outline=_a(FRAME_HI))                       # veine du plateau


def _rug(edges):
    """9-slice de tapis : edges = ensemble parmi {"t", "b", "l", "r"}."""
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, RUG, 4, 21)
    d = ImageDraw.Draw(im)
    if "t" in edges:
        d.line([(0, 0), (T - 1, 0)], fill=_a(RUG_DARK))
        d.line([(0, 2), (T - 1, 2)], fill=_a(RUG_LIGHT))
    if "b" in edges:
        d.line([(0, T - 1), (T - 1, T - 1)], fill=_a(RUG_DARK))
        d.line([(0, T - 3), (T - 1, T - 3)], fill=_a(RUG_LIGHT))
    if "l" in edges:
        d.line([(0, 0), (0, T - 1)], fill=_a(RUG_DARK))
        d.line([(2, 0), (2, T - 1)], fill=_a(RUG_LIGHT))
    if "r" in edges:
        d.line([(T - 1, 0), (T - 1, T - 1)], fill=_a(RUG_DARK))
        d.line([(T - 3, 0), (T - 3, T - 1)], fill=_a(RUG_LIGHT))
    return im


def gen_cabinet_front():
    """Facade de placards, sans plan dessus : prolonge le plan de travail d'une case."""
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (196, 152, 104), 3, 13)
    d = ImageDraw.Draw(im)
    d.line([(0, 0), (T - 1, 0)], fill=(150, 110, 70, 255))
    d.rectangle([1, 2, 6, 13], outline=(150, 110, 70, 255))
    d.rectangle([9, 2, 14, 13], outline=(150, 110, 70, 255))
    d.point((5, 8), fill=(80, 60, 40, 255))
    d.point((10, 8), fill=(80, 60, 40, 255))
    d.rectangle([0, 14, T - 1, 15], fill=(120, 88, 56, 255))
    return im


def _bin(color):
    """Poubelle de tri, rectangle de couleur avec couvercle."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    dark = tuple(int(c * 0.7) for c in color)
    d.rectangle([2, 4, 13, 14], fill=color + (255,), outline=dark + (255,))
    d.rectangle([1, 2, 14, 4], fill=dark + (255,))
    d.line([(4, 7), (11, 7)], fill=dark + (255,))
    d.rectangle([6, 9, 9, 11], fill=dark + (255,))
    return im


def gen_elev_door():
    """Battant de porte d'ascenseur : barre verticale unie, repetee sur la longueur
    voulue par world.js (le bord avant est dessine a l'execution)."""
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x0, x1 = 0, 6   # colle au bord couloir, sur la limite couloir / cabine
    d.rectangle([x0, 0, x1, T - 1], fill=(108, 118, 140, 255))
    d.line([(x0, 0), (x0, T - 1)], fill=(56, 62, 78, 255))
    d.line([(x1, 0), (x1, T - 1)], fill=(56, 62, 78, 255))
    d.line([(x0 + 2, 0), (x0 + 2, T - 1)], fill=(168, 178, 198, 255))      # reflet
    return im


def gen_elev_sill():
    """Seuil d'ascenseur : bande metallique claire avec les rails des battants."""
    im = Image.new("RGBA", (T, T))
    _fill_noise(im, (166, 170, 180), 3, 14)
    d = ImageDraw.Draw(im)
    d.line([(3, 0), (3, T - 1)], fill=(132, 136, 148, 255))              # rainure du rail
    d.line([(T - 1, 0), (T - 1, T - 1)], fill=(124, 128, 140, 255))
    return im


def gen_spawn_marker():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([2, 2, 13, 13], outline=(255, 255, 255, 90))
    return im


GENERATORS = {
    "floor_carpet": gen_floor_carpet,
    "floor_carpet_alt": gen_floor_carpet_alt,
    "floor_wood": gen_floor_wood,
    "floor_tile": gen_floor_tile,
    "mat": gen_mat,
    "grass": gen_grass,
    "pavement": gen_pavement,
    "wall_top": gen_wall_top,
    "wall_face": gen_wall_face,
    "ov_monitor": gen_monitor_overlay,
    "ov_laptop": gen_laptop_overlay,
    "ov_papers": gen_papers_overlay,
    "ov_whiteboard": gen_whiteboard_overlay,
    "ov_coffee": gen_coffee_overlay,
    "void": gen_void,
    "elev_sill": gen_elev_sill,
    "elev_door": gen_elev_door,
    "cabinet_front": gen_cabinet_front,
    "bin_yellow": lambda: _bin((232, 190, 60)),
    "bin_brown": lambda: _bin((140, 94, 60)),
    "bin_blue": lambda: _bin((70, 120, 200)),
    "floor_marble": gen_floor_marble,
    "tv_l": lambda: _tv("l"), "tv_m": lambda: _tv("m"), "tv_r": lambda: _tv("r"),
    "hightable_l": lambda: _hightable("l"), "hightable_m": lambda: _hightable("m"), "hightable_r": lambda: _hightable("r"),
    "ov_screen": gen_screen_overlay,
    "ov_fruits": gen_fruits_overlay,
    "bigtable_tl": lambda: _bigtable("tl"), "bigtable_t": lambda: _bigtable("t"), "bigtable_tr": lambda: _bigtable("tr"),
    "bigtable_l": lambda: _bigtable("l"), "bigtable_c": lambda: _bigtable(""), "bigtable_r": lambda: _bigtable("r"),
    "bigtable_bl": lambda: _bigtable("bl"), "bigtable_b": lambda: _bigtable("b"), "bigtable_br": lambda: _bigtable("br"),
    "armchair_down": lambda: _cut(_draw_armchair_down, 1, 1, 0, 0),
    "armchair_up": lambda: _cut(_draw_armchair_up, 1, 1, 0, 0),
    "armchair_right": lambda: _cut(_draw_armchair_right, 1, 1, 0, 0),
    "armchair_left": lambda: _cut(_draw_armchair_right, 1, 1, 0, 0, mirror=True),
    "sofa_up_l": lambda: _cut(_draw_sofa_up, 3, 1, 0, 0),
    "sofa_up_m": lambda: _cut(_draw_sofa_up, 3, 1, 1, 0),
    "sofa_up_r": lambda: _cut(_draw_sofa_up, 3, 1, 2, 0),
    "sofa_east_t": lambda: _cut(_draw_sofa_east, 1, 3, 0, 0),
    "sofa_east_m": lambda: _cut(_draw_sofa_east, 1, 3, 0, 1),
    "sofa_east_b": lambda: _cut(_draw_sofa_east, 1, 3, 0, 2),
    "lowtable_tl": lambda: _cut(_draw_lowtable, 2, 2, 0, 0),
    "lowtable_tr": lambda: _cut(_draw_lowtable, 2, 2, 1, 0),
    "lowtable_bl": lambda: _cut(_draw_lowtable, 2, 2, 0, 1),
    "lowtable_br": lambda: _cut(_draw_lowtable, 2, 2, 1, 1),
    "rug_tl": lambda: _rug("tl"), "rug_tm": lambda: _rug("t"), "rug_tr": lambda: _rug("tr"),
    "rug_ml": lambda: _rug("l"), "rug_mm": lambda: _rug(""), "rug_mr": lambda: _rug("r"),
    "rug_bl": lambda: _rug("bl"), "rug_bm": lambda: _rug("b"), "rug_br": lambda: _rug("br"),
}

# ---------------------------------------------------------------------------
# Manifeste : nom -> liste de couches (chaque couche = "pack:index" ou "gen:nom")
# La premiere couche est le fond, les suivantes sont composees par-dessus.
# ---------------------------------------------------------------------------

MANIFEST = [
    # sols
    ("grass", ["gen:grass"]),
    ("pavement", ["gen:pavement"]),
    ("floor_carpet", ["gen:floor_carpet"]),
    ("floor_carpet_alt", ["gen:floor_carpet_alt"]),
    ("floor_wood", ["gen:floor_wood"]),
    ("floor_tile", ["gen:floor_tile"]),
    ("mat", ["gen:mat"]),
    ("void", ["gen:void"]),
    ("floor_marble", ["gen:floor_marble"]),
    ("elev_sill", ["gen:elev_sill"]),
    # murs
    ("wall_top", ["gen:wall_top"]),
    ("wall_face", ["gen:wall_face"]),
    ("wall_window", ["gen:wall_face", "city:729"]),
    ("wall_whiteboard", ["gen:wall_face", "gen:ov_whiteboard"]),
    ("wall_picture_a", ["gen:wall_face", "indoor:340"]),
    ("wall_picture_b", ["gen:wall_face", "indoor:341"]),
    ("wall_map", ["gen:wall_face", "indoor:371"]),
    ("door", ["gen:wall_face", "city:617"]),
    ("door_glass", ["gen:wall_face", "city:619"]),
    ("wall_screen", ["gen:wall_face", "gen:ov_screen"]),
    ("elevator", ["gen:wall_top", "city:621"]),
    ("elev_door", ["gen:elev_door"]),
    # bureaux
    ("desk_pc", ["indoor:112", "gen:ov_monitor"]),
    ("desk_laptop", ["indoor:113", "gen:ov_laptop"]),
    ("desk_papers", ["indoor:113", "gen:ov_papers"]),
    ("desk_plain", ["indoor:112"]),
    ("chair_down", ["indoor:54"]),
    ("chair_up", ["indoor:55"]),
    ("chair_right", ["indoor:56"]),
    ("chair_left", ["indoor:57"]),
    ("chair_white_down", ["indoor:216"]),
    ("chair_white_up", ["indoor:217"]),
    ("hightable", ["indoor:113"]),
    ("hightable_l", ["gen:hightable_l"]), ("hightable_m", ["gen:hightable_m"]), ("hightable_r", ["gen:hightable_r"]),
    ("tv_l", ["gen:tv_l"]), ("tv_m", ["gen:tv_m"]), ("tv_r", ["gen:tv_r"]),
    # grandes tables (9-slice generee)
    ("bigtable_tl", ["gen:bigtable_tl"]), ("bigtable_t", ["gen:bigtable_t"]), ("bigtable_tr", ["gen:bigtable_tr"]),
    ("bigtable_l", ["gen:bigtable_l"]), ("bigtable_c", ["gen:bigtable_c"]), ("bigtable_r", ["gen:bigtable_r"]),
    ("bigtable_bl", ["gen:bigtable_bl"]), ("bigtable_b", ["gen:bigtable_b"]), ("bigtable_br", ["gen:bigtable_br"]),
    ("bigtable_t_laptop", ["gen:bigtable_t", "gen:ov_laptop"]),
    ("bigtable_b_laptop", ["gen:bigtable_b", "gen:ov_laptop"]),
    # table de reunion 3x2
    ("table_tl", ["indoor:0"]), ("table_tm", ["indoor:1"]), ("table_tr", ["indoor:2"]),
    ("table_bl", ["indoor:27"]), ("table_bm", ["indoor:28"]), ("table_br", ["indoor:29"]),
    # table ronde 2x2
    ("round_tl", ["indoor:3"]), ("round_tr", ["indoor:4"]),
    ("round_bl", ["indoor:30"]), ("round_br", ["indoor:31"]),
    # salon
    ("sofa_tl", ["indoor:286"]), ("sofa_tm", ["indoor:287"]), ("sofa_tr", ["indoor:288"]),
    ("sofa_bl", ["indoor:313"]), ("sofa_bm", ["indoor:314"]), ("sofa_br", ["indoor:315"]),
    ("armchair_down", ["gen:armchair_down"]), ("armchair_up", ["gen:armchair_up"]),
    ("armchair_right", ["gen:armchair_right"]), ("armchair_left", ["gen:armchair_left"]),
    ("sofa_up_l", ["gen:sofa_up_l"]), ("sofa_up_m", ["gen:sofa_up_m"]), ("sofa_up_r", ["gen:sofa_up_r"]),
    ("sofa_east_t", ["gen:sofa_east_t"]), ("sofa_east_m", ["gen:sofa_east_m"]), ("sofa_east_b", ["gen:sofa_east_b"]),
    ("lowtable_tl", ["gen:lowtable_tl"]), ("lowtable_tr", ["gen:lowtable_tr"]),
    ("lowtable_bl", ["gen:lowtable_bl"]), ("lowtable_br", ["gen:lowtable_br"]),
    ("rug_tl", ["gen:rug_tl"]), ("rug_tm", ["gen:rug_tm"]), ("rug_tr", ["gen:rug_tr"]),
    ("rug_ml", ["gen:rug_ml"]), ("rug_mm", ["gen:rug_mm"]), ("rug_mr", ["gen:rug_mr"]),
    ("rug_bl", ["gen:rug_bl"]), ("rug_bm", ["gen:rug_bm"]), ("rug_br", ["gen:rug_br"]),
    ("piano_l", ["indoor:239"]), ("piano_r", ["indoor:240"]),
    ("shelf_top", ["indoor:374"]), ("shelf_bottom", ["indoor:401"]),
    # cuisine
    ("counter", ["indoor:324"]),
    ("counter_cabinet", ["indoor:325"]),
    ("counter_jars", ["indoor:328"]),
    ("counter_bottles", ["indoor:329"]),
    ("counter_sink", ["indoor:330"]),
    ("counter_coffee", ["indoor:324", "gen:ov_coffee"]),
    ("counter_fruits", ["indoor:324", "gen:ov_fruits"]),
    ("stove", ["indoor:392"]),
    ("fridge_top", ["indoor:416"]), ("fridge_bottom", ["indoor:443"]),
    ("water_cooler", ["city:567"]),
    # divers
    ("plant_a", ["indoor:16"]),
    ("plant_b", ["indoor:17"]),
    ("bush", ["city:514"]),
    ("tree", ["city:401"]),
    ("bin", ["city:144"]),
    ("bin_orange", ["city:143"]),
    ("bin_yellow", ["gen:bin_yellow"]),
    ("bin_brown", ["gen:bin_brown"]),
    ("bin_blue", ["gen:bin_blue"]),
    ("cabinet_front", ["gen:cabinet_front"]),
    ("crate", ["city:676"]),
]

COLUMNS = 16


# ---------------------------------------------------------------------------
# Chargement des packs
# ---------------------------------------------------------------------------

class Pack:
    def __init__(self, name, zpath):
        self.name = name
        self.z = zipfile.ZipFile(zpath)
        names = self.z.namelist()
        self.tiles = {}
        for n in names:
            m = re.search(r"(?:^|/)Tiles/tile_(\d+)\.png$", n)
            if m:
                self.tiles[int(m.group(1))] = n
        self.sheet = None
        if not self.tiles:
            cands = [n for n in names if n.lower().endswith(".png") and ("sheet" in n.lower())]
            cands = [n for n in cands if "transparent" in n.lower()] or cands
            if not cands:
                raise SystemExit(f"{name}: aucune tuile ni planche trouvee dans {zpath}")
            self.sheet = Image.open(io.BytesIO(self.z.read(cands[0]))).convert("RGBA")
            self.cols = (self.sheet.width + 1) // (T + 1)
            self.rows = (self.sheet.height + 1) // (T + 1)
        self.count = len(self.tiles) if self.tiles else self.cols * self.rows
        print(f"  {name}: {self.count} tuiles ({'fichiers' if self.tiles else 'planche ' + str(self.cols) + 'x' + str(self.rows)})")

    def tile(self, i):
        if self.tiles:
            return Image.open(io.BytesIO(self.z.read(self.tiles[i]))).convert("RGBA")
        c, r = i % self.cols, i // self.cols
        x, y = c * (T + 1), r * (T + 1)
        return self.sheet.crop((x, y, x + T, y + T))


def fetch(name, cache, override):
    if override:
        return override
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"{name}.zip")
    if not os.path.exists(path):
        print(f"  telechargement {PACKS[name]}")
        urllib.request.urlretrieve(PACKS[name], path)
    return path


def contact_sheet(pack, out):
    s = 3
    cols = 24
    rows = math.ceil(pack.count / cols)
    im = Image.new("RGBA", (cols * (T * s + 6), rows * (T * s + 12)), (60, 60, 60, 255))
    d = ImageDraw.Draw(im)
    for i in range(pack.count):
        t = pack.tile(i).resize((T * s, T * s), Image.NEAREST)
        x, y = (i % cols) * (T * s + 6), (i // cols) * (T * s + 12)
        im.paste(t, (x, y + 10), t)
        d.text((x, y), str(i), fill=(255, 255, 0, 255))
    im.save(out)
    print("  contact sheet :", out)


def build_tile(layers, packs):
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    for layer in layers:
        kind, ref = layer.split(":", 1)
        if kind == "gen":
            part = GENERATORS[ref]()
        else:
            part = packs[kind].tile(int(ref))
        im.alpha_composite(part)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(ROOT, "tools", ".cache"))
    ap.add_argument("--zip-city")
    ap.add_argument("--zip-indoor")
    ap.add_argument("--contact-sheet", metavar="DIR")
    ap.add_argument("--preview", help="apercu 4x de la planche produite")
    args = ap.parse_args()

    print("packs :")
    packs = {
        "city": Pack("city", fetch("city", args.cache, args.zip_city)),
        "indoor": Pack("indoor", fetch("indoor", args.cache, args.zip_indoor)),
    }

    if args.contact_sheet:
        os.makedirs(args.contact_sheet, exist_ok=True)
        for name, p in packs.items():
            contact_sheet(p, os.path.join(args.contact_sheet, f"{name}.png"))

    names = [n for n, _ in MANIFEST]
    assert len(names) == len(set(names)), "noms en double dans MANIFEST"
    rows = math.ceil(len(MANIFEST) / COLUMNS)
    sheet = Image.new("RGBA", (COLUMNS * T, rows * T), (0, 0, 0, 0))
    index, sources = {}, {}
    for i, (name, layers) in enumerate(MANIFEST):
        sheet.paste(build_tile(layers, packs), ((i % COLUMNS) * T, (i // COLUMNS) * T))
        index[name] = i
        sources[name] = layers

    os.makedirs(ASSETS, exist_ok=True)
    png = os.path.join(ASSETS, "tileset.png")
    sheet.save(png, optimize=True)
    with open(os.path.join(ASSETS, "tileset.json"), "w") as f:
        json.dump({"tileSize": T, "columns": COLUMNS, "count": len(MANIFEST),
                   "names": index, "sources": sources}, f, indent=1)
    print(f"{png} {sheet.width}x{sheet.height} ({os.path.getsize(png)} octets), {len(MANIFEST)} tuiles")

    credits = os.path.join(ASSETS, "CREDITS.md")
    if not os.path.exists(credits):
        with open(credits, "w") as f:
            f.write(CREDITS)
        print("ecrit", credits)

    if args.preview:
        big = sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (255, 0, 255, 255))
        bg.alpha_composite(big)
        d = ImageDraw.Draw(bg)
        for name, i in index.items():
            d.text(((i % COLUMNS) * T * 4 + 1, (i // COLUMNS) * T * 4 + 1), str(i), fill=(255, 255, 0, 255))
        bg.save(args.preview)
        print("apercu :", args.preview)


CREDITS = """# Credits des assets

## Tuiles (assets/tileset.png)

Extraites et composees par `tools/build_assets.py` a partir de :

- **Roguelike Modern City** par Kenney — https://kenney.nl/assets/roguelike-modern-city — CC0 1.0
- **Roguelike Indoors** par Kenney — https://kenney.nl/assets/roguelike-indoors — CC0 1.0

Les sols, murs, ecrans d'ordinateur, tableau blanc et machine a cafe sont dessines
procéduralement par le script (CC0).

## Personnages (assets/characters.png)

Generes par `tools/gen_characters.py` a partir de templates pixel art ecrits dans
le script (CC0).
"""


if __name__ == "__main__":
    main()
