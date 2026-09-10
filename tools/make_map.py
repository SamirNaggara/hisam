#!/usr/bin/env python3
"""Genere world-map.js (carte 40x30 du bureau) en peignant des regions."""
import os

W, H = 40, 30
floor = [["g"] * W for _ in range(H)]
obj = [["."] * W for _ in range(H)]
zone = [["."] * W for _ in range(H)]


def rect(layer, x0, y0, x1, y1, ch):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            layer[y][x] = ch


def put(layer, x, y, s):
    for i, ch in enumerate(s):
        layer[y][x + i] = ch


# --- exterieur : herbe + trottoir devant l'entree
rect(floor, 0, 0, W - 1, H - 1, "g")
rect(floor, 16, 28, 23, 29, "=")
for (x, y) in ((1, 1), (38, 1), (1, 28), (38, 28), (5, 29), (34, 29), (12, 0), (27, 0)):
    obj[y][x] = "H"
for (x, y) in ((3, 0), (9, 1), (30, 1), (36, 0), (10, 29), (28, 28)):
    obj[y][x] = "h"

# --- batiment : x=2..37, y=2..27 ; interieur x=3..36, y=4..26
rect(floor, 3, 4, 36, 26, ",")
# moquette en damier discret
for y in range(4, 27):
    for x in range(3, 37):
        if (x + y) % 2 == 0:
            floor[y][x] = ";"
# mur nord (2 rangees), murs lateraux, mur sud
rect(obj, 2, 2, 37, 2, "^")
rect(obj, 2, 3, 37, 3, "#")
rect(obj, 2, 2, 2, 27, "^")
rect(obj, 37, 2, 37, 27, "^")
rect(obj, 2, 27, 37, 27, "^")
# entree (double porte vitree) + tapis + trottoir
put(obj, 19, 27, "GG")
rect(floor, 18, 24, 21, 26, "_")

# --- salle Nord : interieur x=3..11, y=4..9 ; mur est x=12 ; mur sud y=10, porte (7,10)
rect(floor, 3, 4, 11, 9, "w")
rect(obj, 12, 2, 12, 10, "^")
rect(obj, 3, 10, 11, 10, "#")
obj[10][7] = "D"
put(obj, 5, 3, "MWAW")  # tableau blanc + fenetres sur le mur nord
put(obj, 6, 5, "123")
put(obj, 6, 6, "456")
put(obj, 6, 4, "ccc")
put(obj, 6, 7, "uuu")
obj[5][5] = "r"
obj[6][9] = "q"
obj[9][3] = "p"
obj[4][11] = "P"
rect(zone, 3, 4, 11, 9, "1")
zone[10][7] = "1"

# --- salle Sud : interieur x=28..36, y=4..9 ; mur ouest x=27 ; mur sud y=10, porte (32,10)
rect(floor, 28, 4, 36, 9, "w")
rect(obj, 27, 2, 27, 10, "^")
rect(obj, 28, 10, 36, 10, "#")
obj[10][32] = "D"
put(obj, 30, 3, "WmWM")
put(obj, 31, 5, "()")
put(obj, 31, 6, "[]")
put(obj, 31, 4, "CC")
put(obj, 31, 7, "UU")
obj[5][30] = "r"
obj[6][33] = "q"
obj[9][36] = "p"
obj[4][28] = "P"
rect(zone, 28, 4, 36, 9, "2")
zone[10][32] = "2"

# --- couloir nord entre les salles (x=13..26, y=4..9) : fenetres, plantes, fontaine
put(obj, 14, 3, "WW")
put(obj, 18, 3, "aWWm")
put(obj, 24, 3, "WW")
obj[4][13] = "p"
obj[4][26] = "P"
obj[4][20] = "w"
obj[4][21] = "%"
put(obj, 17, 6, "ll")   # deux portables sur une table haute
put(obj, 17, 5, "CC")
put(obj, 22, 6, "nn")
put(obj, 22, 7, "UU")

