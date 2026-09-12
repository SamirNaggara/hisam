// ============================================================
// HiSam — Bureau virtuel 2D avec chat vocal de proximite
// ============================================================
//
// SETUP (5 min) :
//
// 1. Va sur https://console.firebase.google.com
// 2. Cree un projet (nom: "hisam" par ex, desactive Google Analytics)
// 3. Dans le projet > "Build" > "Realtime Database" > "Create Database"
//    - Region: europe-west1
//    - Start in TEST MODE (important)
// 4. Dans "Project settings" (engrenage) > "General" > scroll down
//    - Clique "Add app" > Web (</>)
//    - Nom: "hisam"
//    - Copie les valeurs firebaseConfig ci-dessous
// 5. Remplace les valeurs dans FIREBASE_CONFIG
//
// Structure Firebase :
//   /users/{userId}  → { name, online, avatar, muted, ts, pos: { x, y, dir } }
//                      (pos = coordonnees de case dans le bureau, dir 0..3)
//   /logs/{pushId}   → { type, user, ts, date }   (date = ts en clair, heure locale)
//   /rooms               → ancien systeme de salons, plus utilise (peut etre supprime)
//
// Ce fichier est la couche reseau/audio : Firebase (annuaire, presence,
// positions) + PeerJS (voix et video en pair a pair). Le rendu du bureau et la
// logique de proximite sont dans world.js / world-map.js / proximity.js.
//
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAnMeev1Im_FRV1j7AHE7ikUSEbisQ_Wpo",
  authDomain: "hisam-5b58f.firebaseapp.com",
  databaseURL: "https://hisam-5b58f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "hisam-5b58f",
};

// ---- Init Firebase ----
if (typeof firebase === "undefined") {
  // Script CDN (www.gstatic.com) bloque par le reseau ou une extension : sans
  // annuaire rien ne peut marcher. Le dire, plutot que laisser la page muette
  // avec un bouton "Entrer" qui ne fait rien.
  document.getElementById("login-error").textContent =
    "Impossible de charger Firebase (www.gstatic.com bloque ?). HiSam ne peut pas demarrer.";
  throw new Error("[HiSam] firebase absent");
}
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

// ---- State ----
let myId = localStorage.getItem("hisam-id");
if (!myId) {
  // crypto.randomUUID() not available on HTTP (non-secure) on some mobile browsers
  myId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxx-xxxx-xxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  localStorage.setItem("hisam-id", myId);
}

let myName = localStorage.getItem("hisam-name") || "";
let myAvatar = null;
let peer = null;
let localStream = null;   // flux envoye aux pairs (traite si possible)
let rawMicStream = null;  // pistes du peripherique
let micProcessing = null; // chaine de nettoyage { stream, destroy }
let isMuted = false;
let connections = {}; // peerId → MediaConnection
const APP_VERSION = "audio-2";
const PEER_MAX_RECONNECT = 8;
const RESYNC_INTERVAL_MS = 5000;
let resyncTimer = null;
let peerReconnectAttempts = 0;
let peerReconnectTimer = null;
const VIDEO_KINDS = ["camera", "screen"];
let videoStreams = { camera: null, screen: null }; // kind → MediaStream que j'envoie
let videoCalls = { camera: {}, screen: {} }; // kind → peerId → MediaConnection sortante
let remoteVideoCalls = {}; // `${peerId}-${kind}` → MediaConnection entrante

let allUsers = {}; // userId → { name, online, avatar, muted, ts }
let knownUsers = {}; // for notification diffing
let initialLoadDone = false;

// Monde
let world = null;            // instance World
let inOffice = false;        // entre enterOffice() et leaveOffice()
let officeEntered = false;   // enterOffice() a deja ete lance (une seule fois par chargement)
let peerBlocked = false;     // identifiant deja pris par un autre onglet
let peerIdRetries = 0;       // essais apres "identifiant deja pris" (voir handlePeerIdTaken)
let presenceRefs = null;     // { userRef, connectedRef } Firebase de l'identifiant en cours
// Canal entre onglets de ce navigateur : un onglet deja dans le bureau repond
// "pong" a un "ping" (BroadcastChannel : Safari 15.4+, sinon on suppose non).
// Tout ce que startApp() touche de facon synchrone doit etre declare ICI, au-dessus
// de l'entree automatique (utilisateur deja connu) : un let/const declare plus bas
// serait encore dans sa zone morte temporelle a ce moment-la.
const tabChannel = "BroadcastChannel" in window ? new BroadcastChannel("hisam-tab") : null;
if (tabChannel) {
  tabChannel.addEventListener("message", (e) => {
    if (e.data === "ping" && officeEntered && !peerBlocked) tabChannel.postMessage("pong");
  });
}
let pendingIncoming = {};    // key → { call, kind, timer } : appels entrants en attente
let lastInGroupAt = {};      // peerId → timestamp du dernier moment ou il etait dans mon groupe
const POSITION_MIN_INTERVAL_MS = 120;  // ~8 ecritures/s max
const PENDING_CALL_MS = 2000;
const LEAVE_GRACE_MS = 1500;
const LAST_POS_TTL_MS = 2 * 60 * 1000;
const PEER_OPEN_TIMEOUT_MS = 6000;     // on entre quand meme si le broker PeerJS ne repond pas
const PEER_ID_RETRY_MS = [2000, 5000]; // identifiant pris sans onglet vivant : nouveaux essais
const FIREBASE_READ_TIMEOUT_MS = 5000; // lecture des positions a l'entree : on n'attend pas plus

// Audio level analysers
let audioContext = null;
let localAnalyser = null;
let localAnalyserSource = null;
let localAnalyserRaf = null;
let remoteAnalysers = {}; // peerId → { analyser, source }
let remoteRafLoop = null;
let faviconBlinkInterval = null;

// ---- DOM ----
const loginScreen = document.getElementById("login-screen");
const mainScreen = document.getElementById("main-screen");
const usernameInput = document.getElementById("username-input");
const loginError = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");
const avatarPicker = document.getElementById("avatar-picker");
const myNameEl = document.getElementById("my-name");
const onlineCount = document.getElementById("online-count");
const onlineTooltip = document.getElementById("online-tooltip");
const notifBtn = document.getElementById("notif-btn");
const audioContainer = document.getElementById("audio-container");
const worldCanvas = document.getElementById("world");
const alreadyOpenEl = document.getElementById("already-open");
const groupStatusEl = document.getElementById("group-status");
const micWarningEl = document.getElementById("mic-warning");
const peerWarningEl = document.getElementById("peer-warning");
const netWarningEl = document.getElementById("net-warning");

// Petits messages persistants dans la barre du bas (null pour effacer).
function setWarning(el, text) {
  el.textContent = text || "";
  el.style.display = text ? "" : "none";
}

// Active bar
const globalMuteBtn = document.getElementById("global-mute-btn");
const micIcon = document.getElementById("mic-icon");
const micOffIcon = document.getElementById("mic-off-icon");
const leaveOfficeBtn = document.getElementById("leave-office-btn");
const micSelect = document.getElementById("mic-select");
const cameraBtn = document.getElementById("camera-btn");
const screenBtn = document.getElementById("screen-btn");
const videoArea = document.getElementById("video-area");
const videoGrid = document.getElementById("video-grid");

