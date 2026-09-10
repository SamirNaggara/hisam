// ============================================================
// HiSam — groupes de conversation par proximite
// ============================================================
// Fonction pure, sans DOM ni reseau, partagee par world.js et status.html.
//
// computeGroups(players, { enter, leave, prevLinks })
//   players   : { id: { x, y, zone } }   (coordonnees en cases)
//   enter     : distance (cases) en dessous de laquelle un lien se cree
//   leave     : distance au-dela de laquelle un lien existant se rompt (hysteresis)
//   prevLinks : Set de cles "idA|idB" (ids tries) des liens du calcul precedent
// Renvoie { groups: Map<id, index>, links: Set<"idA|idB"> }.
//
// Deux personnes sont liees si elles sont dans la meme zone et assez proches.
// Les groupes sont les composantes connexes : A lie a B et B lie a C => A, B, C
// forment une seule conversation, meme si A et C sont loin l'un de l'autre.

(function (global) {
  function pairKey(a, b) {
    return a < b ? a + "|" + b : b + "|" + a;
  }

  function computeGroups(players, opts) {
    const enter = opts.enter;
    const leave = opts.leave != null ? opts.leave : opts.enter;
    const prevLinks = opts.prevLinks || new Set();
    const ids = Object.keys(players);

    // Union-find
    const parent = {};
    ids.forEach((id) => { parent[id] = id; });
    const find = (id) => {
      while (parent[id] !== id) {
        parent[id] = parent[parent[id]];
        id = parent[id];
      }
      return id;
    };
    const union = (a, b) => { parent[find(a)] = find(b); };

    const links = new Set();
    for (let i = 0; i < ids.length; i++) {
      const a = players[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const b = players[ids[j]];
        if ((a.zone || 0) !== (b.zone || 0)) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const key = pairKey(ids[i], ids[j]);
        const linked = d <= enter || (prevLinks.has(key) && d <= leave);
        if (linked) {
          links.add(key);
          union(ids[i], ids[j]);
        }
      }
    }

    const groups = new Map();
    const index = {};
    let next = 0;
    ids.forEach((id) => {
      const root = find(id);
      if (index[root] == null) index[root] = next++;
      groups.set(id, index[root]);
    });
    return { groups, links };
  }

  global.Proximity = { computeGroups, pairKey };
})(typeof window !== "undefined" ? window : globalThis);
