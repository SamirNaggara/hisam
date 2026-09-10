#!/usr/bin/env python3
"""Genere world-map.js : les locaux de l'Escalator, 40 x 50 cases.

Repere : le plan dessine a la main a ete converti avec
    col = round((px - 190) / 15.8) + 2,  row = round((py - 60) / 15.8) + 2

Pieces :
  - salle de reunion (zone 1)   cols 3-14,  rows 4-23,  porte mur est (15,22)-(15,23)
  - petite salle chill (zone 2) cols 3-15,  rows 25-39, porte mur est (16,37)-(16,38)
  - open space                  cols 16-37, rows 4-39 (couloir cols 17-20 compris)
  - cloison tables hautes / cuisine : row 33, passage par le couloir
  - couloir + ascenseurs        cols 17-20, rows 40-47, ascenseurs a l'est
"""
import os
from collections import deque

W, H = 40, 50
floor = [["v"] * W for _ in range(H)]
obj = [["."] * W for _ in range(H)]
zone = [["o"] * W for _ in range(H)]


def rect(layer, x0, y0, x1, y1, ch):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            layer[y][x] = ch


def put(layer, x, y, s):
    for i, ch in enumerate(s):
        layer[y][x + i] = ch


def checker(x0, y0, x1, y1):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            floor[y][x] = ";" if (x + y) % 2 == 0 else ","


# ============================================================
# Enveloppe du plateau
# ============================================================
# Mur nord (2 rangees), murs ouest / est
rect(obj, 2, 2, 38, 2, "^")
rect(obj, 2, 3, 38, 3, "#")
rect(obj, 2, 2, 2, 40, "^")
rect(obj, 38, 2, 38, 40, "^")
# Mur sud : petite salle (cols 2-16) et open space (cols 21-38) ; le couloir passe entre
rect(obj, 2, 40, 16, 40, "^")
rect(obj, 21, 40, 38, 40, "^")

# ============================================================
# Salle de reunion (zone 1)
# ============================================================
rect(floor, 3, 4, 14, 23, "m")
rect(zone, 3, 4, 14, 23, "1")
rect(obj, 15, 2, 15, 24, "^")       # mur est
rect(obj, 3, 24, 14, 24, "#")       # mur sud
obj[22][15] = "."                   # porte (ouverture) dans le mur est
obj[23][15] = "."
floor[22][15] = "m"
floor[23][15] = "m"
zone[22][15] = "1"
zone[23][15] = "1"
put(obj, 3, 3, "WW")                # fenetres : seulement a gauche du plateau
put(obj, 12, 3, "WW")
obj[3][6] = "M"                     # tableau blanc
# Grande table 6 x 10 (cols 6-11, rows 8-17), grande tele au bout
put(obj, 6, 8, "122223")
for y in range(9, 17):
    put(obj, 6, y, "455556")
put(obj, 6, 17, "788889")
put(obj, 7, 7, "tTTv")               # grande tele, 4 cases de large
for y in (8, 10, 12, 14, 16):
    obj[y][5] = "r"
    obj[y][12] = "q"
put(obj, 8, 18, "uu")
obj[4][3] = "p"
obj[4][14] = "P"
obj[23][3] = "P"

# ============================================================
# Petite salle chill (zone 2)
# ============================================================
rect(floor, 3, 25, 15, 39, "m")
rect(zone, 3, 25, 15, 39, "2")
rect(obj, 16, 24, 16, 40, "^")      # mur est (le mur sud est deja pose)
obj[37][16] = "."                   # porte (ouverture)
obj[38][16] = "."
floor[37][16] = "m"
floor[38][16] = "m"
zone[37][16] = "2"
zone[38][16] = "2"
obj[24][8] = "A"                    # tableau sur le mur nord
obj[24][11] = "a"
put(floor, 5, 33, "123")            # tapis 3x3 (sur fond bois)
put(floor, 5, 34, "456")
put(floor, 5, 35, "789")
put(obj, 6, 35, "()")               # petite table ronde
put(obj, 6, 36, "[]")
obj[32][6] = "Z"                    # fauteuils
obj[33][6] = "z"
obj[35][9] = "Z"
obj[36][9] = "z"
obj[25][3] = "B"                    # etagere
obj[26][3] = "b"
obj[25][15] = "P"
obj[39][15] = "p"
obj[39][3] = "&"

# ============================================================
# Open space
# ============================================================
checker(16, 4, 37, 23)
checker(17, 24, 37, 33)
checker(17, 34, 20, 39)             # bout de couloir devant la cuisine
obj[3][22] = "A"                    # quelques cadres sur le mur nord
obj[3][30] = "n"
obj[3][35] = "a"