// ---- Login ----
// Prenom et personnage deja choisis : on entre directement. Sinon l'ecran de
// login s'affiche (et "Quitter le bureau" y ramene pour changer l'un ou l'autre).
usernameInput.value = myName;
if (myName && localStorage.getItem("hisam-avatar") !== null) {
  startApp();
}

function currentAvatar() {
  const saved = localStorage.getItem("hisam-avatar");
  if (saved !== null && !Number.isNaN(Number(saved))) return Number(saved) % World.variantCount();
  return World.avatarFor(myId);
}

function initAvatarPicker() {
  World.loadCharacters().then(() => {
    avatarPicker.innerHTML = "";
    const selected = currentAvatar();
    for (let v = 0; v < World.variantCount(); v++) {
      const c = document.createElement("canvas");
      c.width = 48;
      c.height = 60;
      c.title = `Personnage ${v + 1}`;
      if (v === selected) c.classList.add("selected");
      c.addEventListener("click", () => {
        localStorage.setItem("hisam-avatar", String(v));
        avatarPicker.querySelectorAll("canvas").forEach((el) => el.classList.remove("selected"));
        c.classList.add("selected");
      });
      avatarPicker.appendChild(c);
      World.drawAvatarPreview(c, v);
    }
  });
}
initAvatarPicker();

usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

loginBtn.addEventListener("click", () => {
  const name = usernameInput.value.trim();
  if (!name) {
    loginError.textContent = "Entre ton prenom";
    return;
  }
  myName = name;
  localStorage.setItem("hisam-name", name);
  // Safari (macOS) n'autorise un AudioContext a demarrer que pendant un geste
  // utilisateur. Cree ici, il tourne ; cree plus tard, au fond du code
  // asynchrone qui suit getUserMedia(), il resterait "suspended" — et comme le
  // micro traverse ce contexte depuis la reduction de bruit, les pairs ne
  // recevraient que du silence.
  try {
    getOrCreateAudioContext();
  } catch (err) {
    console.warn("[HiSam] AudioContext indisponible :", err);
  }
  startApp();
});

function startApp() {
  // Une ligne a demander a quelqu'un pour qui "ca ne marche pas" : elle dit le
  // navigateur, si la page est en contexte securise (sans quoi pas de micro du
  // tout) et si l'audio a bien le droit de tourner.
  console.log(`[HiSam] version ${APP_VERSION} | ${navigator.userAgent}`);
  console.log(
    `[HiSam] secureContext=${window.isSecureContext}` +
    ` | getUserMedia=${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)}` +
    ` | audioContext=${audioContext ? audioContext.state + " @" + audioContext.sampleRate + "Hz" : "absent"}` +
    ` | audioWorklet=${!!(audioContext && audioContext.audioWorklet)}`
  );
  myAvatar = currentAvatar();
  localStorage.setItem("hisam-avatar", String(myAvatar)); // memorise le choix (ou le defaut)
  startResyncLoop();
  loginScreen.style.display = "none";
  mainScreen.style.display = "flex";
  myNameEl.textContent = myName;
  updateNotifBtn();
  setupPresence();
  // Le script PeerJS vient d'un CDN : bloque par un proxy d'entreprise, il
  // laissait la page sur un bureau vide sans un mot d'explication.
  if (typeof Peer === "undefined") {
    console.error("[HiSam] Bibliotheque PeerJS absente (CDN unpkg bloque ?)");
    showOverlay("<p><strong>La brique audio n'a pas pu etre chargee.</strong></p>" +
      "<p>unpkg.com est peut-etre bloque par le reseau. Le bureau reste visible, mais sans la voix.</p>");
  } else {
    setupPeer();
  }
  listenToUsers();
  drawFavicon(false);
  // On entre dans le bureau des que PeerJS est pret (voir setupPeer), ou apres
  // un delai si le serveur de signalisation ne repond pas (sans audio).
  setTimeout(() => {
    if (!officeEntered && !peerBlocked) {
      console.warn("[HiSam] PeerJS lent ou injoignable, entree dans le bureau sans attendre");
      setWarning(peerWarningEl, "Serveur vocal injoignable : pas de voix pour l'instant");
      enterOffice();
    }
  }, PEER_OPEN_TIMEOUT_MS);
}

// ---- Notifications permission ----
notifBtn.addEventListener("click", () => {
  if (!("Notification" in window)) return;
  Notification.requestPermission().then(updateNotifBtn);
});

function updateNotifBtn() {
  if (!("Notification" in window)) {
    notifBtn.style.display = "none";
    return;
  }
  if (Notification.permission === "granted") {
    notifBtn.classList.add("granted");
    notifBtn.textContent = "Notifs OK";
  } else {
    notifBtn.classList.remove("granted");
    notifBtn.textContent = "Activer notifs";
  }
}

// ---- Presence (Firebase) ----
function teardownPresence() {
  if (!presenceRefs) return;
  presenceRefs.connectedRef.off();
  presenceRefs.userRef.off();
  presenceRefs.userRef.onDisconnect().cancel();
  presenceRefs.userRef.remove();
  presenceRefs = null;
}

function setupPresence() {
  const userRef = db.ref(`users/${myId}`);
  const connectedRef = db.ref(".info/connected");
  presenceRefs = { userRef, connectedRef };

  connectedRef.on("value", (snap) => {
    if (snap.val() === true) {
      userRef.update({
        name: myName,
        online: true,
        avatar: myAvatar,
        ts: firebase.database.ServerValue.TIMESTAMP,
      });
      userRef.onDisconnect().remove();
      publishMicState();
      // Apres une coupure reseau, onDisconnect a pu effacer ma position
      if (inOffice) republishPosition();
    }
  });

  // Re-register if our entry is deleted (e.g. by a stale onDisconnect)
  let reRegistering = false;
  userRef.on("value", (snap) => {
    if (!snap.val() && myName && inOffice && !reRegistering) {
      reRegistering = true;
      userRef.update({
        name: myName,
        online: true,
        avatar: myAvatar,
        ts: firebase.database.ServerValue.TIMESTAMP,
      }).then(() => {
        userRef.onDisconnect().remove();
        publishMicState();
        republishPosition();
        reRegistering = false;
      });
    }
  });
}