# --- open space : ilots de bureaux (2x4 : chaises, bureaux, bureaux, chaises)
def island(x, y, top="dl", bottom="nd"):
    put(obj, x, y, "cc")
    put(obj, x, y + 1, top)
    put(obj, x, y + 2, bottom)
    put(obj, x, y + 3, "uu")

island(6, 13)
island(14, 13, "ld", "dn")
island(22, 13)
island(30, 13, "dd", "nl")
island(14, 19, "dn", "ld")
island(22, 19, "ld", "dd")
for (x, y) in ((4, 12), (12, 12), (20, 12), (28, 12), (35, 12), (12, 18), (26, 18)):
    obj[y][x] = "p" if (x + y) % 2 else "P"
obj[11][3] = "%"

# --- cuisine : x=3..11, y=19..26, sol carrele, plan de travail le long du mur ouest et sud
rect(floor, 3, 19, 11, 26, "~")
put(obj, 3, 19, "F")
put(obj, 3, 20, "f")
rect(obj, 3, 21, 3, 25, "k")
obj[22][3] = "Y"
obj[23][3] = "j"
obj[24][3] = "y"
obj[25][3] = "J"
put(obj, 4, 26, "Kkxkk")
obj[26][3] = "K"
put(obj, 7, 21, "()")
put(obj, 7, 22, "[]")
obj[21][6] = "q"
obj[21][9] = "r"
obj[22][6] = "q"
obj[22][9] = "r"
obj[19][10] = "&"
obj[19][11] = "&"
obj[26][11] = "p"

# --- salon : x=28..36, y=19..26, parquet, tapis, canape, piano, fauteuil
rect(floor, 28, 19, 36, 26, "w")
put(floor, 30, 22, "123")
put(floor, 30, 23, "456")
put(floor, 30, 24, "789")
put(obj, 30, 20, "STV")
put(obj, 30, 21, "stv")
put(obj, 34, 22, "Z")
put(obj, 34, 23, "z")
put(obj, 28, 25, "iI")
put(obj, 35, 19, "B")
put(obj, 35, 20, "b")
obj[19][28] = "P"
obj[26][36] = "p"
obj[26][33] = "w"

# --- exterieur : zone separee (les murs coupent la voix)
rect(zone, 0, 0, W - 1, 1, "o")
rect(zone, 0, 28, W - 1, 29, "o")
rect(zone, 0, 0, 1, H - 1, "o")
rect(zone, 38, 0, 39, H - 1, "o")

# --- verification : zones de spawn libres
spawn = [[19, 25], [20, 25], [18, 25], [21, 25], [19, 24], [20, 24], [18, 24], [21, 24], [19, 26], [20, 26], [18, 26], [21, 26]]
for x, y in spawn:
    assert obj[y][x] == ".", (x, y, obj[y][x])


def js_rows(layer):
    return ",\n".join('    "' + "".join(r) + '"' for r in layer)


