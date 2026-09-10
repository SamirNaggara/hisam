// ============================================================
// HiSam — moteur du bureau 2D (canvas, top-down, style Pokemon)
// ============================================================
// Aucune reference a Firebase ni PeerJS ici : app.js fournit les profils, les
// niveaux audio et recoit les positions / changements de groupe via des callbacks.
//
// const world = World.create({
//   canvas, map: WORLD_MAP, assets: {...}, myId,
//   getProfile(id)        -> { name, muted, avatar, online } | null
//   getSpeakingLevel(id)  -> 0..1
//   onMove({ x, y, dir }, settled)     a chaque pas termine ou demi-tour ; settled = la marche s'arrete la
//   onGroupChange(members, prev)       seulement quand l'ensemble change
// });
// await world.load(); world.spawn(); world.start();

(function (global) {
  const CONFIG = {
    TILE: 16,
    WALK_TILES_PER_S: 5,      // 200 ms par case
    ENTER_TILES: 2.5,         // un lien de conversation se cree
    LEAVE_TILES: 3.5,         // un lien existant se rompt (hysteresis)
    SNAP_TILES: 3,            // un avatar distant trop en retard est teleporte
    REMOTE_CATCHUP: 1.6,      // acceleration des distants quand ils ont > 2 cases de retard
    SCALE_BREAKPOINTS: [[1400, 4], [900, 3], [0, 2]],
    ACCENT: "#0d9488",
    HINT_MS: 7000,
  };

  const DIRS = ["down", "left", "right", "up"];
  const DIR_DELTA = { 0: [0, 1], 1: [-1, 0], 2: [1, 0], 3: [0, -1] };
  const DEFAULT_VARIANTS = 8;

  // ---- utilitaires ----
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { console.warn("[World] image introuvable :", url); resolve(null); };
      img.src = url;
    });
  }

  function loadJson(url) {
    return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => { if (!j) console.warn("[World] json introuvable :", url); return j; });
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- personnages (planche partagee : monde + selecteur d'avatar) ----
  let charactersPromise = null;
  let characters = { img: null, meta: null };

  function loadCharacters(paths) {
    if (!charactersPromise) {
      const p = paths || { characters: "assets/characters.png", charactersIndex: "assets/characters.json" };
      charactersPromise = Promise.all([loadImage(p.characters), loadJson(p.charactersIndex)])
        .then(([img, meta]) => { characters = { img, meta }; return characters; });
    }
    return charactersPromise;
  }

  function variantCount() {
    return characters.meta ? characters.meta.variants.length : DEFAULT_VARIANTS;
  }

  function avatarFor(userId) {
    return fnv1a(String(userId)) % variantCount();
  }

  function drawSprite(ctx, variant, dir, frame, dx, dy) {
    const { img, meta } = characters;
    if (!img || !meta) {
      // Fallback : silhouette coloree
      ctx.fillStyle = ["#0d9488", "#dc4c4c", "#3b82f6", "#f4b942", "#3fae6e", "#8b5cf6", "#e7e5e4", "#ec6fa0"][variant % 8];
      ctx.fillRect(dx + 3, dy + 2, 10, 16);
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(dx + 3, dy + 18, 10, 2);
      return;
    }
    const fw = meta.frameW, fh = meta.frameH;
    const sx = (dir * meta.framesPerDir + frame) * fw;
    const sy = (variant % meta.variants.length) * fh;
    ctx.drawImage(img, sx, sy, fw, fh, dx, dy, fw, fh);
  }

  // Apercu (frame "down", idle) pour le selecteur d'avatar de l'ecran de login
  function drawAvatarPreview(canvas, variant) {
    return loadCharacters().then(() => {
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fw = characters.meta ? characters.meta.frameW : 16;
      const fh = characters.meta ? characters.meta.frameH : 20;
      const s = Math.max(1, Math.floor(Math.min(canvas.width / fw, canvas.height / fh)));
      ctx.setTransform(s, 0, 0, s, Math.floor((canvas.width - fw * s) / 2), Math.floor((canvas.height - fh * s) / 2));
      drawSprite(ctx, variant, 0, 0, 0, 0);
    });
  }

  // ---- instance ----
  class WorldInstance {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext("2d");
      this.map = opts.map;
      this.assets = Object.assign({
        tileset: "assets/tileset.png",
        tilesetIndex: "assets/tileset.json",
        characters: "assets/characters.png",
        charactersIndex: "assets/characters.json",
      }, opts.assets || {});
      this.myId = opts.myId;
      this.getProfile = opts.getProfile || (() => null);
      this.getSpeakingLevel = opts.getSpeakingLevel || (() => 0);
      this.onMove = opts.onMove || (() => {});
      this.onGroupChange = opts.onGroupChange || (() => {});

      this.tileset = { img: null, meta: null };
      this.walkable = null;
      this.floorCanvas = null;
      this.aboveCanvas = null;

      this.scale = 2;
      this.dpr = 1;
      this.viewW = 0;
      this.viewH = 0;
      this.camX = 0;
      this.camY = 0;

      this.me = { x: 0, y: 0, dir: 0, px: 0, py: 0, moving: false, from: null, to: null, t: 0, anim: 0, path: [], target: null };
      this.remotes = new Map();
      this.prevLinks = new Set();
      this.groupMembers = [];
      this.groupSet = new Set();

      this.keys = [];           // codes enfonces, le plus recent en premier
      this.tapDir = -1;         // frappe breve a consommer au prochain pas (un pas par appui)
      this.running = false;
      this.raf = null;
      this.lastTime = 0;
      this.hintUntil = 0;
      this.loaded = false;

      this._onKeyDown = this._onKeyDown.bind(this);
      this._onKeyUp = this._onKeyUp.bind(this);
      this._onBlur = this._onBlur.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onResize = this.resize.bind(this);
      this._frame = this._frame.bind(this);
    }

    // ---- chargement ----
    async load() {
      const [timg, tmeta] = await Promise.all([
        loadImage(this.assets.tileset), loadJson(this.assets.tilesetIndex),
        loadCharacters(this.assets),
      ]);
      this.tileset = { img: timg, meta: tmeta };
      this.validateMap();
      this.buildCollision();
      this.prerender();
      this.resize();
      this.loaded = true;
      return this;
    }

    validateMap() {
      const m = this.map;
      const names = this.tileset.meta ? this.tileset.meta.names : null;
      const check = (layerName, rows, legend) => {
        if (rows.length !== m.height) throw new Error(`[World] couche ${layerName} : ${rows.length} lignes au lieu de ${m.height}`);
        rows.forEach((row, y) => {
          if (row.length !== m.width) throw new Error(`[World] couche ${layerName} ligne ${y} : ${row.length} colonnes au lieu de ${m.width}`);
          if (!legend) return;
          for (const ch of row) {
            if (layerName === "objects" && ch === ".") continue;
            const entry = legend[ch];
            if (!entry) throw new Error(`[World] couche ${layerName} ligne ${y} : caractere inconnu "${ch}"`);
            const tile = typeof entry === "string" ? entry : entry.tile;
            if (names && names[tile] == null) throw new Error(`[World] tuile "${tile}" absente de tileset.json`);
          }
        });
      };
      check("floor", m.floor, m.floorLegend);
      check("objects", m.objects, m.objectsLegend);
      check("zones", m.zones, null);
    }

    buildCollision() {
      const m = this.map;
      this.walkable = new Uint8Array(m.width * m.height);
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          const ch = m.objects[y][x];
          const entry = ch === "." ? null : m.objectsLegend[ch];
          this.walkable[y * m.width + x] = entry && entry.solid ? 0 : 1;
        }
      }
      m.spawn.forEach(([x, y]) => {
        if (!this.isWalkable(x, y)) throw new Error(`[World] case de spawn (${x},${y}) bloquee`);
      });
    }

    isWalkable(x, y) {
      const m = this.map;
      if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
      return this.walkable[y * m.width + x] === 1;
    }

    zoneAt(x, y) {
      const m = this.map;
      if (x < 0 || y < 0 || x >= m.width || y >= m.height) return "?";
      return m.zones[y][x];
    }

    _tileRect(name) {
      const meta = this.tileset.meta;
      const i = meta.names[name];
      return { sx: (i % meta.columns) * CONFIG.TILE, sy: Math.floor(i / meta.columns) * CONFIG.TILE };
    }

    _drawTile(ctx, name, x, y) {
      const T = CONFIG.TILE;
      if (this.tileset.img && this.tileset.meta && this.tileset.meta.names[name] != null) {
        const { sx, sy } = this._tileRect(name);
        ctx.drawImage(this.tileset.img, sx, sy, T, T, x * T, y * T, T, T);
      } else {
        ctx.fillStyle = name.startsWith("floor") || name === "grass" || name === "mat" ? "#9aa5b1" : "#6b5b4a";
        ctx.fillRect(x * T, y * T, T, T);
      }
    }

    prerender() {
      const m = this.map, T = CONFIG.TILE;
      const mk = () => {
        const c = document.createElement("canvas");
        c.width = m.width * T; c.height = m.height * T;
        const cx = c.getContext("2d");
        cx.imageSmoothingEnabled = false;
        return [c, cx];
      };
      const [floor, fctx] = mk();
      const [above, actx] = mk();
      let hasAbove = false;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          this._drawTile(fctx, m.floorLegend[m.floor[y][x]], x, y);
          const ch = m.objects[y][x];
          if (ch === ".") continue;
          const entry = m.objectsLegend[ch];
          if (entry.above) { this._drawTile(actx, entry.tile, x, y); hasAbove = true; }
          else this._drawTile(fctx, entry.tile, x, y);
        }
      }
      this.floorCanvas = floor;
      this.aboveCanvas = hasAbove ? above : null;
    }

    // ---- viewport ----
    resize() {
      const wrap = this.canvas.parentElement || this.canvas;
      const cw = Math.max(1, wrap.clientWidth), ch = Math.max(1, wrap.clientHeight);
      this.dpr = window.devicePixelRatio || 1;
      this.scale = 2;
      for (const [minW, s] of CONFIG.SCALE_BREAKPOINTS) {
        if (cw >= minW) { this.scale = s; break; }
      }
      this.canvas.width = Math.round(cw * this.dpr);
      this.canvas.height = Math.round(ch * this.dpr);
      this.canvas.style.width = cw + "px";
      this.canvas.style.height = ch + "px";
      this.viewW = Math.ceil(cw / this.scale);
      this.viewH = Math.ceil(ch / this.scale);
    }

    _updateCamera() {
      const T = CONFIG.TILE;
      const mapW = this.map.width * T, mapH = this.map.height * T;
      const cx = this.me.px + T / 2, cy = this.me.py + T / 2;
      this.camX = mapW <= this.viewW ? -Math.floor((this.viewW - mapW) / 2) : Math.round(clamp(cx - this.viewW / 2, 0, mapW - this.viewW));
      this.camY = mapH <= this.viewH ? -Math.floor((this.viewH - mapH) / 2) : Math.round(clamp(cy - this.viewH / 2, 0, mapH - this.viewH));
    }

    // ---- cycle de vie ----
    start() {
      if (this.running) return;
      this.running = true;
      window.addEventListener("keydown", this._onKeyDown);
      window.addEventListener("keyup", this._onKeyUp);
      window.addEventListener("blur", this._onBlur);
      window.addEventListener("resize", this._onResize);
      this.canvas.addEventListener("pointerdown", this._onPointerDown);
      this.hintUntil = performance.now() + CONFIG.HINT_MS;
      this.lastTime = performance.now();
      this.resize();
      this.raf = requestAnimationFrame(this._frame);
    }

    stop() {
      this.running = false;
      window.removeEventListener("keydown", this._onKeyDown);
      window.removeEventListener("keyup", this._onKeyUp);
      window.removeEventListener("blur", this._onBlur);
      window.removeEventListener("resize", this._onResize);
      this.canvas.removeEventListener("pointerdown", this._onPointerDown);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.keys = [];
      this.tapDir = -1;
      this.remotes.clear();
      this.prevLinks = new Set();
      this.groupMembers = [];
      this.groupSet = new Set();
    }

    // ---- spawn ----
    spawn(preferred) {
      const occupied = new Set();
      this.remotes.forEach((r) => occupied.add(r.tx + "," + r.ty));
      const free = (x, y) => this.isWalkable(x, y) && !occupied.has(x + "," + y);

      const spawnDir = Number.isInteger(this.map.spawnDir) ? this.map.spawnDir : 3;
      let pos = null;
      if (preferred && Number.isInteger(preferred.x) && Number.isInteger(preferred.y) && free(preferred.x, preferred.y)) {
        pos = { x: preferred.x, y: preferred.y, dir: Number.isInteger(preferred.dir) ? preferred.dir : spawnDir };
      }
      if (!pos) {
        const cand = this.map.spawn.find(([x, y]) => free(x, y));
        if (cand) pos = { x: cand[0], y: cand[1], dir: spawnDir };
      }
      if (!pos) {
        // Tout est pris : premiere case libre en partant de l'entree
        const [sx, sy] = this.map.spawn[0];
        const found = this._bfs(sx, sy, (x, y) => free(x, y), 4000);
        const [fx, fy] = found || [sx, sy];
        pos = { x: fx, y: fy, dir: spawnDir };
      }
      this.me.x = pos.x; this.me.y = pos.y; this.me.dir = pos.dir;
      this.me.px = pos.x * CONFIG.TILE; this.me.py = pos.y * CONFIG.TILE;
      this.me.moving = false; this.me.path = []; this.me.target = null;
      this.recomputeGroups();
      return { x: pos.x, y: pos.y, dir: pos.dir };
    }

    // ---- distants ----
    setRemote(id, pos) {
      if (id === this.myId || !pos) return;
      const x = pos.x | 0, y = pos.y | 0;
      if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return;
      const dir = Number.isInteger(pos.dir) ? clamp(pos.dir, 0, 3) : 0;
      let r = this.remotes.get(id);
      if (!r) {
        r = { tx: x, ty: y, dir, px: x * CONFIG.TILE, py: y * CONFIG.TILE, anim: 0 };
        this.remotes.set(id, r);
      } else {
        if (r.tx === x && r.ty === y && r.dir === dir) return;
        r.tx = x; r.ty = y; r.dir = dir;
      }
      this.recomputeGroups();
    }

    forEachRemote(fn) {
      Array.from(this.remotes.keys()).forEach(fn);
    }

    removeRemote(id) {
      if (this.remotes.delete(id)) this.recomputeGroups();
    }

    // ---- groupes ----
    recomputeGroups() {
      const players = {};
      players[this.myId] = { x: this.me.x, y: this.me.y, zone: this.zoneAt(this.me.x, this.me.y) };
      this.remotes.forEach((r, id) => {
        const p = this.getProfile(id);
        if (p && p.online === false) return;
        players[id] = { x: r.tx, y: r.ty, zone: this.zoneAt(r.tx, r.ty) };
      });
      const { groups, links } = global.Proximity.computeGroups(players, {
        enter: CONFIG.ENTER_TILES, leave: CONFIG.LEAVE_TILES, prevLinks: this.prevLinks,
      });
      this.prevLinks = links;
      const mine = groups.get(this.myId);
      const members = [];
      groups.forEach((g, id) => { if (id !== this.myId && g === mine) members.push(id); });
      members.sort();
      const prev = this.groupMembers;
      if (members.join("\n") !== prev.join("\n")) {
        this.groupMembers = members;
        this.groupSet = new Set(members);
        this.onGroupChange(members.slice(), prev.slice());
      }
    }

    getGroupMembers() { return this.groupMembers.slice(); }
    isInMyGroup(id) { return this.groupSet.has(id); }
    getMyPosition() { return { x: this.me.x, y: this.me.y, dir: this.me.dir }; }

    distanceTo(id) {
      const r = this.remotes.get(id);
      if (!r) return Infinity;
      if (this.zoneAt(r.tx, r.ty) !== this.zoneAt(this.me.x, this.me.y)) return Infinity;
      return Math.hypot(r.tx - this.me.x, r.ty - this.me.y);
    }

    // ---- entrees ----
    // Fleches, ZQSD (AZERTY) et WASD (QWERTY). On regarde d'abord la lettre
    // produite (e.key), puis la position physique de la touche (e.code), pour
    // couvrir les deux dispositions quel que soit le navigateur.
    _codeToDir(code, key) {
      switch ((key || "").toLowerCase()) {
        case "arrowup": case "z": case "w": return 3;
        case "arrowdown": case "s": return 0;
        case "arrowleft": case "q": case "a": return 1;
        case "arrowright": case "d": return 2;
      }
      switch (code) {
        case "ArrowUp": case "KeyW": return 3;
        case "ArrowDown": case "KeyS": return 0;
        case "ArrowLeft": case "KeyA": return 1;
        case "ArrowRight": case "KeyD": return 2;
        default: return -1;
      }
    }

    _typing() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable;
    }

    _onKeyDown(e) {
      const dir = this._codeToDir(e.code, e.key);
      if (dir < 0 || this._typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.keys = this.keys.filter((k) => k.code !== e.code);
      this.keys.unshift({ code: e.code, dir });
      this.tapDir = dir;
      this.me.path = [];
      this.me.target = null;
    }

    _onKeyUp(e) {
      this.keys = this.keys.filter((k) => k.code !== e.code);
    }

    _onBlur() { this.keys = []; this.tapDir = -1; }

    _onPointerDown(e) {
      if (e.button != null && e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = (e.clientX - rect.left) / this.scale + this.camX;
      const wy = (e.clientY - rect.top) / this.scale + this.camY;
      const tx = Math.floor(wx / CONFIG.TILE), ty = Math.floor(wy / CONFIG.TILE);
      this.walkTo(tx, ty);
      if (this.canvas.focus) this.canvas.focus({ preventScroll: true });
    }

    // ---- pathfinding ----
    _bfs(sx, sy, accept, maxNodes) {
      const m = this.map;
      const seen = new Uint8Array(m.width * m.height);
      const queue = [[sx, sy]];
      seen[sy * m.width + sx] = 1;
      let n = 0;
      while (queue.length && n++ < maxNodes) {
        const [x, y] = queue.shift();
        if (accept(x, y)) return [x, y];
        for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const nx = x + dx, ny = y + dy;
          if (!this.isWalkable(nx, ny) || seen[ny * m.width + nx]) continue;
          seen[ny * m.width + nx] = 1;
          queue.push([nx, ny]);
        }
      }
      return null;
    }

    findPath(fx, fy, tx, ty) {
      const m = this.map;
      if (!this.isWalkable(tx, ty)) {
        // Cible bloquee (un bureau, un mur) : viser la case marchable la plus proche
        let best = null, bestD = Infinity;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = tx + dx, y = ty + dy;
          if (!this.isWalkable(x, y)) continue;
          const d = Math.abs(dx) + Math.abs(dy) + Math.hypot(x - fx, y - fy) * 0.01;
          if (d < bestD) { bestD = d; best = [x, y]; }
        }
        if (!best) return null;
        [tx, ty] = best;
      }
      if (fx === tx && fy === ty) return [];
      const prev = new Int32Array(m.width * m.height).fill(-1);
      const seen = new Uint8Array(m.width * m.height);
      const queue = [fy * m.width + fx];
      seen[fy * m.width + fx] = 1;
      const goal = ty * m.width + tx;
      let n = 0;
      while (queue.length && n++ < 4000) {
        const cur = queue.shift();
        if (cur === goal) break;
        const x = cur % m.width, y = (cur / m.width) | 0;
        for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const nx = x + dx, ny = y + dy;
          if (!this.isWalkable(nx, ny)) continue;
          const ni = ny * m.width + nx;
          if (seen[ni]) continue;
          seen[ni] = 1; prev[ni] = cur;
          queue.push(ni);
        }
      }
      if (!seen[goal]) return null;
      const path = [];
      for (let i = goal; i !== fy * m.width + fx; i = prev[i]) path.push([i % m.width, (i / m.width) | 0]);
      return path.reverse();
    }

    walkTo(tx, ty) {
      const from = this.me.moving ? this.me.to : { x: this.me.x, y: this.me.y };
      const path = this.findPath(from.x, from.y, tx, ty);
      if (!path) return;
      this.me.path = path;
      this.me.target = path.length ? path[path.length - 1] : null;
      this.keys = [];
    }

    // ---- simulation ----
    _tryStep(dir) {
      const [dx, dy] = DIR_DELTA[dir];
      const nx = this.me.x + dx, ny = this.me.y + dy;
      const turned = this.me.dir !== dir;
      this.me.dir = dir;
      if (!this.isWalkable(nx, ny)) {
        if (turned) this.onMove(this.getMyPosition(), true);
        return false;
      }
      this.me.from = { x: this.me.x, y: this.me.y };
      this.me.to = { x: nx, y: ny };
      this.me.t = 0;
      this.me.moving = true;
      return true;
    }

    _tick(dt) {
      const me = this.me, T = CONFIG.TILE;
      if (!me.moving) {
        let dir = -1;
        if (this.keys.length) dir = this.keys[0].dir;
        else if (this.tapDir >= 0) dir = this.tapDir;
        else if (me.path.length) {
          const [nx, ny] = me.path[0];
          dir = nx > me.x ? 2 : nx < me.x ? 1 : ny > me.y ? 0 : 3;
          if (!this.isWalkable(nx, ny)) { me.path = []; me.target = null; dir = -1; }
          else me.path.shift();
        }
        this.tapDir = -1;
        if (dir >= 0) this._tryStep(dir);
      }
      if (me.moving) {
        me.t += dt * CONFIG.WALK_TILES_PER_S;
        me.anim += dt;
        if (me.t >= 1) {
          me.x = me.to.x; me.y = me.to.y;
          me.px = me.x * T; me.py = me.y * T;
          me.moving = false; me.t = 0;
          if (me.target && me.x === me.target[0] && me.y === me.target[1]) me.target = null;
          const settled = this.keys.length === 0 && me.path.length === 0 && this.tapDir < 0;
          this.onMove(this.getMyPosition(), settled);
          this.recomputeGroups();
        } else {
          me.px = me.from.x * T + (me.to.x - me.from.x) * T * me.t;
          me.py = me.from.y * T + (me.to.y - me.from.y) * T * me.t;
        }
      } else {
        me.anim = 0;
      }

      const speed = CONFIG.WALK_TILES_PER_S * T;
      this.remotes.forEach((r) => {
        const gx = r.tx * T, gy = r.ty * T;
        const dx = gx - r.px, dy = gy - r.py;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.01) { r.anim = 0; return; }
        if (dist > CONFIG.SNAP_TILES * T) { r.px = gx; r.py = gy; r.anim = 0; return; }
        const v = speed * (dist > 2 * T ? CONFIG.REMOTE_CATCHUP : 1) * dt;
        if (v >= dist) { r.px = gx; r.py = gy; }
        else { r.px += dx / dist * v; r.py += dy / dist * v; }
        r.anim += dt;
      });
    }

    _frame(now) {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this._tick(dt);
      this._draw(now);
      this.raf = requestAnimationFrame(this._frame);
    }

    // ---- rendu ----
    _frameIndex(anim, moving) {
      const meta = characters.meta;
      if (!moving || !meta) return 0;
      const cyc = meta.walkCycle;
      return cyc[Math.floor(anim * meta.fps) % cyc.length];
    }

    _draw(now) {
      const ctx = this.ctx, T = CONFIG.TILE, S = this.scale, dpr = this.dpr;
      this._updateCamera();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#1c1917";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      // Espace monde (texels), camera appliquee
      ctx.setTransform(S * dpr, 0, 0, S * dpr, -this.camX * S * dpr, -this.camY * S * dpr);
      ctx.imageSmoothingEnabled = false;
      if (this.floorCanvas) ctx.drawImage(this.floorCanvas, 0, 0);

      const me = this.me;
      const feet = (e) => [e.px + T / 2, e.py + T - 2];

      // Portee de conversation autour de moi
      const [mfx, mfy] = feet(me);
      ctx.beginPath();
      ctx.arc(mfx, mfy, CONFIG.ENTER_TILES * T, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(13,148,136,0.06)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(13,148,136,0.28)";
      ctx.stroke();

      // Liens vers les membres de ma conversation
      this.groupMembers.forEach((id) => {
        const r = this.remotes.get(id);
        if (!r) return;
        const [fx, fy] = feet(r);
        ctx.beginPath();
        ctx.moveTo(mfx, mfy); ctx.lineTo(fx, fy);
        ctx.strokeStyle = "rgba(13,148,136,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Entites triees par profondeur
      const entities = [{ id: this.myId, e: me, moving: me.moving, anim: me.anim, dir: me.dir }];
      this.remotes.forEach((r, id) => {
        const p = this.getProfile(id);
        if (p && p.online === false) return;
        const moving = Math.abs(r.px - r.tx * T) + Math.abs(r.py - r.ty * T) > 0.5;
        entities.push({ id, e: r, moving, anim: r.anim, dir: r.dir });
      });
      entities.sort((a, b) => a.e.py - b.e.py);

      // Halo "parle" sous les pieds
      entities.forEach((ent) => {
        const level = clamp(this.getSpeakingLevel(ent.id) * 4, 0, 1);
        if (level < 0.08) return;
        const [fx, fy] = feet(ent.e);
        ctx.beginPath();
        ctx.ellipse(fx, fy, 6 + level * 9, 3 + level * 4.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(13,148,136,${0.15 + level * 0.45})`;
        ctx.fill();
      });

      const labels = [];
      entities.forEach((ent) => {
        const p = this.getProfile(ent.id) || {};
        const variant = Number.isInteger(p.avatar) ? p.avatar : avatarFor(ent.id);
        const frame = this._frameIndex(ent.anim, ent.moving);
        const fh = characters.meta ? characters.meta.frameH : 20;
        const dx = Math.round(ent.e.px), dy = Math.round(ent.e.py + T - fh);
        drawSprite(ctx, variant, ent.dir, frame, dx, dy);
        labels.push({ id: ent.id, name: p.name || "?", muted: !!p.muted, x: dx + T / 2, y: dy });
      });

      if (this.aboveCanvas) ctx.drawImage(this.aboveCanvas, 0, 0);

      // Marqueur de destination (clic)
      if (me.target) {
        const [tx, ty] = me.target;
        const pulse = 0.5 + 0.5 * Math.sin(now / 150);
        ctx.beginPath();
        ctx.arc(tx * T + T / 2, ty * T + T / 2, 3 + pulse * 2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.5 + pulse * 0.4})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // ---- espace ecran : textes ----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const toScreen = (wx, wy) => [(wx - this.camX) * S, (wy - this.camY) * S];

      ctx.font = "bold 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      (this.map.labels || []).forEach((l) => {
        const [sx, sy] = toScreen(l.x * T, l.y * T);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillText(l.text, sx + 1, sy + 1);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(l.text, sx, sy);
      });

      ctx.font = "600 11px Inter, system-ui, sans-serif";
      labels.forEach((l) => {
        const [sx, syRaw] = toScreen(l.x, l.y);
        const sy = syRaw - 5;
        const w = ctx.measureText(l.name).width;
        const padX = 5, h = 15;
        const bw = w + padX * 2 + (l.muted ? 12 : 0);
        const inGroup = l.id === this.myId || this.groupSet.has(l.id);
        ctx.fillStyle = inGroup ? "rgba(13,148,136,0.85)" : "rgba(28,25,23,0.7)";
        ctx.beginPath();
        ctx.roundRect(Math.round(sx - bw / 2), Math.round(sy - h), Math.round(bw), h, 4);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(l.name, Math.round(sx - (l.muted ? 6 : 0)), Math.round(sy - 4));
        if (l.muted) {
          const cx = Math.round(sx + bw / 2 - 9), cy = Math.round(sy - h / 2);
          ctx.beginPath();
          ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx - 3, cy - 3); ctx.lineTo(cx + 3, cy + 3);
          ctx.stroke();
        }
      });

      // Aide au demarrage
      if (now < this.hintUntil) {
        const alpha = clamp((this.hintUntil - now) / 800, 0, 1);
        const text = "Fleches / ZQSD / WASD ou clic pour marcher. Approche-toi de quelqu'un pour lui parler.";
        ctx.font = "500 12px Inter, system-ui, sans-serif";
        const w = ctx.measureText(text).width + 24;
        const cw = this.canvas.width / dpr, chh = this.canvas.height / dpr;
        ctx.fillStyle = `rgba(0,0,0,${0.6 * alpha})`;
        ctx.beginPath();
        ctx.roundRect((cw - w) / 2, chh - 44, w, 28, 8);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.fillText(text, cw / 2, chh - 26);
      }
    }
  }

  global.World = {
    CONFIG,
    DIRS,
    create: (opts) => new WorldInstance(opts),
    loadCharacters,
    drawAvatarPreview,
    avatarFor,
    variantCount,
    fnv1a,
  };
})(window);