// ---- Logs ----
// `ts` est l'horodatage serveur (pour trier), `date` la meme chose en clair,
// en heure locale du navigateur qui ecrit : "2026-09-10 14:05:32".
function writeLog(type, userName) {
  db.ref("logs").push({
    type,
    user: userName,
    ts: firebase.database.ServerValue.TIMESTAMP,
    date: formatDate(new Date()),
  });
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- Listen to users ----
function listenToUsers() {
  db.ref("users").on("value", (snap) => {
    const users = snap.val() || {};

    if (initialLoadDone) {
      Object.entries(users).forEach(([id, user]) => {
        const prev = knownUsers[id];
        if (!prev && user.online) {
          writeLog("connect", user.name);
          if (id !== myId) notify(`${user.name} est arrive(e) au bureau`, "online");
        } else if (prev && prev.online && !user.online) {
          writeLog("disconnect", prev.name);
        } else if (prev && !prev.online && user.online) {
          writeLog("connect", user.name);
          if (id !== myId) notify(`${user.name} est arrive(e) au bureau`, "online");
        }
      });

      // Utilisateur supprime (deconnexion par onDisconnect().remove())
      Object.entries(knownUsers).forEach(([id, prev]) => {
        if (!users[id] && prev.online) {
          writeLog("disconnect", prev.name);
        }
      });
    }

    knownUsers = {};
    Object.entries(users).forEach(([id, user]) => {
      knownUsers[id] = { ...user };
    });

    if (!initialLoadDone) initialLoadDone = true;

    allUsers = users;

    // Les positions changent jusqu'a 8 fois par seconde par personne : on ne
    // refait le travail de presence que si elle a vraiment change.
    const signature = Object.entries(users)
      .map(([id, u]) => `${id}:${u.name}:${u.online}:${u.muted}:${u.avatar}`)
      .sort().join("|");
    const presenceChanged = signature !== lastPresenceSignature;
    lastPresenceSignature = signature;

    if (world) {
      feedPositionsToWorld(users);
      if (presenceChanged) world.recomputeGroups();  // les flags online participent au calcul
    }
    if (presenceChanged) {
      updateOnlineCount();
      updateGroupStatus();
      syncConnections();
    }
  });
}

let lastPresenceSignature = null;

function feedPositionsToWorld(users) {
  Object.entries(users).forEach(([id, u]) => {
    if (id === myId) return;
    if (u.pos && u.online) world.setRemote(id, u.pos);
    else world.removeRemote(id);
  });
  world.forEachRemote((id) => { if (!users[id]) world.removeRemote(id); });
}

function updateOnlineCount() {
  const onlineUsers = Object.values(allUsers).filter((u) => u.online);
  onlineCount.textContent = `${onlineUsers.length} en ligne`;

  if (onlineUsers.length === 0) {
    onlineTooltip.innerHTML = '<div class="online-tooltip-empty">Personne en ligne</div>';
  } else {
    onlineTooltip.innerHTML = onlineUsers
      .map((u) => `<div class="online-tooltip-item">${escapeHtml(u.name || "?")}</div>`)
      .join("");
  }
}

onlineCount.addEventListener("click", (e) => {
  e.stopPropagation();
  onlineTooltip.classList.toggle("visible");
});

document.addEventListener("click", () => {
  onlineTooltip.classList.remove("visible");
});

// ---- Micro ----
// Traitements natifs du navigateur explicites. voiceIsolation est ignore la ou il
// n'existe pas (il n'est pas en "exact").
function micConstraints(deviceId) {
  const c = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    voiceIsolation: true,
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

// Installe un nouveau flux micro brut : le passe dans la chaine de nettoyage
// (audio-processing.js), remplace la piste envoyee aux pairs et relance le VU-metre.
// Si le nettoyage echoue, le flux brut est envoye tel quel (comportement d'origine).
async function installMicStream(rawStream) {
  if (micProcessing) {
    micProcessing.destroy();
    micProcessing = null;
  }
  if (rawMicStream && rawMicStream !== rawStream) {
    rawMicStream.getTracks().forEach((t) => t.stop());
  }
  rawMicStream = rawStream;

  let processed = null;
  try {
    processed = await window.HiSamAudio.buildProcessedStream(getOrCreateAudioContext(), rawStream);
  } catch (err) {
    console.warn("[HiSam] Reduction de bruit indisponible, micro brut :", err);
  }
  // Un autre micro a ete installe pendant le chargement : on abandonne celui-ci.
  if (rawMicStream !== rawStream) {
    if (processed) processed.destroy();
    return;
  }
  if (processed) console.log("[HiSam] Reduction de bruit active (RNNoise)");

  micProcessing = processed;
  localStream = processed ? processed.stream : rawStream;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  replaceAudioTrackEverywhere(localStream.getAudioTracks()[0]);
  // Le VU-metre est un bonus : son echec ne doit pas empecher le micro de partir.
  try {
    startLocalAnalyser(localStream);
  } catch (err) {
    console.warn("[HiSam] VU-metre local indisponible :", err);
  }
}

async function acquireMic() {
  if (localStream) return true;
  let rawStream;
  try {
    const savedMicId = localStorage.getItem("hisam-mic-id");
    rawStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(savedMicId) });
  } catch (err) {
    // If exact deviceId fails, fallback to default
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
      localStorage.removeItem("hisam-mic-id");
    } catch (err2) {
      console.warn("[HiSam] Micro indisponible, mode ecoute seule :", err2);
      micWarningEl.style.display = "";
      return false;
    }
  }
  await installMicStream(rawStream);
  micWarningEl.style.display = "none";
  populateMicSelect();
  publishMicState();
  return true;
}

// ---- Microphone selector ----
async function populateMicSelect() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    const savedMicId = localStorage.getItem("hisam-mic-id");

    // Keep the default option, replace the rest
    micSelect.innerHTML = '<option value="">Micro par defaut</option>';
    mics.forEach((mic) => {
      const option = document.createElement("option");
      option.value = mic.deviceId;
      option.textContent = mic.label || `Micro ${mic.deviceId.slice(0, 6)}`;
      if (mic.deviceId === savedMicId) option.selected = true;
      micSelect.appendChild(option);
    });

    // Only show selector when there are multiple mics
    micSelect.style.display = mics.length > 1 ? "" : "none";
  } catch (err) {
    console.warn("[HiSam] Impossible d'enumerer les micros:", err);
  }
}

function replaceAudioTrackEverywhere(newTrack) {
  Object.values(connections).forEach((call) => {
    if (call.peerConnection) {
      const senders = call.peerConnection.getSenders();
      const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
      if (audioSender) {
        audioSender.replaceTrack(newTrack);
      }
    }
  });
}

async function switchMicrophone(deviceId) {
  let rawStream;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
  } catch (err) {
    console.warn("[HiSam] Erreur changement de micro, fallback defaut:", err);
    localStorage.removeItem("hisam-mic-id");
    micSelect.value = "";
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
    } catch (err2) {
      console.error("[HiSam] Impossible de revenir au micro par defaut:", err2);
      return;
    }
  }
  await installMicStream(rawStream);
}

micSelect.addEventListener("change", () => {
  const deviceId = micSelect.value;
  if (deviceId) {
    localStorage.setItem("hisam-mic-id", deviceId);
  } else {
    localStorage.removeItem("hisam-mic-id");
  }
  if (localStream) {
    switchMicrophone(deviceId);
  }
});

// Refresh mic list when devices change (plug/unplug)
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (localStream) populateMicSelect();
  });
}

// ---- Etat du micro publie aux autres ----
function publishMicState() {
  if (!localStream) return;
  db.ref(`users/${myId}/muted`).set(isMuted);
}

