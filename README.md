# HiSam

Des salons vocaux pour l'équipe, dans le navigateur. On voit les salons et qui est dedans, **un clic et on rejoint** ; on en crée un en lui donnant un nom, il disparaît quand le dernier part. Chacun affiche s'il est **disponible ou occupé**. En option, un petit bureau en pixel art façon Pokémon où la voix s'active quand on s'approche de quelqu'un. Projet personnel, sans framework, sans backend applicatif.

Une page principale (les salons), un widget compact à intégrer ailleurs, et une page « qui est là » qui liste les présents par salon.

## Les salons

On donne son prénom une fois, et on arrive dans le hall, **micro coupé**. Le salon « General » est toujours là ; les autres existent tant que quelqu'un est dedans (« Nouveau salon », un nom, Créer). On est dans un seul salon à la fois : en rejoindre un autre quitte le premier. Dans un salon, tout le monde s'entend. Recharger la page dans les deux minutes ramène dans le même salon, et un lien `index.html#join=<id du salon>` y emmène directement (c'est ce que fait le widget).

Sous chaque salon, les gens présents avec une pastille verte (disponible) ou rouge (occupé), le micro coupé, et un bouton Wizz. En bas du hall, les gens en ligne qui ne sont dans aucun salon.

## Disponible / Occupé

Le bouton en haut à droite bascule ton statut. Occupé, tu ne reçois plus ni son ni notification, et personne ne peut te wizzer. Celui qui veut rejoindre un salon où tu es voit d'abord « X est occupé(e), rejoindre quand même ? » et doit cliquer une seconde fois. Le statut est mémorisé dans le navigateur.

## Le bureau (carte, bêta)

Activé depuis le menu « ⋯ » de la barre du bas (« Carte du bureau »), il apparaît comme un salon de plus, « Bureau (carte) ». Il apparaît aussi, même sans le switch, dès que quelqu'un s'y trouve. Le rejoindre ouvre la carte : on y parle seulement aux gens assez proches. Tout ce qui suit ne concerne que ce salon.

## Comment ça marche

**Il n'y a pas vraiment de serveur.** La voix ne transite par aucune machine centrale : les flux audio partent directement d'un navigateur à l'autre, en pair à pair (WebRTC, via PeerJS). Les gens d'un même salon (ou, dans le bureau, assez proches) ouvrent une connexion directe entre eux.

**Firebase ne sert qu'au strict minimum** : la présence (qui est là, dans quel salon, disponible ou occupé, micro coupé ou non) et, dans le bureau, la position de chacun, quelques écritures par seconde quand on marche. Un salon n'est qu'un champ `room` sur le nœud de chaque personne : pas de table des salons à entretenir. Il joue le rôle d'annuaire pour que les navigateurs se trouvent, rien de plus. Aucune donnée audio n'y passe.

```text
Navigateur A  <-->  voix en pair a pair (WebRTC)  <-->  Navigateur B
      |                                                    |
      +---  Firebase : presence, salons, positions  -------+
                  (juste pour se trouver)
```

**Dans le bureau, les conversations sont des groupes de proximité.** Deux personnes à moins de 2,5 cases l'une de l'autre sont reliées ; un lien existant tient jusqu'à 3,5 cases (pour éviter les coupures à la limite). Les groupes sont les composantes connexes : si A est près de B et B près de C, tous les trois se parlent. Les murs des salles de réunion coupent la voix : il faut passer la porte.

## Les lieux

La carte reproduit les locaux de l'Escalator : on arrive par les ascenseurs, on remonte le couloir jusqu'à l'open space et ses deux grandes tables de travail, les tables hautes, puis derrière la cloison le plan de travail café et fruits et le coin cuisine. Sur la gauche, la salle de réunion avec son écran et sa grande table, et en dessous la petite salle avec ses fauteuils. Les deux salles sont fermées : la voix ne passe pas leurs murs.

## Se déplacer, parler

On entre dans le bureau par l'ascenseur, avec un personnage tiré au sort la première fois puis toujours le même (mémorisé dans le navigateur). Un clic sur le bouton micro pour parler ; le couper relâche vraiment le micro. Recharger la page dans les deux minutes ramène à la même case.

Flèches, ZQSD ou WASD, ou un clic sur la case où aller. Le cercle autour de ton personnage montre la portée de ta voix ; les noms des gens avec qui tu parles passent en vert.

Le panneau « Rejoindre ? » en bas à droite montre les autres, regroupés par conversation. Cliquer sur quelqu'un te place à côté de lui (dans sa pièce, jamais à travers un mur), la voix s'active, et **tu le suis** : s'il bouge, tu marches derrière lui, jusqu'à ce que tu bouges toi-même ou que tu recliques sur lui.

`skin.html` (sans lien depuis le bureau) permet de changer de personnage ; le changement s'applique aussitôt.

## Occupé : les pods

Deux cabines vitrées contre le mur est, au-dessus de la cuisine. Un clic sur une cabine libre t'y fait entrer (tu marches jusqu'à sa façade, puis tu y es) ; « Occupé », dans le menu « ⋯ » de la barre du bas, te téléporte directement dans la première libre, micro coupé, et ton statut passe à Occupé : on te voit à travers la vitre, personne ne peut entrer ni te parler, et tu apparais en ambre dans le panneau. Tu en sors par le bouton ou d'un pas vers la façade. Deux pods, donc deux occupés à la fois ; le bouton se grise sinon.

Cliquer sur quelqu'un d'occupé te fait marcher jusqu'à devant sa cabine. Là, un clic sur la cabine la **secoue** : c'est le wizz, comme sur MSN. Son écran tremble, un buzz, une notification, et sa cabine tremble sur toutes les cartes. Le wizz marche aussi sur les gens hors pod (bouton « Wizz » sous chaque personne, dans le bureau comme dans le hall), sauf sur les gens en statut Occupé, dix secondes minimum entre deux wizz vers la même personne. Dans un pod, on peut toujours te secouer.

Un seul onglet HiSam à la fois par navigateur : si un autre est déjà ouvert, un bouton « Utiliser cet onglet » permet de continuer ici, l'autre onglet se retire.

## Fichiers

```text
index.html      les salons (et le bureau)
skin.html       choisir son personnage (page cachée)
widget.html     version compacte à embarquer
status.html     « qui est là », les présents par salon, avec leur statut
app.js          réseau et audio : présence Firebase, salons, statut, positions, connexions PeerJS
audio-processing.js  réduction de bruit du micro (RNNoise + noise gate)
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
