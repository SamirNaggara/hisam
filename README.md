# HiSam

Un bureau virtuel audio dans le navigateur. On crée des salons, on y entre, et on parle avec les gens présents dans le même salon, comme si on partageait une pièce. Projet personnel, sans framework, sans backend applicatif.

Démo du fonctionnement : une page principale (le bureau et ses salons), un widget compact à intégrer ailleurs, et une page « qui est là » qui liste les présents.

## Comment ça marche

**Il n'y a pas vraiment de serveur.** La voix ne transite par aucune machine centrale : les flux audio partent directement d'un navigateur à l'autre, en pair à pair (WebRTC, via PeerJS). Deux personnes dans le même salon ouvrent une connexion directe entre elles.

**Firebase ne sert qu'au strict minimum** : la liste des salons et leur nom, la présence (qui est en ligne, qui est dans quel salon) et un journal d'événements. Il joue le rôle d'annuaire pour que les navigateurs se trouvent, rien de plus. Aucune donnée audio n'y passe.

```text
Navigateur A  <-->  voix en pair a pair (WebRTC)  <-->  Navigateur B
      |                                                    |
      +---------  Firebase : salons, presence  -----------+
                  (juste pour se trouver)
```

## Fichiers

```text
index.html    le bureau et ses salons
widget.html   version compacte à embarquer
status.html   « qui est là », liste des présents
app.js        toute la logique : salons, présence, connexions audio
style.css     l'interface
```

## Lancer en local

Servir le dossier en HTTP (WebRTC et le micro exigent un contexte sécurisé, `localhost` convient) :

```bash
python3 -m http.server 8000
```

Puis créer un projet Firebase (Realtime Database) et coller sa configuration dans `FIREBASE_CONFIG`, en haut de `app.js`. Les instructions détaillées sont en commentaire dans le fichier.

## Licence

MIT. Voir [LICENSE](./LICENSE).