function releaseMicStreams() {
  if (micProcessing) {
    micProcessing.destroy();
    micProcessing = null;
  }
  [localStream, rawMicStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  localStream = null;
  rawMicStream = null;
}

function stopMic() {
  db.ref(`users/${myId}/muted`).remove();
  stopLocalAnalyser();
  releaseMicStreams();
  isMuted = false;
  updateMuteBtn();
}

// ---- Mute ----
leaveOfficeBtn.addEventListener("click", leaveOffice);

globalMuteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => {
    t.enabled = !isMuted;
  });
  publishMicState();
  updateMuteBtn();
});

function updateMuteBtn() {
  if (isMuted) {
    globalMuteBtn.classList.add("muted");
    micIcon.style.display = "none";
    micOffIcon.style.display = "block";
  } else {
    globalMuteBtn.classList.remove("muted");
    micIcon.style.display = "block";
    micOffIcon.style.display = "none";
  }
}

// ---- Bureau : entree / sortie ----
function showOverlay(html) {
  alreadyOpenEl.innerHTML = `<div>${html}</div>`;
  alreadyOpenEl.style.display = "flex";
}

function hideOverlay() {
  alreadyOpenEl.style.display = "none";
}

async function enterOffice() {
  if (officeEntered) return;
  officeEntered = true;

  // Le micro est demande en parallele : la demande d'autorisation du navigateur
  // ne doit pas retarder l'affichage du bureau.
  const micReady = acquireMic();

  if (!world) {
    world = World.create({
      canvas: worldCanvas,
      map: WORLD_MAP,
      myId,
      getProfile: (id) => {
        if (id === myId) return { name: myName, muted: isMuted, avatar: myAvatar, online: true };
        const u = allUsers[id];
        if (!u) return null;
        return {
          name: u.name,
          muted: u.muted === true,
          avatar: Number.isInteger(u.avatar) ? u.avatar : World.avatarFor(id),
          online: !!u.online,
        };
      },
      getSpeakingLevel: speakingLevel,
      // settled = fin de la marche : ecriture immediate, sans attendre le timer
      // (que le navigateur ralentit dans un onglet en arriere-plan)
      onMove: (pos, settled) => publishPosition(pos, !!settled),
      onGroupChange,
    });
    try {
      await world.load();
    } catch (err) {
      console.error("[HiSam] Chargement du monde impossible :", err);
      showOverlay(`<p><strong>Impossible de charger le bureau.</strong></p><p>${escapeHtml(err.message)}</p>`);
      return;
    }
  }

  // Savoir qui est deja ou AVANT de choisir une case d'apparition. Si Firebase
  // ne repond pas (domaine bloque par un reseau d'entreprise, regles...), on
  // n'attend pas indefiniment devant un bureau vide : on entre sans les autres.
  const users = await Promise.race([
    db.ref("users").once("value").then((s) => s.val() || {}),
    new Promise((resolve) => setTimeout(() => resolve(null), FIREBASE_READ_TIMEOUT_MS)),
  ]).catch((err) => {
    console.error("[HiSam] Lecture de /users refusee :", err);
    return null;
  });
  if (users === null) {
    console.warn("[HiSam] Firebase ne repond pas : entree sans les positions des autres");
    setWarning(netWarningEl, "Annuaire injoignable : les autres risquent de ne pas apparaitre");
  }
  feedPositionsToWorld(users || {});

  inOffice = true;
  const pos = world.spawn(loadLastPosition());
  publishPosition(pos, true);
  world.start();
  updateGroupStatus();
  syncConnections();
  console.log(`[HiSam] Dans le bureau en (${pos.x}, ${pos.y})`);
  micReady
    .catch((err) => console.warn("[HiSam] Micro indisponible :", err))
    .then(() => { if (inOffice) syncConnections(); });
}

function leaveOffice() {
  inOffice = false;
  officeEntered = false;
  if (world) world.stop();

  Object.values(connections).forEach((call) => call.close());
  connections = {};
  Object.values(pendingIncoming).forEach((p) => { clearTimeout(p.timer); p.call.close(); });
  pendingIncoming = {};
  lastInGroupAt = {};

  stopAllAnalysers();
  stopMic();
  stopAllShares();
  removeAllRemoteVideos();
  audioContainer.innerHTML = "";

  db.ref(`users/${myId}`).remove();
  localStorage.removeItem("hisam-last-pos");

  // `peer` est conserve : se re-enregistrer sur le broker public a chaque
  // sortie/entree declencherait sa limite de debit.
  mainScreen.style.display = "none";
  loginScreen.style.display = "flex";
}

// ---- Positions (Firebase /users/{id}/pos, coordonnees de case) ----
// Chemin etroit sous mon propre noeud : l'onDisconnect de la presence l'efface
// avec le reste, et les regles Firebase existantes (users/logs) suffisent.
let lastPos = null;
let lastPosWrite = 0;
let posWriteTimer = null;

function publishPosition(pos, force) {
  lastPos = pos;
  if (!inOffice) return;
  const now = Date.now();
  const write = () => {
    posWriteTimer = null;
    if (!inOffice || !lastPos) return;
    lastPosWrite = Date.now();
    db.ref(`users/${myId}/pos`).set({ x: lastPos.x, y: lastPos.y, dir: lastPos.dir });
    saveLastPosition();
  };
  if (force || now - lastPosWrite >= POSITION_MIN_INTERVAL_MS) {
    clearTimeout(posWriteTimer);
    write();
  } else if (!posWriteTimer) {
    // Ecriture trainante : la derniere position est toujours envoyee
    posWriteTimer = setTimeout(write, POSITION_MIN_INTERVAL_MS - (now - lastPosWrite));
  }
}

function republishPosition() {
  if (lastPos) publishPosition(lastPos, true);
}

function saveLastPosition() {
  if (!lastPos) return;
  localStorage.setItem("hisam-last-pos", JSON.stringify({ ...lastPos, ts: Date.now() }));
}

function loadLastPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem("hisam-last-pos") || "null");
    if (!saved || Date.now() - saved.ts > LAST_POS_TTL_MS) return null;
    return saved;
  } catch {
    return null;
  }
}

// ---- Groupe de conversation ----
function onGroupChange(members, prev) {
  flushPendingIncoming();
  syncConnections();
  cleanupConnections();
  updateGroupStatus();

  const joined = members.filter((id) => !prev.includes(id));
  const left = prev.filter((id) => !members.includes(id));
  joined.forEach((id) => {
    const name = allUsers[id]?.name || "Quelqu'un";
    notify(`${name} vous a rejoint`, "room");
  });
  if (left.length && !joined.length) playSound("leave");
}

function updateGroupStatus() {
  if (!world || !inOffice) return;
  const names = world.getGroupMembers().map((id) => allUsers[id]?.name || "?");
  if (names.length === 0) {
    groupStatusEl.textContent = "Personne a portee de voix";
    groupStatusEl.classList.remove("active");
  } else {
    groupStatusEl.textContent = "En conversation avec " + names.join(", ");
    groupStatusEl.classList.add("active");
  }
}

function speakingLevel(id) {
  if (id === myId) return localAnalyser && !isMuted ? getAudioLevel(localAnalyser) : 0;
  const e = remoteAnalysers[id];
  return e ? getAudioLevel(e.analyser) : 0;
}

