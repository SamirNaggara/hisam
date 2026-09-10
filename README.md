# HiSam

Un petit bureau virtuel en pixel art, façon Pokémon, dans le navigateur. Chacun arrive à l'entrée avec son personnage, se promène dans l'open space, et **pour parler à quelqu'un il suffit de s'en approcher** : la voix s'active toute seule, à deux, trois ou quatre. On s'éloigne, la conversation se coupe. Projet personnel, sans framework, sans backend applicatif.

Une page principale (le bureau), un widget compact à intégrer ailleurs, et une page « qui est là » qui liste les présents.

## Comment ça marche

**Il n'y a pas vraiment de serveur.** La voix ne transite par aucune machine centrale : les flux audio partent directement d'un navigateur à l'autre, en pair à pair (WebRTC, via PeerJS). Deux personnes assez proches dans le bureau ouvrent une connexion directe entre elles.

**Firebase ne sert qu'au strict minimum** : la présence (qui est là, avec quel personnage, micro coupé ou non) et la position de chacun dans le bureau, quelques écritures par seconde quand on marche. Il joue le rôle d'annuaire pour que les navigateurs se trouvent, rien de plus. Aucune donnée audio n'y passe.

```text
Navigateur A  <-->  voix en pair a pair (WebRTC)  <-->  Navigateur B
      |                                                    |
      +------  Firebase : presence, positions  ------------+
                  (juste pour se trouver)
```

**Les conversations sont des groupes de proximité.** Deux personnes à moins de 2,5 cases l'une de l'autre sont reliées ; un lien existant tient jusqu'à 3,5 cases (pour éviter les coupures à la limite). Les groupes sont les composantes connexes : si A est près de B et B près de C, tous les trois se parlent. Les murs des salles de réunion coupent la voix : il faut passer la porte.

## Les lieux

La carte reproduit les locaux de l'Escalator : on arrive par les ascenseurs, on remonte le couloir jusqu'à l'open space et ses deux grandes tables de travail, les tables hautes, puis derrière la cloison le plan de travail café et fruits et le coin cuisine. Sur la gauche, la salle de réunion avec son écran et sa grande table, et en dessous la petite salle avec ses fauteuils. Les deux salles sont fermées : la voix ne passe pas leurs murs.

## Se déplacer

Flèches, ZQSD ou WASD, ou un clic sur la case où aller. Le cercle autour de ton personnage montre la portée de ta voix ; les noms des gens avec qui tu parles passent en vert.

## Fichiers

```text
index.html      le bureau
widget.html     version compacte à embarquer
status.html     « qui est là », liste des présents et de leurs conversations
app.js          réseau et audio : présence Firebase, positions, connexions PeerJS
world.js        moteur du bureau : rendu canvas, déplacements, collisions, groupes
world-map.js    la carte (couches en chaînes de caractères, éditables à la main)
proximity.js    calcul des groupes de conversation (fonction pure)
style.css       l'interface
assets/         tuiles et personnages (voir assets/CREDITS.md)
tools/          scripts qui produisent les assets et la carte
```

## Lancer en local

Servir le dossier en HTTP (WebRTC et le micro exigent un contexte sécurisé, `localhost` convient) :

```bash
python3 -m http.server 8000
```

Puis créer un projet Firebase (Realtime Database) et coller sa configuration dans `FIREBASE_CONFIG`, en haut de `app.js`. Les instructions détaillées sont en commentaire dans le fichier. Les règles de la base doivent autoriser la lecture et l'écriture de `/users` et `/logs`.

Pour tester à plusieurs sur une même machine, il faut une identité par navigateur (l'identifiant est stocké dans `localStorage`) : par exemple `http://localhost:8000` dans un navigateur et `http://127.0.0.1:8000` dans un autre, ou une fenêtre de navigation privée.

## Assets

Les tuiles viennent des packs **Roguelike Modern City** et **Roguelike Indoors** de Kenney (CC0), extraites dans une petite planche par `tools/build_assets.py`, qui dessine aussi les sols, murs, écrans et autres props manquants. Les personnages (4 directions, 3 frames, 8 palettes) sont générés par `tools/gen_characters.py`. La carte est produite par `tools/make_map.py`, mais `world-map.js` se modifie aussi très bien à la main.

```bash
pip install pillow
python3 tools/gen_characters.py
python3 tools/build_assets.py      # telecharge les packs Kenney dans tools/.cache/
python3 tools/make_map.py
```

## Licence

MIT. Voir [LICENSE](./LICENSE). Assets : voir [assets/CREDITS.md](./assets/CREDITS.md).