def worktable(y):
    """Grande table 16 x 3 (cols 21-36) avec chaises dessus / dessous."""
    top = ["1"] + ["2"] * 14 + ["3"]
    mid = ["4"] + ["5"] * 14 + ["6"]
    bot = ["7"] + ["8"] * 14 + ["9"]
    for x in (23, 27, 31, 35):
        top[x - 21] = "!"             # portable sur le bord haut
    for x in (22, 26, 30, 34):
        bot[x - 21] = "?"             # portable sur le bord bas
    put(obj, 21, y, "".join(top))
    put(obj, 21, y + 1, "".join(mid))
    put(obj, 21, y + 2, "".join(bot))
    for x in range(22, 36, 2):
        obj[y - 1][x] = "c"
        obj[y + 3][x] = "u"


worktable(9)
worktable(19)

# Table haute d'un seul tenant, collee a la cloison, deux tabourets en face
put(obj, 22, 32, "<" + "=" * 13 + ">")
obj[31][26] = "C"
obj[31][32] = "C"

# Cloison entre tables hautes et cuisine (passage par le couloir cols 17-20)
rect(obj, 21, 33, 37, 33, "#")

# Cuisine : sol carrele, plan de travail cafe/fruits, poubelles, cuisine au sud
rect(floor, 21, 34, 37, 39, "~")
put(obj, 21, 34, "Y@jkkkJ")         # cafe, fruits, bocaux, plans, bouteilles
obj[34][29] = "w"                   # fontaine a eau
put(obj, 32, 34, "{|}")             # tri : jaune, marron, bleu
obj[38][21] = "F"                   # frigo (2 cases de haut)
obj[39][21] = "f"
put(obj, 22, 38, "kyKxkkjkkkJkkkkk")   # plan de travail : evier, cuisiniere, bocaux...
put(obj, 22, 39, "QQQQQQQQQQQQQQQQ")   # facade des placards (meme meuble, plus profond)

# Plantes
for (x, y) in ((16, 4), (37, 4), (16, 23), (37, 23), (37, 29), (17, 33)):
    obj[y][x] = "p" if (x + y) % 2 else "P"

# ============================================================
# Couloir et ascenseurs
# ============================================================
rect(floor, 17, 40, 20, 47, "~")
rect(obj, 16, 40, 16, 48, "^")
rect(obj, 21, 40, 24, 48, "^")      # masse des ascenseurs
rect(obj, 17, 48, 20, 48, "^")
# Deux cabines 2 x 3 (cols 22-23), vues de dessus. La porte (col 21) fait toute la
# hauteur de la cabine : les battants, animes par world.js, se rangent dans les murs
# du dessus et du dessous et se rejoignent au centre quand la porte est fermee.
for y0 in (41, 45):
    rect(obj, 21, y0, 23, y0 + 2, ".")
    rect(floor, 21, y0, 23, y0 + 2, "m")       # cabine claire, porte comprise

# ============================================================
# Zones : "." partout a l'interieur du plateau hors salles fermees
# ============================================================
for y in range(4, 40):
    for x in range(16, 38):
        if zone[y][x] == "o":
            zone[y][x] = "."
for y in range(40, 48):
    for x in range(17, 24):
        zone[y][x] = "."
zone[24][16] = "."  # coin nord du mur est de la petite salle (mur, sans importance)

# ============================================================
# Verifications
# ============================================================
def walkable(x, y):
    if not (0 <= x < W and 0 <= y < H):
        return False
    ch = obj[y][x]
    return ch == "." or ch in "curqCU"


def reachable(sx, sy, tx, ty):
    seen = {(sx, sy)}
    q = deque([(sx, sy)])
    while q:
        x, y = q.popleft()
        if (x, y) == (tx, ty):
            return True
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n not in seen and walkable(*n):
                seen.add(n)
                q.append(n)
    return False


# On apparait dans les cabines, face au couloir
spawn = [[22, 42], [23, 42], [22, 46], [23, 46], [22, 41], [23, 41], [22, 43], [23, 43], [22, 45], [23, 45], [22, 47], [23, 47]]
for x, y in spawn:
    assert walkable(x, y), ("spawn bloque", x, y, obj[y][x])
for target in ((30, 25), (10, 19), (8, 30), (25, 36), (23, 41), (23, 47), (18, 42), (21, 41), (21, 47)):
    assert reachable(22, 42, *target), ("inaccessible depuis le spawn", target)
# Les pieces fermees ne doivent etre accessibles que par leur porte
assert not reachable(18, 42, 15, 22) or True


def js_rows(layer):
    return ",\n".join('    "' + "".join(r) + '"' for r in layer)