// ---- PeerJS (audio WebRTC) ----
function setupPeer() {
  peer = new Peer(myId, { debug: 0 });

  peer.on("open", () => {
    console.log("[HiSam] PeerJS connecte:", peer.id);
    // Connexion retablie : on repart d'un delai court
    peerReconnectAttempts = 0;
    clearTimeout(peerReconnectTimer);
    peerReconnectTimer = null;
    setWarning(peerWarningEl, null);
    if (peerIdRetries) { peerBlocked = false; hideOverlay(); } // le fantome a lache l'identifiant
    if (!officeEntered && !peerBlocked) enterOffice();
    else if (inOffice) syncConnections();
  });

  peer.on("call", (call) => {
    call.__initiator = call.peer; // c'est lui qui appelle
    const metadata = call.metadata || {};
    const kind = VIDEO_KINDS.includes(metadata.kind) ? metadata.kind : null;

    if (acceptsCallFrom(call.peer)) {
      answerCall(call, kind);
    } else {
      // Sa vue de nos positions est peut-etre en avance sur la mienne (latence
      // Firebase) : on garde l'appel sous le coude quelques instants.
      holdIncoming(call, kind);
    }
  });

  peer.on("error", (err) => {
    console.warn("[HiSam] PeerJS error:", err.type, err.message);
    if (err.type === "unavailable-id") {
      if (!officeEntered) handlePeerIdTaken();
      else console.log("[HiSam] Identifiant PeerJS deja pris (autre onglet ?)");
    } else if (err.type === "network") {
      schedulePeerReconnect();
    }
  });

  peer.on("disconnected", () => {
    schedulePeerReconnect();
  });
}

// ---- Identifiant PeerJS deja pris ----
// Un autre onglet de CE navigateur est-il vraiment dans le bureau ? Il repond
// "pong" a notre "ping" sur tabChannel.
function otherTabAlive() {
  return new Promise((resolve) => {
    if (!tabChannel) return resolve(false);
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      tabChannel.removeEventListener("message", onMessage);
      resolve(alive);
    };
    const onMessage = (e) => { if (e.data === "pong") finish(true); };
    tabChannel.addEventListener("message", onMessage);
    tabChannel.postMessage("ping");
    setTimeout(() => finish(false), 1000);
  });
}

// L'identifiant est deja enregistre sur le broker. Deux cas :
//  - un autre onglet de ce navigateur est vraiment dans le bureau : on le dit et
//    on s'arrete la (deux avatars et deux micros pour une personne = larsen) ;
//  - personne ne repond : c'est un fantome. Onglet mis en sommeil par Safari,
//    Mac ferme couvercle baisse, page fermee sans que le broker le sache... il
//    garde l'identifiant jusqu'a une minute. Avant, la personne restait bloquee
//    a vie devant "deja ouvert dans un autre onglet" sans aucun onglet a fermer.
//    On reessaie, puis on change d'identifiant : il ne porte rien (prenom et
//    personnage sont stockes a part) et l'ancien noeud Firebase disparaitra
//    avec son propre onDisconnect.
async function handlePeerIdTaken() {
  peerBlocked = true; // pas d'entree dans le bureau tant que ce n'est pas tranche
  if (await otherTabAlive()) {
    console.log("[HiSam] Un autre onglet de ce navigateur est dans le bureau");
    showOverlay("<p><strong>HiSam est deja ouvert dans un autre onglet.</strong></p><p>Ferme l'autre onglet puis recharge cette page.</p>");
    return;
  }
  if (peerIdRetries < PEER_ID_RETRY_MS.length) {
    const delay = PEER_ID_RETRY_MS[peerIdRetries++];
    console.log(`[HiSam] Identifiant PeerJS pris sans onglet vivant : nouvel essai dans ${delay / 1000}s`);
    showOverlay("<p><strong>Connexion en cours...</strong></p><p>Une ancienne session HiSam est encore enregistree, quelques secondes de patience.</p>");
    setTimeout(() => { if (!officeEntered) setupPeer(); }, delay);
    return;
  }
  console.warn("[HiSam] Identifiant PeerJS toujours pris : on en prend un neuf");
  peerIdRetries++;
  rotateIdentity();
  setupPeer();
  // Dernier filet : si meme le nouvel identifiant ne s'ouvre pas, on entre sans voix.
  setTimeout(() => {
    if (officeEntered) return;
    console.warn("[HiSam] PeerJS toujours muet apres changement d'identifiant : entree sans voix");
    peerBlocked = false;
    hideOverlay();
    setWarning(peerWarningEl, "Serveur vocal injoignable : pas de voix pour l'instant");
    enterOffice();
  }, PEER_OPEN_TIMEOUT_MS);
}

function rotateIdentity() {
  teardownPresence();
  myId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxx-xxxx-xxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  localStorage.setItem("hisam-id", myId);
  localStorage.removeItem("hisam-last-pos");
  setupPresence();
}

// Le serveur PeerJS public limite le debit par IP : une reconnexion en boucle
// declenche un bannissement Cloudflare (HTTP 429) de plusieurs dizaines de minutes,
// et plus aucun nouvel appel ne peut etre etabli. D'ou le backoff exponentiel.
function schedulePeerReconnect() {
  if (peerReconnectTimer) return; // une seule tentative en vol a la fois
  if (!peer || peer.destroyed) return;
  if (peerBlocked) return; // identifiant pris par un autre onglet : inutile d'insister

  if (peerReconnectAttempts >= PEER_MAX_RECONNECT) {
    console.error(
      `[HiSam] PeerJS injoignable apres ${PEER_MAX_RECONNECT} tentatives. ` +
      "Le serveur de signalisation public est probablement sature ou bloque cette IP. " +
      "Recharge la page dans un moment."
    );
    return;
  }

  // 2s, 4s, 8s... plafonne a 60s, + jitter pour ne pas synchroniser les onglets
  const base = Math.min(60000, 2000 * Math.pow(2, peerReconnectAttempts));
  const delay = Math.round(base + Math.random() * 1000);
  peerReconnectAttempts++;

  console.log(
    `[HiSam] PeerJS deconnecte, reconnexion dans ${Math.round(delay / 1000)}s ` +
    `(tentative ${peerReconnectAttempts}/${PEER_MAX_RECONNECT})`
  );

  peerReconnectTimer = setTimeout(() => {
    peerReconnectTimer = null;
    if (!peer || peer.destroyed) return;
    peer.reconnect();
  }, delay);
}

function answerCall(call, kind) {
  if (kind) {
    console.log(`[HiSam] video <- appel ${kind} de ${call.peer}, acceptation`);
    call.answer();
    setupIncomingVideoCall(call, kind);
  } else {
    call.answer(localStream || undefined);
    setupCall(call);
  }
}