out = f'''// ============================================================
// HiSam — carte du bureau (40 x 30 cases de 16 px)
// ============================================================
// Trois couches en chaines de caracteres (une par ligne, un caractere par case) :
//   floor   : sol, toujours dessine, jamais bloquant
//   objects : meubles et murs ; la legende dit si la case bloque (solid)
//   zones   : "." = open space, un chiffre = piece fermee. Deux personnes ne
//             se parlent que si elles sont dans la meme zone (les murs coupent la voix).
// Les noms de tuiles sont ceux de assets/tileset.json (voir tools/build_assets.py).
// Ce fichier a ete produit par un petit script de peinture de regions, mais il
// s'edite tres bien a la main : on change un caractere, on recharge.

const WORLD_MAP = {{
  width: {W},
  height: {H},
  tile: 16,

  floorLegend: {{
    "g": "grass",
    "=": "pavement",
    ",": "floor_carpet",
    ";": "floor_carpet_alt",
    "w": "floor_wood",
    "~": "floor_tile",
    "_": "mat",
    "1": "rug_tl", "2": "rug_tm", "3": "rug_tr",
    "4": "rug_ml", "5": "rug_mm", "6": "rug_mr",
    "7": "rug_bl", "8": "rug_bm", "9": "rug_br",
  }},
  floor: [
{js_rows(floor)}
  ],

  objectsLegend: {{
    "#": {{ tile: "wall_face", solid: true }},
    "^": {{ tile: "wall_top", solid: true }},
    "W": {{ tile: "wall_window", solid: true }},
    "M": {{ tile: "wall_whiteboard", solid: true }},
    "A": {{ tile: "wall_picture_a", solid: true }},
    "a": {{ tile: "wall_picture_b", solid: true }},
    "m": {{ tile: "wall_map", solid: true }},
    "D": {{ tile: "door", solid: false }},
    "G": {{ tile: "door_glass", solid: false }},
    "d": {{ tile: "desk_pc", solid: true }},
    "l": {{ tile: "desk_laptop", solid: true }},
    "n": {{ tile: "desk_papers", solid: true }},
    "o": {{ tile: "desk_plain", solid: true }},
    "c": {{ tile: "chair_down", solid: false }},
    "u": {{ tile: "chair_up", solid: false }},
    "r": {{ tile: "chair_right", solid: false }},
    "q": {{ tile: "chair_left", solid: false }},
    "C": {{ tile: "chair_white_down", solid: false }},
    "U": {{ tile: "chair_white_up", solid: false }},
    "1": {{ tile: "table_tl", solid: true }}, "2": {{ tile: "table_tm", solid: true }}, "3": {{ tile: "table_tr", solid: true }},
    "4": {{ tile: "table_bl", solid: true }}, "5": {{ tile: "table_bm", solid: true }}, "6": {{ tile: "table_br", solid: true }},
    "(": {{ tile: "round_tl", solid: true }}, ")": {{ tile: "round_tr", solid: true }},
    "[": {{ tile: "round_bl", solid: true }}, "]": {{ tile: "round_br", solid: true }},
    "S": {{ tile: "sofa_tl", solid: true }}, "T": {{ tile: "sofa_tm", solid: true }}, "V": {{ tile: "sofa_tr", solid: true }},
    "s": {{ tile: "sofa_bl", solid: true }}, "t": {{ tile: "sofa_bm", solid: true }}, "v": {{ tile: "sofa_br", solid: true }},
    "Z": {{ tile: "armchair_top", solid: true }}, "z": {{ tile: "armchair_bottom", solid: true }},
    "i": {{ tile: "piano_l", solid: true }}, "I": {{ tile: "piano_r", solid: true }},
    "B": {{ tile: "shelf_top", solid: true }}, "b": {{ tile: "shelf_bottom", solid: true }},
    "k": {{ tile: "counter", solid: true }},
    "K": {{ tile: "counter_cabinet", solid: true }},
    "j": {{ tile: "counter_jars", solid: true }},
    "J": {{ tile: "counter_bottles", solid: true }},
    "y": {{ tile: "counter_sink", solid: true }},
    "Y": {{ tile: "counter_coffee", solid: true }},
    "x": {{ tile: "stove", solid: true }},
    "F": {{ tile: "fridge_top", solid: true }}, "f": {{ tile: "fridge_bottom", solid: true }},
    "w": {{ tile: "water_cooler", solid: true }},
    "p": {{ tile: "plant_a", solid: true }},
    "P": {{ tile: "plant_b", solid: true }},
    "h": {{ tile: "bush", solid: true }},
    "H": {{ tile: "tree", solid: true }},
    "%": {{ tile: "bin", solid: true }},
    "&": {{ tile: "crate", solid: true }},
  }},
  objects: [
{js_rows(obj)}
  ],

  zones: [
{js_rows(zone)}
  ],

  // Cases d'apparition (devant l'entree), par ordre de preference
  spawn: {spawn},

  // Etiquettes dessinees sur le sol
  labels: [
    {{ x: 4.6, y: 4.8, text: "Salle Nord" }},
    {{ x: 34.6, y: 4.8, text: "Salle Sud" }},
    {{ x: 8, y: 19.6, text: "Cuisine" }},
    {{ x: 32.5, y: 19.6, text: "Salon" }},
  ],
}};
'''
open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "world-map.js"), "w").write(out)
print("ok")
for r in obj:
    print("".join(r))