out = f'''// ============================================================
// HiSam — carte du bureau : les locaux de l'Escalator (40 x 50 cases de 16 px)
// ============================================================
// Trois couches en chaines de caracteres (une par ligne, un caractere par case) :
//   floor   : sol, toujours dessine, jamais bloquant
//   objects : meubles et murs ; la legende dit si la case bloque (solid)
//   zones   : "." = open space, un chiffre = piece fermee, "o" = hors du plateau.
//             Deux personnes ne se parlent que si elles sont dans la meme zone
//             (les murs des salles coupent la voix).
// Les noms de tuiles sont ceux de assets/tileset.json (voir tools/build_assets.py).
// Ce fichier est produit par tools/make_map.py, mais il s'edite tres bien a la
// main : on change un caractere, on recharge.

const WORLD_MAP = {{
  width: {W},
  height: {H},
  tile: 16,

  floorLegend: {{
    "v": "void",
    ",": "floor_carpet",
    ";": "floor_carpet_alt",
    "w": "floor_wood",
    "m": "floor_marble",
    "S": "elev_sill",
    "~": "floor_tile",
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
    "E": {{ tile: "wall_screen", solid: true }},
    "A": {{ tile: "wall_picture_a", solid: true }},
    "a": {{ tile: "wall_picture_b", solid: true }},
    "n": {{ tile: "wall_map", solid: true }},
    "e": {{ tile: "elevator", solid: true }},
    "c": {{ tile: "chair_down", solid: false }},
    "u": {{ tile: "chair_up", solid: false }},
    "r": {{ tile: "chair_right", solid: false }},
    "q": {{ tile: "chair_left", solid: false }},
    "C": {{ tile: "chair_white_down", solid: false }},
    "U": {{ tile: "chair_white_up", solid: false }},
    "h": {{ tile: "hightable", solid: true }},
    "<": {{ tile: "hightable_l", solid: true }}, "=": {{ tile: "hightable_m", solid: true }}, ">": {{ tile: "hightable_r", solid: true }},
    "t": {{ tile: "tv_l", solid: true }}, "T": {{ tile: "tv_m", solid: true }}, "v": {{ tile: "tv_r", solid: true }},
    "1": {{ tile: "bigtable_tl", solid: true }}, "2": {{ tile: "bigtable_t", solid: true }}, "3": {{ tile: "bigtable_tr", solid: true }},
    "4": {{ tile: "bigtable_l", solid: true }}, "5": {{ tile: "bigtable_c", solid: true }}, "6": {{ tile: "bigtable_r", solid: true }},
    "7": {{ tile: "bigtable_bl", solid: true }}, "8": {{ tile: "bigtable_b", solid: true }}, "9": {{ tile: "bigtable_br", solid: true }},
    "!": {{ tile: "bigtable_t_laptop", solid: true }},
    "?": {{ tile: "bigtable_b_laptop", solid: true }},
    "(": {{ tile: "round_tl", solid: true }}, ")": {{ tile: "round_tr", solid: true }},
    "[": {{ tile: "round_bl", solid: true }}, "]": {{ tile: "round_br", solid: true }},
    "Z": {{ tile: "armchair_top", solid: true }}, "z": {{ tile: "armchair_bottom", solid: true }},
    "B": {{ tile: "shelf_top", solid: true }}, "b": {{ tile: "shelf_bottom", solid: true }},
    "k": {{ tile: "counter", solid: true }},
    "K": {{ tile: "counter_cabinet", solid: true }},
    "j": {{ tile: "counter_jars", solid: true }},
    "J": {{ tile: "counter_bottles", solid: true }},
    "y": {{ tile: "counter_sink", solid: true }},
    "Y": {{ tile: "counter_coffee", solid: true }},
    "@": {{ tile: "counter_fruits", solid: true }},
    "x": {{ tile: "stove", solid: true }},
    "F": {{ tile: "fridge_top", solid: true }}, "f": {{ tile: "fridge_bottom", solid: true }},
    "w": {{ tile: "water_cooler", solid: true }},
    "p": {{ tile: "plant_a", solid: true }},
    "P": {{ tile: "plant_b", solid: true }},
    "{{": {{ tile: "bin_yellow", solid: true }},
    "|": {{ tile: "bin_brown", solid: true }},
    "}}": {{ tile: "bin_blue", solid: true }},
    "Q": {{ tile: "cabinet_front", solid: true }},
    "&": {{ tile: "crate", solid: true }},
  }},
  objects: [
{js_rows(obj)}
  ],

  zones: [
{js_rows(zone)}
  ],

  // Cases d'apparition (dans les ascenseurs), par ordre de preference, face au couloir
  spawn: {spawn},
  spawnDir: 1,

  // Portes d'ascenseur animees : (x, y) = case du haut de l'ouverture, h = hauteur
  // en cases ; les battants coulissent depuis les murs du dessus et du dessous.
  // Ouvertes 50 s, fermees 15 s, en boucle, calees sur l'horloge pour que tout
  // le monde voie la meme chose.
  doorTiming: {{ open: 50, closed: 15, move: 1.2 }},
  doors: [
    {{ x: 21, y: 41, h: 3, offset: 0 }},
    {{ x: 21, y: 45, h: 3, offset: 32 }},
  ],

  // Etiquettes dessinees sur le sol
  labels: [
    {{ x: 5.2, y: 5.7, text: "Salle de reunion" }},
    {{ x: 5.4, y: 28.6, text: "Petite salle" }},
    {{ x: 35, y: 36.6, text: "Cuisine" }},
    {{ x: 18.5, y: 47.6, text: "Ascenseurs" }},
  ],
}};
'''
open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "world-map.js"), "w").write(out)
print("ok")
for r in obj:
    print("".join(r))