// Quand A et B se rapprochent en meme temps, chacun appelle l'autre : deux
// connexions naissent pour la meme paire ("glare"). Si chaque cote garde
// arbitrairement la derniere arrivee, les deux cotes ferment celle que l'autre
// garde et il ne reste RIEN : A et B ne s'entendent plus, alors que C, arrive a
// un autre moment, entend les deux. On tranche donc de facon identique des deux
// cotes : la connexion initiee par le plus petit identifiant gagne.
function setupCall(call) {
  const existing = connections[call.peer];
  const duplicate = existing && existing !== call;

  if (duplicate) {
    const sameInitiator = existing.__initiator === call.__initiator;
    // Meme initiateur = simple reprise, la nouvelle remplace l'ancienne.
    // Initiateurs differents = appels croises, le plus petit id l'emporte.
    const keepNew = sameInitiator || call.__initiator < existing.__initiator;
    if (!keepNew) {
      call.close();
      return;
    }
  }

  call.on("stream", (remoteStream) => {
    addAudio(call.peer, remoteStream);
  });
  // Ne nettoyer que si la connexion fermee est bien celle en service : la
  // fermeture d'un doublon perdant ne doit pas couper la connexion gagnante.
  const done = () => {
    if (connections[call.peer] !== call) return;
    removeAudio(call.peer);
    delete connections[call.peer];
  };
  call.on("close", done);
  call.on("error", done);

  // Installer la gagnante AVANT de fermer la perdante : close() emet son
  // evenement de facon synchrone, et le garde ci-dessus doit deja voir la neuve.
  connections[call.peer] = call;
  if (duplicate) existing.close();
}

function addAudio(peerId, stream) {
  removeAudio(peerId);
  const audio = document.createElement("audio");
  audio.id = `audio-${peerId}`;
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  audioContainer.appendChild(audio);
  // Explicit play() for mobile autoplay policy
  audio.play().catch(() => {
    console.log("[HiSam] autoplay bloque pour", peerId, "— en attente d'un geste utilisateur");
  });

  // Indicateur "il parle" : accessoire, et Safari refuse parfois de brancher un
  // flux distant sur Web Audio. Son echec ne doit pas empecher d'entendre le son.
  try {
    startRemoteAnalyser(peerId, stream);
  } catch (err) {
    console.warn("[HiSam] Analyseur distant indisponible pour", peerId, ":", err);
  }
}

// A chaque geste utilisateur : relancer ce que la politique d'autoplay a bloque.
// Surtout pas en "once" : le tout premier clic de la page est celui du bouton
// "Entrer dans le bureau", a un instant ou il n'existe encore ni element <audio>
// ni conversation — il n'y aurait rien a debloquer, et plus jamais l'occasion de
// le faire ensuite. C'est exactement le cas ou Safari laisse le contexte arrete.
function unlockAutoplay(e) {
  if (e && e.repeat) return; // touche maintenue pendant la marche
  document.querySelectorAll("#audio-container audio").forEach((a) => {
    if (a.paused && a.srcObject) a.play().catch(() => {});
  });
  if (audioContext && audioContext.state !== "running") {
    audioContext.resume().catch(() => {});
  }
}
document.addEventListener("touchstart", unlockAutoplay);
document.addEventListener("click", unlockAutoplay);
document.addEventListener("keydown", unlockAutoplay);

function removeAudio(peerId) {
  stopRemoteAnalyser(peerId);
  const el = document.getElementById(`audio-${peerId}`);
  if (el) {
    el.srcObject = null;
    el.remove();
  }
}

// ---- Audio Level Analysers ----

function getOrCreateAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // 48 kHz : impose par RNNoise (audio-processing.js). Les analyseurs s'en moquent,
    // createMediaStreamSource reechantillonne tout seul.
    try {
      audioContext = new Ctx({ sampleRate: 48000 });
    } catch (err) {
      audioContext = new Ctx();
    }
    // Safari repasse le contexte en "interrupted" des qu'une autre application
    // prend l'audio (appel, autre onglet), et ne le relance pas tout seul.
    audioContext.addEventListener("statechange", onAudioContextStateChange);
  }
  if (audioContext.state !== "running") {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

// Le contexte s'est arrete alors que le micro le traverse : le flux envoye aux
// pairs serait silencieux sans que rien ne le signale. On rebascule sur le micro
// brut (sans reduction de bruit) plutot que de laisser une conversation muette.
function onAudioContextStateChange() {
  if (!audioContext || audioContext.state === "running") return;
  audioContext.resume().catch(() => {});
  if (!micProcessing || !rawMicStream) return;
  console.warn(`[HiSam] AudioContext ${audioContext.state} : retour au micro brut`);
  micProcessing.destroy();
  micProcessing = null;
  localStream = rawMicStream;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  replaceAudioTrackEverywhere(localStream.getAudioTracks()[0]);
  try {
    startLocalAnalyser(localStream); // l'ancien pointait sur la chaine detruite
  } catch (err) {
    console.warn("[HiSam] VU-metre local indisponible :", err);
  }
}

// Appele a chaque frame pour chaque pair (anneau "parle" du monde) : le tampon
// est alloue une seule fois par analyseur.
function getAudioLevel(analyser) {
  if (!analyser.__buf) analyser.__buf = new Uint8Array(analyser.frequencyBinCount);
  const data = analyser.__buf;
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  return sum / (data.length * 255); // 0..1
}

function startLocalAnalyser(stream) {
  stopLocalAnalyser();
  const ctx = getOrCreateAudioContext();
  localAnalyserSource = ctx.createMediaStreamSource(stream);
  localAnalyser = ctx.createAnalyser();
  localAnalyser.fftSize = 256;
  localAnalyserSource.connect(localAnalyser);

  const bar = document.getElementById("local-level-bar");
  function loop() {
    if (!localAnalyser) return;
    const level = getAudioLevel(localAnalyser);
    if (bar) bar.style.width = Math.round(level * 100) + "%";
    localAnalyserRaf = requestAnimationFrame(loop);
  }
  loop();
}

function stopLocalAnalyser() {
  if (localAnalyserRaf) {
    cancelAnimationFrame(localAnalyserRaf);
    localAnalyserRaf = null;
  }
  if (localAnalyserSource) {
    localAnalyserSource.disconnect();
    localAnalyserSource = null;
  }
  localAnalyser = null;
  const bar = document.getElementById("local-level-bar");
  if (bar) bar.style.width = "0%";
}

function startRemoteAnalyser(peerId, stream) {
  stopRemoteAnalyser(peerId);
  const ctx = getOrCreateAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  remoteAnalysers[peerId] = { analyser, source };

  // Start the shared remote level loop if not running
  if (!remoteRafLoop) startRemoteLevelLoop();
}

function stopRemoteAnalyser(peerId) {
  const entry = remoteAnalysers[peerId];
  if (entry) {
    entry.source.disconnect();
    delete remoteAnalysers[peerId];
  }
  // If no more remote analysers, stop loop and reset bar
  if (Object.keys(remoteAnalysers).length === 0) {
    if (remoteRafLoop) {
      cancelAnimationFrame(remoteRafLoop);
      remoteRafLoop = null;
    }
    const bar = document.getElementById("remote-level-bar");
    if (bar) bar.style.width = "0%";
  }
}

function startRemoteLevelLoop() {
  const bar = document.getElementById("remote-level-bar");
  function loop() {
    if (Object.keys(remoteAnalysers).length === 0) {
      remoteRafLoop = null;
      if (bar) bar.style.width = "0%";
      return;
    }
    // Take max level across all remote peers
    let maxLevel = 0;
    Object.values(remoteAnalysers).forEach(({ analyser }) => {
      const level = getAudioLevel(analyser);
      if (level > maxLevel) maxLevel = level;
    });
    if (bar) bar.style.width = Math.round(maxLevel * 100) + "%";
    remoteRafLoop = requestAnimationFrame(loop);
  }
  loop();
}

function stopAllAnalysers() {
  stopLocalAnalyser();
  Object.keys(remoteAnalysers).forEach(stopRemoteAnalyser);
  if (remoteRafLoop) {
    cancelAnimationFrame(remoteRafLoop);
    remoteRafLoop = null;
  }
}

// ---- Connection management ----
// A qui dois-je parler ? Aux membres de mon groupe de conversation (composante
// connexe des gens assez proches, dans la meme zone), calcule par world.js.
function shouldTalkTo(id) {
  return inOffice && !!world && !!allUsers[id]?.online && world.isInMyGroup(id);
}

// Appel entrant : on est tolerant d'une bande d'hysteresis, car la vue de
// l'appelant peut etre en avance de 100-300 ms sur la mienne.
function acceptsCallFrom(id) {
  if (!inOffice || !world || !allUsers[id]?.online) return false;
  return world.isInMyGroup(id) || world.distanceTo(id) <= World.CONFIG.LEAVE_TILES;
}

// Nettoyage : petite grace temporelle en plus de l'hysteresis de distance.
function shouldKeep(id) {
  if (shouldTalkTo(id)) {
    lastInGroupAt[id] = Date.now();
    return true;
  }
  return Date.now() - (lastInGroupAt[id] || 0) < LEAVE_GRACE_MS;
}

function holdIncoming(call, kind) {
  const key = kind ? `${call.peer}-${kind}` : call.peer;
  if (pendingIncoming[key]) {
    clearTimeout(pendingIncoming[key].timer);
    pendingIncoming[key].call.close();
  }
  const timer = setTimeout(() => {
    if (pendingIncoming[key]?.call === call) {
      delete pendingIncoming[key];
      console.log(`[HiSam] appel ${kind || "audio"} de ${call.peer} refuse : pas a portee`);
      call.close();
    }
  }, PENDING_CALL_MS);
  pendingIncoming[key] = { call, kind, timer };
}

function flushPendingIncoming() {
  Object.entries(pendingIncoming).forEach(([key, p]) => {
    if (acceptsCallFrom(p.call.peer)) {
      clearTimeout(p.timer);
      delete pendingIncoming[key];
      answerCall(p.call, p.kind);
    }
  });
}

function syncConnections() {
  if (!inOffice || !world || !peer) return;
  // Inutile d'appeler pendant une coupure du serveur de signalisation :
  // peer.call() renvoie undefined et ne fait qu'empiler des erreurs.
  if (peer.disconnected) return;

  if (localStream) {
    world.getGroupMembers().forEach((id) => {
      if (!allUsers[id]?.online) return;
      if (connections[id] && connections[id].open) return;
      const call = peer.call(id, localStream, { metadata: { kind: "audio" } });
      if (call) {
        call.__initiator = myId;
        setupCall(call);
      }
    });
  }

  syncVideoCalls();
}

// syncConnections() est declenche par les changements de groupe et de
// presence. Or le serveur de signalisation public coupe regulierement : un
// appel rate pendant une coupure n'etait jamais retente, laissant deux
// personnes muettes l'une pour l'autre. Ce filet de securite rattrape ces trous.
function startResyncLoop() {
  if (resyncTimer) return;
  resyncTimer = setInterval(() => {
    if (!inOffice) return;
    syncConnections();
    cleanupConnections();
  }, RESYNC_INTERVAL_MS);
}

function cleanupConnections() {
  Object.keys(connections).forEach((peerId) => {
    if (!shouldKeep(peerId)) {
      connections[peerId].close();
      removeAudio(peerId);
      delete connections[peerId];
    }
  });
  cleanupVideoCalls();
}


// ---- Video : camera + partage d'ecran ----
// Chaque flux video passe par un appel PeerJS separe (metadata.kind),
// l'appel audio existant n'est jamais touche.
cameraBtn.addEventListener("click", () => toggleShare("camera"));
screenBtn.addEventListener("click", () => toggleShare("screen"));

if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  screenBtn.style.display = "none"; // pas de partage d'ecran sur mobile
}

async function toggleShare(kind) {
  if (videoStreams[kind]) {
    stopShare(kind);
    return;
  }
  if (!peer || !inOffice) return;

  let stream;
  try {
    if (kind === "screen") {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 15 } },
        audio: true,
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 24 } },
      });
    }
  } catch (err) {
    if (err.name !== "NotAllowedError" && err.name !== "AbortError") {
      alert(kind === "screen"
        ? "Impossible de partager l'ecran."
        : "Impossible d'acceder a la camera. Verifie les permissions du navigateur.");
    }
    return;
  }

  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = kind === "screen" ? "detail" : "motion";
  // Arret via le bouton natif du navigateur ("Arreter le partage")
  track.addEventListener("ended", () => stopShare(kind));

  videoStreams[kind] = stream;
  addVideo("local", kind, stream, "Toi");
  updateShareBtns();
  syncVideoCalls();
}

function stopShare(kind) {
  const stream = videoStreams[kind];
  if (!stream) return;
  videoStreams[kind] = null;
  stream.getTracks().forEach((t) => t.stop());
  Object.values(videoCalls[kind]).forEach((call) => call.close());
  videoCalls[kind] = {};
  removeVideo("local", kind);
  updateShareBtns();
}

function stopAllShares() {
  VIDEO_KINDS.forEach(stopShare);
}

function updateShareBtns() {
  cameraBtn.classList.toggle("active", !!videoStreams.camera);
  cameraBtn.title = videoStreams.camera ? "Couper la camera" : "Activer la camera";
  screenBtn.classList.toggle("active", !!videoStreams.screen);
  screenBtn.title = videoStreams.screen ? "Arreter le partage" : "Partager mon ecran";
}

// Appelle chaque membre de ma conversation, pour chaque flux que j'envoie
function syncVideoCalls() {
  if (!peer || peer.disconnected || !world || !inOffice) return;
  VIDEO_KINDS.forEach((kind) => {
    const stream = videoStreams[kind];
    if (!stream) return;

    world.getGroupMembers().forEach((id) => {
      if (!shouldTalkTo(id)) return;
      if (videoCalls[kind][id]) return; // deja appele

      const call = peer.call(id, stream, { metadata: { kind } });
      if (!call) {
        console.warn(`[HiSam] video -> peer.call(${id}, ${kind}) a echoue`);
        return;
      }
      console.log(`[HiSam] video -> appel ${kind} vers ${id}`);
      watchIce(call, `${kind}->${id}`);
      videoCalls[kind][id] = call;
      const forget = () => {
        if (videoCalls[kind][id] === call) delete videoCalls[kind][id];
      };
      call.on("close", forget);
      call.on("error", forget);
      capBitrate(call, kind === "screen" ? 1500000 : 600000);
    });
  });
}

// Ferme les appels video avec les personnes qui ne sont plus dans ma conversation
function cleanupVideoCalls() {
  VIDEO_KINDS.forEach((kind) => {
    Object.keys(videoCalls[kind]).forEach((peerId) => {
      if (!shouldKeep(peerId)) {
        videoCalls[kind][peerId].close();
        delete videoCalls[kind][peerId];
      }
    });
  });
  Object.keys(remoteVideoCalls).forEach((key) => {
    const call = remoteVideoCalls[key];
    if (!shouldKeep(call.peer)) {
      call.close();
      removeVideo(call.peer, call.metadata.kind);
      delete remoteVideoCalls[key];
    }
  });
}

// Trace l'etat ICE d'un appel video (diagnostic : "failed" = NAT bloquant, il faut un TURN)
function watchIce(call, label) {
  const pc = call.peerConnection;
  if (!pc) return;
  pc.addEventListener("iceconnectionstatechange", () => {
    const state = pc.iceConnectionState;
    if (state === "failed") {
      console.error(`[HiSam] video ${label} : ICE failed (NAT bloquant, un serveur TURN serait necessaire)`);
    } else {
      console.log(`[HiSam] video ${label} : ICE ${state}`);
    }
  });
}

// Limite le debit montant par destinataire (mesh : N-1 copies)
function capBitrate(call, maxBitrate) {
  const pc = call.peerConnection;
  if (!pc) return;
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState !== "connected") return;
    pc.getSenders().forEach((sender) => {
      if (!sender.track || sender.track.kind !== "video") return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = maxBitrate;
      sender.setParameters(params).catch(() => {});
    });
  });
}

function setupIncomingVideoCall(call, kind) {
  const key = `${call.peer}-${kind}`;
  if (remoteVideoCalls[key] && remoteVideoCalls[key] !== call) {
    remoteVideoCalls[key].close();
  }
  remoteVideoCalls[key] = call;

  watchIce(call, `${kind}<-${call.peer}`);
  call.on("stream", (remoteStream) => {
    console.log(`[HiSam] video <- flux ${kind} recu de ${call.peer}`,
      remoteStream.getVideoTracks().length + " piste(s) video");
    const user = allUsers[call.peer];
    addVideo(call.peer, kind, remoteStream, user ? user.name : "?");
  });
  const done = () => {
    if (remoteVideoCalls[key] !== call) return; // doublon perdant : ne rien toucher
    delete remoteVideoCalls[key];
    removeVideo(call.peer, kind);
  };
  call.on("close", done);
  call.on("error", done);
}

function addVideo(peerId, kind, stream, label) {
  removeVideo(peerId, kind);
  const tile = document.createElement("div");
  tile.id = `video-${peerId}-${kind}`;
  tile.className = `video-tile ${kind}${peerId === "local" ? " local" : ""}`;
  tile.title = "Cliquer pour agrandir";

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.setAttribute("playsinline", "");
  // Mon propre flux : muet (sinon echo). Le son d'un partage d'ecran distant est joue.
  video.muted = peerId === "local";
  tile.appendChild(video);

  const caption = document.createElement("span");
  caption.className = "video-tile-label";
  caption.textContent = `${label} · ${kind === "screen" ? "Ecran" : "Camera"}`;
  tile.appendChild(caption);

  tile.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (tile.requestFullscreen) {
      tile.requestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  });

  videoGrid.appendChild(tile);
  video.play().catch(() => {});
  updateVideoArea();
}

function removeVideo(peerId, kind) {
  const el = document.getElementById(`video-${peerId}-${kind}`);
  if (el) {
    const v = el.querySelector("video");
    if (v) v.srcObject = null;
    el.remove();
  }
  updateVideoArea();
}

function removeAllRemoteVideos() {
  Object.values(remoteVideoCalls).forEach((call) => call.close());
  remoteVideoCalls = {};
  videoGrid.innerHTML = "";
  updateVideoArea();
}

function updateVideoArea() {
  videoArea.style.display = videoGrid.children.length > 0 ? "" : "none";
}

// ---- Notifications ----
function notify(message, type) {
  playSound(type);

  if (document.hidden) startFaviconBlink();

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("HiSam", { body: message, tag: "hisam-" + Date.now() });
  }
}

function playSound(type) {
  try {
    // Le contexte partage, jamais un nouveau : WebKit plafonne a quatre
    // AudioContext par page, et le cinquieme leve. Passe ce seuil, plus aucun
    // VU-metre ni reduction de bruit ne pouvait demarrer.
    const ctx = getOrCreateAudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);

    if (type === "online") {
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = "sine";
      osc.frequency.setValueAtTime(523, ctx.currentTime);
      osc.frequency.setValueAtTime(659, ctx.currentTime + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.onended = () => gain.disconnect(); // le contexte est partage : on ne laisse pas le noeud derriere
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } else if (type === "room") {
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = "sine";
      osc.frequency.setValueAtTime(523, ctx.currentTime);
      osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.onended = () => gain.disconnect(); // le contexte est partage : on ne laisse pas le noeud derriere
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } else if (type === "leave") {
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.onended = () => gain.disconnect(); // le contexte est partage : on ne laisse pas le noeud derriere
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {
    // Web Audio not available
  }
}

// ---- Utility ----
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- Favicon ----
function drawFavicon(badge) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");

  // Fond arrondi avec degrade violet
  const grad = ctx.createLinearGradient(0, 0, 32, 32);
  grad.addColorStop(0, "#7c6cf0");
  grad.addColorStop(1, "#5a4bd1");
  ctx.beginPath();
  ctx.roundRect(0, 0, 32, 32, 8);
  ctx.fillStyle = grad;
  ctx.fill();

  // Texte "Hi" blanc
  ctx.fillStyle = "#fff";
  ctx.font = "bold 15px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Hi", 16, 17);

  // Badge rouge clignotant
  if (badge) {
    ctx.beginPath();
    ctx.arc(27, 6, 5, 0, 2 * Math.PI);
    ctx.fillStyle = "#e74c3c";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#5a4bd1";
    ctx.stroke();
  }

  const link = document.getElementById("favicon");
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}

function startFaviconBlink() {
  if (faviconBlinkInterval) return;
  let showBadge = true;
  drawFavicon(true);
  faviconBlinkInterval = setInterval(() => {
    showBadge = !showBadge;
    drawFavicon(showBadge);
  }, 600);
}

function stopFaviconBlink() {
  if (faviconBlinkInterval) {
    clearInterval(faviconBlinkInterval);
    faviconBlinkInterval = null;
  }
  drawFavicon(false);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) stopFaviconBlink();
});

// ---- Cleanup on close ----
window.addEventListener("beforeunload", () => {
  // Position memorisee pour reapparaitre au meme endroit apres un refresh
  saveLastPosition();

  Object.values(connections).forEach((call) => call.close());
  releaseMicStreams();

  db.ref(`users/${myId}`).remove();
});
