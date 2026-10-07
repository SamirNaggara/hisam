// ============================================================
// HiSam — Salons vocaux, avec un personnage par personne dans chaque salon
// ============================================================
//
// SETUP (5 min) :
//
// 1. Va sur https://console.firebase.google.com
// 2. Cree un projet (nom: "hisam" par ex, desactive Google Analytics)
// 3. Dans le projet > "Build" > "Realtime Database" > "Create Database"
//    - Region: europe-west1
//    - Regles : /users, /rooms et /logs en lecture/ecriture
// 4. Dans "Project settings" (engrenage) > "General" > scroll down
//    - Clique "Add app" > Web (</>)
//    - Nom: "hisam"
//    - Copie les valeurs firebaseConfig ci-dessous
// 5. Remplace les valeurs dans FIREBASE_CONFIG
//
// Structure Firebase :
//   /users/{userId}  → { name, online, avatar, muted, status, ts,
//                        room: { id, name },        (absent = dans le hall)
//                        roomX }                    (place du personnage dans son salon, 0..100)
//                      status = "available" | "busy"
//   /logs/{pushId}   → { type, user, ts, date }   (date = ts en clair, heure locale)
//   /rooms/{roomId}  → { name, createdAt, createdBy, createdById }
//                      (les anciens salons ont aussi un passwordHash, ignore)
//
// Les salons restent dans /rooms quand tout le monde est parti ; on peut les
// renommer, et les supprimer quand ils sont vides. Un salon a la fois.
// users/{id}/room dit ou est chacun. Dans un salon, chacun a son personnage,
// qui ne bouge qu'a l'horizontale (fleches ou clic) sans traverser les autres.
//
// Ce fichier est la couche reseau/audio : Firebase (annuaire, presence,
// salons) + PeerJS (voix et video en pair a pair), plus le hall des salons.
// Les sprites des personnages viennent de world.js ; on choisit le sien sur
// skin.html.
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
let isMuted = true;       // on arrive micro coupe ; le flux envoye est alors silentStream()
let silentAudioStream = null; // piste muette envoyee aux pairs tant que le micro est coupe
let connections = {}; // peerId → MediaConnection
const APP_VERSION = "salons-5";
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

// Salons
const ROOM_KEY = "hisam-last-room";   // { id, name, ts } : on y revient apres un refresh
const STATUS_KEY = "hisam-status";
let myRoom = null;           // { id, name } du salon ou je suis, null = dans le hall
let myStatus = localStorage.getItem(STATUS_KEY) === "busy" ? "busy" : "available";
let joinConfirm = null;      // { id, until } : salon avec quelqu'un d'occupe, second clic attendu
let deleteConfirm = null;    // { id } : suppression d'un salon, second clic attendu
let roomMenuId = null;       // salon dont le menu "..." est ouvert
let renamingId = null;       // salon dont le nom est en cours d'edition
let roomsData = {};          // /rooms : id -> { name, createdAt, createdBy, createdById }

let appEntered = false;      // enterApp() a deja ete lance (une seule fois par chargement)
let appStarted = false;      // startApp() ne cable presence/peer/listeners qu'une fois
let peerBlocked = false;     // identifiant deja pris par un autre onglet
let peerIdRetries = 0;       // essais apres "identifiant deja pris" (voir handlePeerIdTaken)
let presenceRefs = null;     // { userRef, connectedRef } Firebase de l'identifiant en cours
// Canal entre onglets de ce navigateur : un onglet deja entre repond
// "pong" a un "ping" (BroadcastChannel : Safari 15.4+, sinon on suppose non).
// Tout ce que startApp() touche de facon synchrone doit etre declare ICI, au-dessus
// de l'entree automatique (utilisateur deja connu) : un let/const declare plus bas
// serait encore dans sa zone morte temporelle a ce moment-la.
const tabChannel = "BroadcastChannel" in window ? new BroadcastChannel("hisam-tab") : null;
if (tabChannel) {
  tabChannel.addEventListener("message", (e) => {
    if (e.data === "ping" && appEntered && !peerBlocked) tabChannel.postMessage("pong");
    if (e.data === "takeover") onTakenOver();
  });
}
let pendingIncoming = {};    // key → { call, kind, timer } : appels entrants en attente
let lastInGroupAt = {};      // peerId → timestamp du dernier moment ou il etait dans mon groupe
const POSITION_MIN_INTERVAL_MS = 120;  // ~8 ecritures/s max de ma place dans le salon
const PENDING_CALL_MS = 2000;
const LEAVE_GRACE_MS = 1500;
const LAST_POS_TTL_MS = 2 * 60 * 1000;
const PEER_OPEN_TIMEOUT_MS = 6000;     // on entre quand meme si le broker PeerJS ne repond pas
const PEER_ID_RETRY_MS = [2000, 5000]; // identifiant pris sans onglet vivant : nouveaux essais
const FIREBASE_READ_TIMEOUT_MS = 5000; // lecture de /users a l'entree : on n'attend pas plus

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
const myNameEl = document.getElementById("my-name");
const notifBtn = document.getElementById("notif-btn");
const audioContainer = document.getElementById("audio-container");
const roomsList = document.getElementById("rooms-list");
const lobbyList = document.getElementById("lobby-list");
const newRoomForm = document.getElementById("new-room-form");
const newRoomInput = document.getElementById("new-room-input");
const statusBtn = document.getElementById("status-btn");
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
const leaveRoomBtn = document.getElementById("leave-room-btn");
const micSelect = document.getElementById("mic-select");
const cameraBtn = document.getElementById("camera-btn");
const screenBtn = document.getElementById("screen-btn");
const videoArea = document.getElementById("video-area");
const videoGrid = document.getElementById("video-grid");

// ---- Login ----
// Prenom deja connu : on entre directement, pas de salle d'attente. Sinon un
// simple champ prenom (premiere visite).
usernameInput.value = myName;
if (myName) {
  startApp();
}

// Personnage tire au sort la premiere fois, puis toujours le meme (memorise par
// startApp). La page skin.html permet d'en changer.
function currentAvatar() {
  const saved = localStorage.getItem("hisam-avatar");
  if (saved !== null && !Number.isNaN(Number(saved))) return Number(saved) % World.variantCount();
  return Math.floor(Math.random() * World.variantCount());
}

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
  localStorage.setItem("hisam-avatar", String(myAvatar)); // memorise le tirage
  loginScreen.style.display = "none";
  mainScreen.style.display = "flex";
  myNameEl.textContent = myName;
  updateNotifBtn();
  updateStatusBtn();
  if (appStarted) return;
  appStarted = true;
  startResyncLoop();
  setupPresence();
  // Le script PeerJS vient d'un CDN : bloque par un proxy d'entreprise, il
  // laissait la page sans voix sans un mot d'explication.
  if (typeof Peer === "undefined") {
    console.error("[HiSam] Bibliotheque PeerJS absente (CDN unpkg bloque ?)");
    showOverlay("<p><strong>La brique audio n'a pas pu etre chargee.</strong></p>" +
      "<p>unpkg.com est peut-etre bloque par le reseau. Les salons restent visibles, mais sans la voix.</p>");
  } else {
    setupPeer();
  }
  listenToUsers();
  listenToRooms();
  // Les sprites arrivent apres le premier rendu des salons : on redessine
  World.loadCharacters().then(() => {
    scenes.forEach((scene) => scene.chars.forEach((c) => { c.drawn = ""; }));
    updateScenes();
  }).catch((err) => console.warn("[HiSam] Personnages indisponibles :", err));
  drawFavicon(false);
  // On entre dans le hall des que PeerJS est pret (voir setupPeer), ou apres
  // un delai si le serveur de signalisation ne repond pas (sans audio).
  setTimeout(() => {
    if (!appEntered && !peerBlocked) {
      console.warn("[HiSam] PeerJS lent ou injoignable, entree sans attendre");
      setWarning(peerWarningEl, "Serveur vocal injoignable : pas de voix pour l'instant");
      enterApp();
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

// Ce que je publie sur mon noeud. Le salon n'est ecrit que si j'en ai un : un
// second onglet bloque ("deja ouvert") partage mon identifiant et ne doit pas
// sortir le premier de son salon.
function presenceFields() {
  const fields = {
    name: myName,
    online: true,
    avatar: myAvatar,
    status: myStatus,
    ts: firebase.database.ServerValue.TIMESTAMP,
  };
  if (myRoom) fields.room = myRoom;
  if (myRoom && myX !== null) fields.roomX = Math.round(myX * 10) / 10;
  return fields;
}

function setupPresence() {
  const userRef = db.ref(`users/${myId}`);
  const connectedRef = db.ref(".info/connected");
  presenceRefs = { userRef, connectedRef };

  connectedRef.on("value", (snap) => {
    if (snap.val() === true) {
      userRef.update(presenceFields());
      userRef.onDisconnect().remove();
      publishMicState();
      // Apres une coupure reseau, onDisconnect a pu effacer ma place
      republishRoomX();
    }
  });

  // Re-register if our entry is deleted (e.g. by a stale onDisconnect)
  let reRegistering = false;
  userRef.on("value", (snap) => {
    const val = snap.val();
    // Un wizz ecrit sur mon noeud par quelqu'un d'autre : on le consomme
    if (val && val.wizz && val.wizz.ts !== lastWizzTs) {
      lastWizzTs = val.wizz.ts;
      userRef.child("wizz").remove();
      receiveWizz(val.wizz);
    }
    if (!val && myName && appEntered && !reRegistering) {
      reRegistering = true;
      userRef.update(presenceFields()).then(() => {
        userRef.onDisconnect().remove();
        publishMicState();
        republishRoomX();
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
function isOnline(u) {
  return !!u && u.online === true && !!u.name;
}

function isBusyUser(u) {
  return !!u && u.status === "busy";
}

function roomIdOf(u) {
  return isOnline(u) && u.room && u.room.id ? u.room.id : null;
}

function listenToUsers() {
  db.ref("users").on("value", (snap) => {
    const users = snap.val() || {};

    if (initialLoadDone) {
      Object.entries(users).forEach(([id, user]) => {
        const wasIn = isOnline(knownUsers[id]);
        const isIn = isOnline(user);
        if (!wasIn && isIn) {
          // Pas de notification ici : seulement quand quelqu'un entre dans mon salon
          writeLog("connect", user.name);
        } else if (wasIn && !isIn) {
          writeLog("disconnect", knownUsers[id].name);
        }
      });

      // Utilisateur supprime (deconnexion par onDisconnect().remove())
      Object.entries(knownUsers).forEach(([id, prev]) => {
        if (!users[id] && isOnline(prev)) {
          writeLog("disconnect", prev.name);
        }
      });

      // Arrivees / departs dans mon salon
      if (myRoom) {
        const inMine = (u) => roomIdOf(u) === myRoom.id;
        const joined = Object.keys(users).filter((id) => id !== myId && inMine(users[id]) && !inMine(knownUsers[id]));
        const left = Object.keys(knownUsers).filter((id) => id !== myId && inMine(knownUsers[id]) && !inMine(users[id]));
        joined.forEach((id) => notify(`${users[id].name} a rejoint ${myRoom.name}`, "room"));
        if (left.length && !joined.length) playSound("leave");
      }
    }

    knownUsers = {};
    Object.entries(users).forEach(([id, user]) => {
      knownUsers[id] = { ...user };
    });

    if (!initialLoadDone) initialLoadDone = true;

    allUsers = users;

    // Quelqu'un vient d'etre wizze : son personnage tremble chez tout le monde
    Object.entries(users).forEach(([id, u]) => {
      if (u.wizz && u.wizz.ts && wizzSeen[id] !== u.wizz.ts) {
        wizzSeen[id] = u.wizz.ts;
        if (id !== myId) shakeCharacter(id);
      }
    });

    // Les places dans les salons changent jusqu'a 8 fois par seconde par
    // personne : on ne refait le travail de presence que s'il a vraiment change.
    const signature = Object.entries(users)
      .map(([id, u]) => `${id}:${u.name}:${u.online}:${u.muted}:${u.avatar}:${u.status}:${u.room?.id}`)
      .sort().join("|");
    const presenceChanged = signature !== lastPresenceSignature;
    lastPresenceSignature = signature;

    if (presenceChanged) {
      renderRooms();
      updateGroupStatus();
      flushPendingIncoming();
      syncConnections();
      cleanupConnections();
    } else {
      updateScenes();
    }
  });
}

let lastPresenceSignature = null;

const MIC_OFF_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';

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

// Demande le micro memorise, sinon celui par defaut. null si aucun n'est accessible.
async function requestMicStream() {
  try {
    const savedMicId = localStorage.getItem("hisam-mic-id");
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(savedMicId) });
  } catch (err) {
    // If exact deviceId fails, fallback to default
    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
      localStorage.removeItem("hisam-mic-id");
      return rawStream;
    } catch (err2) {
      console.warn("[HiSam] Micro indisponible :", err2);
      return null;
    }
  }
}

// Piste audio muette. C'est le flux envoye aux pairs tant que le micro est
// coupe : PeerJS refuse d'appeler sans flux, et une connexion acceptee sans
// flux ne peut plus en recevoir un ensuite (pas de renegociation). Avec cette
// piste en place des le depart, le vrai micro la remplace par replaceTrack.
function silentStream() {
  if (!silentAudioStream) {
    silentAudioStream = getOrCreateAudioContext().createMediaStreamDestination().stream;
  }
  return silentAudioStream;
}

// Coupe le micro : la piste muette repart aux pairs, le peripherique est relache.
function muteMic() {
  isMuted = true;
  updateMuteBtn();
  publishMicState();
  stopLocalAnalyser();
  if (micProcessing) {
    micProcessing.destroy();
    micProcessing = null;
  }
  if (rawMicStream) rawMicStream.getTracks().forEach((t) => t.stop());
  rawMicStream = null;
  localStream = silentStream();
  replaceAudioTrackEverywhere(localStream.getAudioTracks()[0]);
  updateGroupStatus();
}

// Reactive le micro : demande le peripherique, la nouvelle piste remplace la muette.
async function unmuteMic() {
  // Un clic : Safari autorise ici le demarrage de l'AudioContext (silence sinon)
  try { getOrCreateAudioContext(); } catch (err) { console.warn("[HiSam] AudioContext indisponible :", err); }
  const rawStream = await requestMicStream();
  if (!rawStream) {
    micWarningEl.style.display = "";
    return false; // reste coupe
  }
  isMuted = false;
  updateMuteBtn();
  publishMicState();
  await installMicStream(rawStream);
  micWarningEl.style.display = "none";
  populateMicSelect();
  updateGroupStatus();
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

// replaceTrack est asynchrone et peut echouer (Safari surtout) : sans ca, le
// bouton dirait "micro allume" alors que la piste muette part toujours.
function replaceAudioTrackEverywhere(newTrack) {
  Object.entries(connections).forEach(([id, call]) => {
    if (!call.peerConnection) return;
    const senders = call.peerConnection.getSenders();
    const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
    if (!audioSender) {
      console.warn(`[HiSam] Pas d'emetteur audio vers ${id} : la piste ne peut pas etre remplacee`);
      return;
    }
    audioSender.replaceTrack(newTrack).catch((err) => {
      console.warn(`[HiSam] replaceTrack vers ${id} a echoue :`, err);
    });
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
  // Micro coupe : le peripherique est relache, le choix sera pris a la reactivation
  if (rawMicStream && !isMuted) {
    switchMicrophone(deviceId);
  }
});

// Refresh mic list when devices change (plug/unplug)
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (rawMicStream) populateMicSelect();
  });
}

// ---- Etat du micro publie aux autres ----
function publishMicState() {
  db.ref(`users/${myId}/muted`).set(isMuted);
}

function releaseMicStreams() {
  if (micProcessing) {
    micProcessing.destroy();
    micProcessing = null;
  }
  [localStream, rawMicStream].forEach((s) => {
    if (s && s !== silentAudioStream) s.getTracks().forEach((t) => t.stop());
  });
  localStream = null;
  rawMicStream = null;
}

function stopMic() {
  db.ref(`users/${myId}/muted`).remove();
  stopLocalAnalyser();
  releaseMicStreams();
  isMuted = true;
  updateMuteBtn();
}

// ---- Mute ----
leaveRoomBtn.addEventListener("click", () => leaveRoom());

// On arrive micro coupe, et couper relache vraiment le peripherique : avec un
// simple track.enabled = false, le navigateur garde son indicateur "micro en
// cours d'utilisation" sur l'onglet, et on ne sait plus si on est entendu ou
// pas. Les connexions restent en place : la piste envoyee aux pairs est la
// piste muette (silentStream), et le vrai micro la remplace a la reactivation.
let micToggling = false;

globalMuteBtn.addEventListener("click", async () => {
  if (!myRoom || micToggling) return;
  micToggling = true;
  try {
    if (!isMuted) muteMic();
    else await unmuteMic();
  } finally {
    micToggling = false;
  }
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

// ---- Entree dans l'appli ----
function showOverlay(html) {
  alreadyOpenEl.innerHTML = `<div>${html}</div>`;
  alreadyOpenEl.style.display = "flex";
}

function hideOverlay() {
  alreadyOpenEl.style.display = "none";
}

// Entree dans l'appli (une fois PeerJS pret) : le hall des salons, micro coupe.
// On retourne dans le salon d'avant un refresh, ou celui d'un lien #join=.
async function enterApp() {
  if (appEntered) return;
  appEntered = true;

  // On arrive micro coupe : la piste muette part aux pairs, le vrai micro ne
  // sera demande qu'au clic sur le bouton (un geste : Safari l'exige aussi).
  isMuted = true;
  updateMuteBtn();
  try {
    localStream = silentStream();
  } catch (err) {
    console.warn("[HiSam] Piste muette indisponible :", err);
  }

  // Savoir qui est ou AVANT de choisir un salon (nom du salon d'un lien #join=).
  // Si Firebase ne repond pas (domaine bloque par un reseau d'entreprise,
  // regles...), on n'attend pas indefiniment devant un hall vide.
  if (!initialLoadDone) {
    const users = await Promise.race([
      db.ref("users").once("value").then((snap) => snap.val() || {}),
      new Promise((resolve) => setTimeout(() => resolve(null), FIREBASE_READ_TIMEOUT_MS)),
    ]).catch((err) => {
      console.error("[HiSam] Lecture de /users refusee :", err);
      return null;
    });
    if (users === null) {
      console.warn("[HiSam] Firebase ne repond pas : entree sans la liste des autres");
      setWarning(netWarningEl, "Annuaire injoignable : les autres risquent de ne pas apparaitre");
    } else if (!initialLoadDone) {
      allUsers = users;
    }
  }

  updateRoomUi();
  const room = roomFromHash() || loadLastRoom();
  if (room) joinRoom(room);
  console.log("[HiSam] Dans le hall des salons");
}

// ---- Salons ----
// Les salons vivent dans /rooms et restent quand tout le monde est parti. On
// peut les renommer, et les supprimer quand ils sont vides.
function listenToRooms() {
  db.ref("rooms").on("value", (snap) => {
    roomsData = snap.val() || {};
    // Mon salon renomme : je mets a jour mon noeud (status.html, widget.html le lisent)
    const fresh = myRoom && roomsData[myRoom.id];
    if (fresh && fresh.name && fresh.name !== myRoom.name) {
      myRoom = { id: myRoom.id, name: fresh.name };
      db.ref(`users/${myId}/room`).set(myRoom);
      saveLastRoom();
      updateGroupStatus();
    }
    renderRooms();
  }, (err) => {
    console.error("[HiSam] Lecture de /rooms refusee :", err);
  });
}

// Nom a jour d'un salon : /rooms, sinon ce que ses membres ont publie
function roomById(id, fallbackName) {
  if (roomsData[id] && roomsData[id].name) return { id, name: roomsData[id].name };
  if (fallbackName) return { id, name: fallbackName };
  const member = Object.values(allUsers).find((u) => roomIdOf(u) === id);
  return member ? { id, name: member.room.name || "Salon" } : null;
}

// #join=<id> : lien vers un salon (widget.html, partage)
function roomFromHash() {
  const m = location.hash.match(/^#join=(.+)$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const room = roomById(decodeURIComponent(m[1]));
  if (!room) {
    setWarning(netWarningEl, "Ce salon n'existe plus");
    setTimeout(() => { if (netWarningEl.textContent.startsWith("Ce salon n'existe")) setWarning(netWarningEl, null); }, 5000);
  }
  return room;
}

function saveLastRoom() {
  if (myRoom) localStorage.setItem(ROOM_KEY, JSON.stringify({ ...myRoom, ts: Date.now() }));
}

function loadLastRoom() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY) || "null");
    if (!saved || !saved.id || Date.now() - saved.ts > LAST_POS_TTL_MS) return null;
    return roomById(saved.id, saved.name || "Salon");
  } catch {
    return null;
  }
}

// Les salons a afficher : mon salon, puis ceux de /rooms (et ceux qu'un membre
// annonce sans qu'ils soient dans /rooms, pour ne cacher personne).
function listRooms() {
  const rooms = new Map();
  const add = (room) => {
    if (!rooms.has(room.id)) {
      rooms.set(room.id, { id: room.id, name: room.name || "Salon", members: [], stored: !!roomsData[room.id] });
    }
    return rooms.get(room.id);
  };
  Object.keys(roomsData).forEach((id) => add(roomById(id)));
  if (myRoom) add(roomById(myRoom.id, myRoom.name)).members.push(myId);
  const lobby = [];
  Object.keys(allUsers).forEach((id) => {
    if (id === myId) return;
    const u = allUsers[id];
    if (!isOnline(u)) return;
    const rid = roomIdOf(u);
    if (!rid) { lobby.push(id); return; }
    add(roomById(rid, u.room.name)).members.push(id);
  });
  const rank = (r) => (myRoom && r.id === myRoom.id ? 0 : 1);
  const list = [...rooms.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { rooms: list, lobby };
}

function nameOf(id) {
  return id === myId ? myName : allUsers[id]?.name || "?";
}

// Une pastille de personne (hors salon) : point de statut, prenom, wizz.
function personChip(id) {
  const me = id === myId;
  const u = me ? { status: myStatus } : allUsers[id] || {};
  const busy = isBusyUser(u);
  const chip = document.createElement("span");
  chip.className = "room-member" + (busy ? " busy" : "") + (me ? " me" : "");
  chip.title = busy ? "Occupe(e)" : "Disponible";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  chip.appendChild(dot);
  const label = document.createElement("span");
  label.textContent = me ? `${myName} (toi)` : nameOf(id);
  chip.appendChild(label);
  if (!me) {
    const wizz = document.createElement("button");
    wizz.type = "button";
    wizz.className = "chip-wizz";
    wizz.textContent = "Wizz";
    wizz.title = busy ? "Occupe(e) : pas de wizz" : "Lui envoyer un wizz";
    wizz.disabled = !canWizz(id);
    wizz.addEventListener("click", (e) => { e.stopPropagation(); sendWizz(id); });
    chip.appendChild(wizz);
  }
  return chip;
}

// Bouton "..." d'un salon : Renommer, Supprimer (seulement vide, en deux clics)
function roomMenu(room, memberCount) {
  const wrap = document.createElement("div");
  wrap.className = "room-menu-wrap";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn-room-more";
  toggle.title = "Options du salon";
  toggle.textContent = "\u22EF";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    roomMenuId = roomMenuId === room.id ? null : room.id;
    deleteConfirm = null;
    renderRooms();
  });
  wrap.appendChild(toggle);
  if (roomMenuId !== room.id) return wrap;

  const menu = document.createElement("div");
  menu.className = "room-menu";
  menu.addEventListener("click", (e) => e.stopPropagation());
  const item = (text, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "more-item";
    b.textContent = text;
    b.addEventListener("click", onClick);
    menu.appendChild(b);
    return b;
  };
  item("Renommer", () => {
    roomMenuId = null;
    renamingId = room.id;
    renderRooms();
  });
  const armed = deleteConfirm && deleteConfirm.id === room.id;
  const del = item(armed ? "Confirmer la suppression" : "Supprimer", () => {
    if (!armed) {
      deleteConfirm = { id: room.id };
      renderRooms();
      return;
    }
    roomMenuId = null;
    deleteConfirm = null;
    deleteRoom(room.id);
  });
  del.classList.add("danger");
  if (memberCount > 0) {
    del.disabled = true;
    del.title = "Le salon doit etre vide pour etre supprime";
  }
  wrap.appendChild(menu);
  return wrap;
}

// Clic ailleurs : le menu d'un salon se ferme
document.addEventListener("click", () => {
  if (roomMenuId === null) return;
  roomMenuId = null;
  deleteConfirm = null;
  renderRooms();
});

function renderRooms() {
  if (!appEntered) return;
  // Un renommage en cours : on ne detruit pas le champ sous les doigts
  if (renamingId && roomsList.contains(document.activeElement)) return;
  const { rooms, lobby } = listRooms();
  roomsList.innerHTML = "";
  rooms.forEach((room) => {
    const mine = !!myRoom && myRoom.id === room.id;
    const n = room.members.length;
    const card = document.createElement("div");
    card.className = "room-card" + (mine ? " room-active" : "");

    const head = document.createElement("div");
    head.className = "room-card-header";
    const info = document.createElement("div");
    info.className = "room-info";
    if (renamingId === room.id) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "room-rename";
      input.maxLength = 30;
      input.value = room.name;
      const finish = (save) => {
        if (renamingId !== room.id) return;
        renamingId = null;
        const name = input.value.trim().slice(0, 30);
        if (save && name && name !== room.name) renameRoom(room.id, name);
        renderRooms();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      info.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      const name = document.createElement("span");
      name.className = "room-name";
      name.textContent = room.name;
      info.appendChild(name);
    }
    const count = document.createElement("span");
    count.className = "room-count";
    count.textContent = n === 0 ? "Vide" : `${n} personne${n > 1 ? "s" : ""}`;
    info.appendChild(count);
    head.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "room-actions";
    if (room.stored && renamingId !== room.id) actions.appendChild(roomMenu(room, n));

    const btn = document.createElement("button");
    btn.type = "button";
    const busyNames = room.members.filter((id) => id !== myId && isBusyUser(allUsers[id])).map(nameOf);
    const armed = joinConfirm && joinConfirm.id === room.id && Date.now() < joinConfirm.until;
    if (mine) {
      btn.className = "btn-room-action btn-leave";
      btn.textContent = "Quitter";
      btn.addEventListener("click", () => leaveRoom());
    } else {
      btn.className = "btn-room-action btn-join" + (armed ? " btn-confirm" : "");
      btn.textContent = armed
        ? `${busyNames.join(", ")} ${busyNames.length > 1 ? "sont occupes" : "est occupe(e)"}, rejoindre quand meme ?`
        : "Rejoindre";
      btn.addEventListener("click", () => {
        if (busyNames.length && !armed) {
          joinConfirm = { id: room.id, until: Date.now() + 4000 };
          setTimeout(renderRooms, 4050);
          renderRooms();
          return;
        }
        joinConfirm = null;
        joinRoom(room);
      });
    }
    actions.appendChild(btn);
    head.appendChild(actions);
    card.appendChild(head);

    // Quelqu'un dedans : une scene s'ouvre sous le nom, avec les personnages
    // (prenom, statut, micro coupe et wizz sont sur eux)
    if (n) card.appendChild(sceneFor(room.id, room.members));
    roomsList.appendChild(card);
  });
  dropUnusedScenes(rooms);

  lobbyList.innerHTML = "";
  if (lobby.length) {
    const title = document.createElement("span");
    title.className = "lobby-title";
    title.textContent = "En ligne, hors salon :";
    lobbyList.appendChild(title);
    lobby.forEach((id) => lobbyList.appendChild(personChip(id)));
  }
}

newRoomForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = newRoomInput.value.trim().slice(0, 30);
  if (!name) { newRoomInput.focus(); return; }
  newRoomInput.value = "";
  const ref = db.ref("rooms").push();
  ref.set({
    name,
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    createdBy: myName,
    createdById: myId,
  }).catch((err) => {
    console.error("[HiSam] Creation du salon refusee :", err);
    setWarning(netWarningEl, "Impossible d'enregistrer le salon");
  });
  joinRoom({ id: ref.key, name });
});

function renameRoom(id, name) {
  db.ref(`rooms/${id}/name`).set(name).catch((err) => {
    console.error("[HiSam] Renommage refuse :", err);
    setWarning(netWarningEl, "Impossible de renommer le salon");
  });
}

function deleteRoom(id) {
  const busy = Object.values(allUsers).some((u) => roomIdOf(u) === id);
  if (busy) return; // quelqu'un vient d'entrer
  db.ref(`rooms/${id}`).remove().catch((err) => {
    console.error("[HiSam] Suppression refusee :", err);
    setWarning(netWarningEl, "Impossible de supprimer le salon");
  });
}

// Un salon a la fois : rejoindre quitte le precedent.
async function joinRoom(room) {
  if (!appEntered || !room) return;
  if (myRoom && myRoom.id === room.id) return;
  if (myRoom) leaveRoom({ quiet: true });
  myRoom = { id: room.id, name: room.name || "Salon" };
  if (!localStream) {
    try { localStream = silentStream(); } catch (err) { console.warn("[HiSam] Piste muette indisponible :", err); }
  }
  db.ref(`users/${myId}/room`).set(myRoom);
  saveLastRoom();
  enterScene();
  console.log(`[HiSam] Dans le salon ${myRoom.name}`);
  updateRoomUi();
  syncConnections();
}

function leaveRoom({ quiet } = {}) {
  if (!myRoom) return;
  leaveScene();
  console.log(`[HiSam] Sortie du salon ${myRoom.name}`);
  myRoom = null;
  db.ref(`users/${myId}/room`).remove();
  localStorage.removeItem(ROOM_KEY);
  closeAllCalls();
  if (!isMuted) muteMic();
  if (!quiet) {
    playSound("leave");
    updateRoomUi();
  }
}

// Ferme toutes les connexions audio/video et relache les partages
function closeAllCalls() {
  Object.keys(connections).forEach((id) => {
    connections[id].close();
    removeAudio(id);
  });
  connections = {};
  Object.values(pendingIncoming).forEach((p) => { clearTimeout(p.timer); p.call.close(); });
  pendingIncoming = {};
  lastInGroupAt = {};
  stopAllShares();
  removeAllRemoteVideos();
  audioContainer.innerHTML = "";
}

// Boutons de la barre du bas
function updateRoomUi() {
  leaveRoomBtn.style.display = myRoom ? "" : "none";
  [globalMuteBtn, cameraBtn, screenBtn].forEach((b) => { b.disabled = !myRoom; });
  renderRooms();
  updateGroupStatus();
}

// ---- Statut Disponible / Occupe ----
function setStatus(status) {
  myStatus = status === "busy" ? "busy" : "available";
  localStorage.setItem(STATUS_KEY, myStatus);
  if (appStarted) db.ref(`users/${myId}/status`).set(myStatus);
  updateStatusBtn();
  renderRooms();
}

function updateStatusBtn() {
  const busy = myStatus === "busy";
  statusBtn.classList.toggle("busy", busy);
  statusBtn.querySelector(".status-label").textContent = busy ? "Occupe" : "Disponible";
  statusBtn.title = busy
    ? "Occupe : ni son ni notification, pas de wizz. Clique pour redevenir disponible"
    : "Disponible. Clique pour passer en occupe";
}

statusBtn.addEventListener("click", () => {
  setStatus(myStatus === "busy" ? "available" : "busy");
});

// L'appli est reprise dans un autre onglet : on lache tout, sans toucher a
// Firebase (le noeud part avec teardownPresence).
function tearDownSession() {
  saveLastRoom(); // l'onglet qui reprend retourne dans ce salon
  myX = null;
  stopWalking();
  myRoom = null;
  appEntered = false;
  closeAllCalls();
  stopAllAnalysers();
  stopMic();
}

// ---- Wizz ----
// Comme sur MSN : l'ecran de l'autre tremble, un buzz, une notification. Le
// wizz est ecrit sous /users/{cible}/wizz, la cible le consomme (setupPresence)
// et tout le monde voit son personnage trembler (listenToUsers).
const WIZZ_COOLDOWN_MS = 10000;
const wizzSentAt = {};   // id -> dernier envoi
const wizzSeen = {};     // id -> dernier ts observe chez les autres
let lastWizzTs = null;   // dernier wizz recu

// Occupe = pas de wizz
function canWizz(id) {
  if (isBusyUser(allUsers[id])) return false;
  return Date.now() - (wizzSentAt[id] || 0) >= WIZZ_COOLDOWN_MS;
}

function sendWizz(id) {
  if (!appEntered || id === myId || !allUsers[id]) return;
  if (!canWizz(id)) return;
  wizzSentAt[id] = Date.now();
  db.ref(`users/${id}/wizz`).set({ from: myId, name: myName, ts: firebase.database.ServerValue.TIMESTAMP });
  shakeScreen(false);
  shakeCharacter(id);
  console.log(`[HiSam] Wizz envoye a ${allUsers[id].name}`);
  renderRooms();
  setTimeout(renderRooms, WIZZ_COOLDOWN_MS + 50);
}

function receiveWizz(wizz) {
  const name = (wizz && wizz.name) || "Quelqu'un";
  if (myStatus === "busy") {
    console.log(`[HiSam] Wizz de ${name} ignore : occupe`);
    return;
  }
  console.log(`[HiSam] Wizz recu de ${name}`);
  shakeScreen(true);
  notify(`${name} te wizz !`, "wizz");
  if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) { /* ignore */ } }
  shakeCharacter(myId);
}

function shakeScreen(strong) {
  const cls = strong ? "wizz" : "wizz-soft";
  mainScreen.classList.remove("wizz", "wizz-soft");
  void mainScreen.offsetWidth; // relance l'animation si elle tournait deja
  mainScreen.classList.add(cls);
  const done = () => { mainScreen.classList.remove(cls); mainScreen.removeEventListener("animationend", done); };
  mainScreen.addEventListener("animationend", done);
}

// ---- Scene des salons : un personnage par personne ----
// Des qu'il y a quelqu'un dans un salon, une bande s'ouvre sous son nom avec
// un personnage par membre. On ne bouge qu'a l'horizontale (fleches, ou clic
// dans la bande de son salon) et on ne traverse personne : a plusieurs, on se
// pousse dans l'espace qu'il y a. Ma place est publiee dans users/{id}/roomX
// (0..100) : l'onDisconnect de la presence l'efface avec le reste.
const SCENE_EDGE = 4;          // marge aux deux bouts (unites de 0..100)
const SCENE_GAP = 9;           // ecart minimal entre deux personnages
const WALK_SPEED = 32;         // unites par seconde
const REMOTE_MOVE_MS = 260;    // un pair dont la place vient de changer "marche" encore ce temps
const SPEAKING_LEVEL = 0.04;

const scenes = new Map();      // roomId -> { el, floor, chars: Map(id -> char) }
let myX = null;                // ma place dans mon salon, null hors salon
let myDir = 0;                 // indice dans World.DIRS : 0 face, 1 gauche, 2 droite
let myWalking = false;
let walkTarget = null;         // place visee apres un clic dans la bande
const keysHeld = { left: false, right: false };
let walkRaf = null;
let walkLast = 0;
let sceneTimer = null;
let lastXWrite = 0;
let xWriteTimer = null;

function clampX(x) {
  return Math.max(SCENE_EDGE, Math.min(100 - SCENE_EDGE, x));
}

// Place d'un pair : celle qu'il publie, sinon une place stable tiree de son id
function remoteX(id) {
  const x = allUsers[id]?.roomX;
  if (typeof x === "number" && Number.isFinite(x)) return clampX(x);
  return SCENE_EDGE + (World.fnv1a(String(id)) % (100 - 2 * SCENE_EDGE));
}

function othersInMyRoom() {
  return Object.keys(allUsers).filter(sameRoom).map(remoteX);
}

// En arrivant : la place la plus eloignee des autres, au plus pres du centre
function pickFreeX() {
  const others = othersInMyRoom();
  let best = 50, bestScore = -Infinity;
  for (let x = SCENE_EDGE; x <= 100 - SCENE_EDGE; x += 1) {
    const room = others.length ? Math.min(...others.map((o) => Math.abs(o - x))) : 100;
    const score = Math.min(room, SCENE_GAP * 2) * 10 - Math.abs(x - 50) / 10;
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return best;
}

function enterScene() {
  myX = pickFreeX();
  myDir = 0;
  publishRoomX(true);
}

function leaveScene() {
  myX = null;
  stopWalking();
  clearTimeout(xWriteTimer);
  xWriteTimer = null;
  db.ref(`users/${myId}/roomX`).remove();
}

function publishRoomX(force) {
  if (!myRoom || myX === null) return;
  const now = Date.now();
  const write = () => {
    xWriteTimer = null;
    if (!myRoom || myX === null) return;
    lastXWrite = Date.now();
    db.ref(`users/${myId}/roomX`).set(Math.round(myX * 10) / 10);
  };
  if (force || now - lastXWrite >= POSITION_MIN_INTERVAL_MS) {
    clearTimeout(xWriteTimer);
    write();
  } else if (!xWriteTimer) {
    // Ecriture trainante : la derniere place est toujours envoyee
    xWriteTimer = setTimeout(write, POSITION_MIN_INTERVAL_MS - (now - lastXWrite));
  }
}

function republishRoomX() {
  publishRoomX(true);
}

// Un pas de dx : on s'arrete contre le premier personnage rencontre. Deja
// colle a quelqu'un (deux arrivees au meme instant), on peut toujours s'eloigner.
function stepX(x, dx) {
  let next = clampX(x + dx);
  othersInMyRoom().forEach((o) => {
    if (dx > 0 && o > x) next = Math.min(next, Math.max(x, o - SCENE_GAP));
    if (dx < 0 && o < x) next = Math.max(next, Math.min(x, o + SCENE_GAP));
  });
  return next;
}

function walkDirection() {
  if (keysHeld.left !== keysHeld.right) return keysHeld.left ? -1 : 1;
  if (walkTarget !== null && Math.abs(walkTarget - myX) > 0.5) return walkTarget > myX ? 1 : -1;
  return 0;
}

function walkFrame(now) {
  walkRaf = null;
  if (!myRoom || myX === null) return;
  const dt = Math.min(0.1, (now - (walkLast || now)) / 1000);
  walkLast = now;
  const dir = walkDirection();
  if (dir === 0) {
    stopWalking();
    return;
  }
  let dx = dir * WALK_SPEED * dt;
  if (walkTarget !== null && !keysHeld.left && !keysHeld.right) {
    const left = walkTarget - myX;
    if (Math.abs(dx) > Math.abs(left)) dx = left;
  }
  const next = stepX(myX, dx);
  const blocked = Math.abs(next - myX) < 0.001 && dt > 0;
  myX = next;
  myDir = dir < 0 ? 1 : 2;
  myWalking = !blocked;
  if (blocked && walkTarget !== null && !keysHeld.left && !keysHeld.right) {
    stopWalking(); // quelqu'un est sur le chemin
    return;
  }
  publishRoomX(false);
  updateScenes();
  walkRaf = requestAnimationFrame(walkFrame);
}

function startWalking() {
  if (walkRaf || !myRoom || myX === null) return;
  walkLast = 0;
  walkRaf = requestAnimationFrame(walkFrame);
}

function stopWalking() {
  if (walkRaf) cancelAnimationFrame(walkRaf);
  walkRaf = null;
  walkTarget = null;
  keysHeld.left = keysHeld.right = false;
  myWalking = false;
  publishRoomX(true); // la place finale part tout de suite
  updateScenes();
}

function typingInField(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

document.addEventListener("keydown", (e) => {
  if (!myRoom || myX === null || typingInField(e)) return;
  const key = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
  if (!key) return;
  e.preventDefault();
  walkTarget = null;
  keysHeld[key] = true;
  startWalking();
});
document.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") keysHeld.left = false;
  if (e.key === "ArrowRight") keysHeld.right = false;
});
window.addEventListener("blur", () => { keysHeld.left = keysHeld.right = false; });

// La bande d'un salon : gardee d'un rendu a l'autre (renderRooms refait les
// cartes, la bande est juste deplacee) pour que les personnages glissent.
function sceneFor(roomId, members) {
  let scene = scenes.get(roomId);
  if (!scene) {
    const el = document.createElement("div");
    el.className = "room-scene opening";
    setTimeout(() => el.classList.remove("opening"), 400);
    const floor = document.createElement("div");
    floor.className = "room-scene-floor";
    el.appendChild(floor);
    scene = { el, floor, chars: new Map() };
    el.addEventListener("click", (e) => onSceneClick(roomId, e));
    scenes.set(roomId, scene);
  }
  scene.el.classList.toggle("mine", !!myRoom && myRoom.id === roomId);
  scene.el.title = myRoom && myRoom.id === roomId
    ? "Clique pour t'y deplacer, ou fleches gauche / droite"
    : "Clique pour rejoindre ce salon";
  const keep = new Set(members);
  scene.chars.forEach((c, id) => {
    if (!keep.has(id)) { c.el.remove(); scene.chars.delete(id); }
  });
  members.forEach((id) => {
    let c = scene.chars.get(id);
    if (!c) {
      c = makeCharacter(id);
      scene.chars.set(id, c);
      scene.el.appendChild(c.el);
    }
    refreshCharacterLabel(c, id);
  });
  updateScene(scene);
  ensureSceneTimer();
  return scene.el;
}

function dropUnusedScenes(rooms) {
  const used = new Set(rooms.filter((r) => r.members.length).map((r) => r.id));
  scenes.forEach((scene, id) => { if (!used.has(id)) scenes.delete(id); });
  if (!scenes.size) { clearInterval(sceneTimer); sceneTimer = null; }
}

function makeCharacter(id) {
  const el = document.createElement("div");
  el.className = "scene-char arriving" + (id === myId ? " me" : "");
  setTimeout(() => el.classList.remove("arriving"), 350);
  const label = document.createElement("span");
  label.className = "scene-name";
  el.appendChild(label);
  const canvas = document.createElement("canvas");
  canvas.className = "scene-sprite";
  const meta = World.characterMeta();
  canvas.width = meta.frameW;
  canvas.height = meta.frameH;
  el.appendChild(canvas);
  const c = { id, el, label, canvas, x: null, dir: 0, movingUntil: 0, drawn: "" };
  if (id !== myId) {
    const wizz = document.createElement("button");
    wizz.type = "button";
    wizz.className = "scene-wizz";
    wizz.textContent = "Wizz";
    wizz.addEventListener("click", (e) => { e.stopPropagation(); sendWizz(id); el.classList.remove("open"); });
    el.insertBefore(wizz, label);
    c.wizz = wizz;
  }
  return c;
}

// Prenom, statut et micro coupe au-dessus de la tete
function refreshCharacterLabel(c, id) {
  const me = id === myId;
  const u = me ? { status: myStatus, muted: isMuted, avatar: myAvatar } : allUsers[id] || {};
  c.label.textContent = me ? myName : nameOf(id);
  c.el.classList.toggle("busy", isBusyUser(u));
  c.el.classList.toggle("muted", u.muted === true);
  if (u.muted === true) {
    const mic = document.createElement("span");
    mic.className = "presence-mic";
    mic.innerHTML = MIC_OFF_ICON;
    c.label.appendChild(mic);
  }
  c.variant = Number.isInteger(u.avatar) ? u.avatar : World.avatarFor(id);
  if (c.wizz) {
    c.wizz.disabled = !canWizz(id);
    c.wizz.title = isBusyUser(u) ? "Occupe(e) : pas de wizz" : "Lui envoyer un wizz";
  }
}

function updateScenes() {
  scenes.forEach(updateScene);
}

function updateScene(scene) {
  const now = performance.now();
  scene.chars.forEach((c, id) => {
    const me = id === myId;
    const x = me ? (myX === null ? 50 : myX) : remoteX(id);
    if (!me && c.x !== null && Math.abs(x - c.x) > 0.05) {
      c.dir = x < c.x ? 1 : 2;
      c.movingUntil = now + REMOTE_MOVE_MS;
    }
    if (c.x !== x) c.el.style.left = `${x}%`;
    c.x = x;
    if (me) {
      c.dir = myWalking ? myDir : 0;
      c.movingUntil = myWalking ? now + REMOTE_MOVE_MS : 0;
    }
    drawCharacterFrame(c, now);
  });
}

// Marche : le cycle de world.js ; a l'arret, face a nous
function drawCharacterFrame(c, now) {
  const meta = World.characterMeta();
  const moving = now < c.movingUntil;
  const cycle = meta.walkCycle || [1, 0, 2, 0];
  const frame = moving ? cycle[Math.floor(now / (1000 / (meta.fps || 8))) % cycle.length] : 0;
  const dir = moving ? c.dir : 0;
  const key = `${c.variant}:${dir}:${frame}`;
  if (key === c.drawn) return;
  c.drawn = key;
  const ctx = c.canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
  World.drawFrame(ctx, c.variant, dir, frame, 0, 0);
}

// Pas de marche et anneau "il parle" : quelques images par seconde suffisent
function ensureSceneTimer() {
  if (sceneTimer) return;
  sceneTimer = setInterval(() => {
    const now = performance.now();
    scenes.forEach((scene, roomId) => {
      const mine = !!myRoom && myRoom.id === roomId;
      scene.chars.forEach((c, id) => {
        drawCharacterFrame(c, now);
        const talking = mine && (id === myId || connections[id]) && speakingLevel(id) > SPEAKING_LEVEL;
        c.el.classList.toggle("speaking", !!talking);
      });
    });
  }, 1000 / 12);
}

// Clic dans la bande : dans mon salon on y marche, sur quelqu'un on lui
// propose un wizz ; dans un autre salon, on le rejoint (comme le bouton).
function onSceneClick(roomId, e) {
  const charEl = e.target.closest(".scene-char");
  if (charEl && !charEl.classList.contains("me")) {
    const open = !charEl.classList.contains("open");
    document.querySelectorAll(".scene-char.open").forEach((el) => el.classList.remove("open"));
    charEl.classList.toggle("open", open);
    return;
  }
  if (!myRoom || myRoom.id !== roomId) {
    const btn = e.currentTarget.closest(".room-card")?.querySelector(".btn-join");
    if (btn) btn.click();
    return;
  }
  if (myX === null) return;
  const rect = scenes.get(roomId).el.getBoundingClientRect();
  walkTarget = clampX(((e.clientX - rect.left) / rect.width) * 100);
  startWalking();
}

function shakeCharacter(id) {
  scenes.forEach((scene) => {
    const c = scene.chars.get(id);
    if (!c) return;
    c.el.classList.remove("shake");
    void c.el.offsetWidth; // relance l'animation si elle tournait deja
    c.el.classList.add("shake");
    setTimeout(() => c.el.classList.remove("shake"), 900);
  });
}

function updateGroupStatus() {
  if (!appEntered) return;
  if (!myRoom) {
    groupStatusEl.textContent = "Dans le hall : rejoins un salon ou cree le tien";
    groupStatusEl.classList.remove("active");
    return;
  }
  const others = roomPeers().map(nameOf);
  groupStatusEl.textContent = (others.length
    ? `${myRoom.name} : avec ${others.join(", ")}` + (isMuted ? " (micro coupe, clique sur le micro pour parler)" : "")
    : `${myRoom.name} : seul(e) pour l'instant`) + " · fleches ← → pour bouger";
  groupStatusEl.classList.toggle("active", others.length > 0);
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
    if (!appEntered && !peerBlocked) enterApp();
    else if (myRoom) syncConnections();
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
      if (!appEntered) handlePeerIdTaken();
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
// Un autre onglet de CE navigateur a-t-il vraiment HiSam ouvert ? Il repond
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
//  - un autre onglet de ce navigateur a vraiment HiSam ouvert : on le dit et
//    on s'arrete la (deux avatars et deux micros pour une personne = larsen) ;
//  - personne ne repond : c'est un fantome. Onglet mis en sommeil par Safari,
//    Mac ferme couvercle baisse, page fermee sans que le broker le sache... il
//    garde l'identifiant jusqu'a une minute. Avant, la personne restait bloquee
//    a vie devant "deja ouvert dans un autre onglet" sans aucun onglet a fermer.
//    On reessaie, puis on change d'identifiant : il ne porte rien (prenom et
//    personnage sont stockes a part) et l'ancien noeud Firebase disparaitra
//    avec son propre onDisconnect.
async function handlePeerIdTaken() {
  peerBlocked = true; // pas d'entree tant que ce n'est pas tranche
  if (await otherTabAlive()) {
    console.log("[HiSam] Un autre onglet de ce navigateur a HiSam ouvert");
    showOverlay("<p><strong>HiSam est deja ouvert dans un autre onglet.</strong></p>" +
      "<p>Ferme l'autre onglet, ou continue ici : l'autre onglet sera deconnecte.</p>" +
      FORCE_TAB_BUTTON);
    return;
  }
  if (peerIdRetries < PEER_ID_RETRY_MS.length) {
    const delay = PEER_ID_RETRY_MS[peerIdRetries++];
    console.log(`[HiSam] Identifiant PeerJS pris sans onglet vivant : nouvel essai dans ${delay / 1000}s`);
    showOverlay("<p><strong>Connexion en cours...</strong></p><p>Une ancienne session HiSam est encore enregistree, quelques secondes de patience.</p>");
    setTimeout(() => { if (!appEntered) setupPeer(); }, delay);
    return;
  }
  console.warn("[HiSam] Identifiant PeerJS toujours pris : on en prend un neuf");
  peerIdRetries++;
  rotateIdentity();
  setupPeer();
  // Dernier filet : si meme le nouvel identifiant ne s'ouvre pas, on entre sans voix.
  setTimeout(() => {
    if (appEntered) return;
    console.warn("[HiSam] PeerJS toujours muet apres changement d'identifiant : entree sans voix");
    peerBlocked = false;
    hideOverlay();
    setWarning(peerWarningEl, "Serveur vocal injoignable : pas de voix pour l'instant");
    enterApp();
  }, PEER_OPEN_TIMEOUT_MS);
}

// ---- Reprendre HiSam dans cet onglet ----
// "Deja ouvert dans un autre onglet" est vecu comme un bug quand on ne retrouve
// pas l'autre onglet (fenetre perdue, onglet endormi...). Un clic suffit : on
// previent l'autre onglet, qui se retire, et on entre ici sous un identifiant
// neuf sans attendre que le broker libere l'ancien. L'identifiant ne porte rien
// (prenom et personnage sont stockes a part) ; on repart de l'ascenseur.
const FORCE_TAB_BUTTON = '<p><button type="button" id="force-tab-btn" class="overlay-btn">Utiliser cet onglet</button></p>';

alreadyOpenEl.addEventListener("click", (e) => {
  if (e.target.closest("#force-tab-btn")) takeOverTab();
});

function takeOverTab() {
  console.log("[HiSam] Reprise de HiSam dans cet onglet");
  if (tabChannel) tabChannel.postMessage("takeover");
  peerBlocked = false;
  peerIdRetries = 0;
  hideOverlay();
  if (peer && !peer.destroyed) peer.destroy();
  peer = null;
  rotateIdentity();
  setupPeer();
}

// Un autre onglet vient de reprendre HiSam : on se retire proprement.
function onTakenOver() {
  if (!appEntered) return; // rien a ceder
  console.log("[HiSam] HiSam a ete repris dans un autre onglet");
  tearDownSession();
  teardownPresence();
  if (peer && !peer.destroyed) peer.destroy();
  peer = null;
  peerBlocked = true;
  showOverlay("<p><strong>HiSam a ete repris dans un autre onglet.</strong></p>" +
    "<p>Continue la-bas, ou reprends ici.</p>" + FORCE_TAB_BUTTON);
}

function rotateIdentity() {
  teardownPresence();
  myId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxx-xxxx-xxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  localStorage.setItem("hisam-id", myId);
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
// "Entrer", a un instant ou il n'existe encore ni element <audio>
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
// A qui dois-je parler ? Aux gens de mon salon.
function sameRoom(id) {
  return !!myRoom && id !== myId && roomIdOf(allUsers[id]) === myRoom.id;
}

function roomPeers() {
  if (!myRoom) return [];
  return Object.keys(allUsers).filter(sameRoom);
}

function shouldTalkTo(id) {
  return sameRoom(id);
}

// Appel entrant : sa vue de /users peut etre en avance sur la mienne, d'ou
// holdIncoming quand il n'est pas (encore) dans mon salon.
function acceptsCallFrom(id) {
  return sameRoom(id);
}

// Nettoyage : petite grace temporelle (le temps que /users se mette a jour).
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
      console.log(`[HiSam] appel ${kind || "audio"} de ${call.peer} refuse : pas dans mon salon ou pas a portee`);
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
  if (!myRoom || !peer) return;
  // Inutile d'appeler pendant une coupure du serveur de signalisation :
  // peer.call() renvoie undefined et ne fait qu'empiler des erreurs.
  if (peer.disconnected) return;

  if (localStream) {
    roomPeers().forEach((id) => {
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
    if (!myRoom) return;
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
  if (!peer || !myRoom) return;

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
  if (!peer || peer.disconnected || !myRoom) return;
  VIDEO_KINDS.forEach((kind) => {
    const stream = videoStreams[kind];
    if (!stream) return;

    roomPeers().forEach((id) => {
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
// Occupe : ni son ni notification (le wizz d'un pod passe, voir receiveWizz)
function notify(message, type) {
  if (myStatus === "busy" && type !== "wizz") return;
  playSound(type);

  if (document.hidden) startFaviconBlink();

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("HiSam", { body: message, tag: "hisam-" + Date.now() });
  }
}

function playSound(type) {
  if (myStatus === "busy" && type !== "wizz") return;
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
    } else if (type === "wizz") {
      // Le buzz MSN : onde carree grave, hachee par un tremolo rapide
      const osc = ctx.createOscillator();
      const trem = ctx.createGain();
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(180, ctx.currentTime);
      osc.frequency.setValueAtTime(150, ctx.currentTime + 0.35);
      lfo.type = "square";
      lfo.frequency.setValueAtTime(25, ctx.currentTime);
      depth.gain.setValueAtTime(0.5, ctx.currentTime);
      trem.gain.setValueAtTime(0.5, ctx.currentTime);
      lfo.connect(depth);
      depth.connect(trem.gain);
      osc.connect(trem);
      trem.connect(gain);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
      osc.onended = () => { gain.disconnect(); trem.disconnect(); depth.disconnect(); };
      lfo.start(ctx.currentTime);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.7);
      lfo.stop(ctx.currentTime + 0.7);
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

// ---- Diagnostic en direct ----
// index.html?debug (ou localStorage hisam-debug=on) : un overlay qui dit, une
// fois par seconde, ce que WebRTC mesure vraiment. Fait pour un telephone, ou
// il n'y a pas de console : une capture d'ecran suffit pour comprendre si le
// son atteint l'encodeur (niveau source), part (paquets envoyes), arrive
// (paquets recus) et est joue (element audio pas en pause, temps qui avance).
const debugOverlayEl = document.getElementById("debug-overlay");
const debugPrev = {}; // id -> { sent, recv } du tour precedent, pour les debits
function debugEnabled() {
  try {
    return /[?&]debug/.test(location.search) || localStorage.getItem("hisam-debug") === "on";
  } catch (err) {
    return false;
  }
}
async function debugTick() {
  const lines = [];
  const ctx = audioContext;
  lines.push(`HiSam ${APP_VERSION} | ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 80)}`);
  lines.push(
    `secure=${window.isSecureContext} ctx=${ctx ? ctx.state + "@" + ctx.sampleRate : "absent"}` +
    ` worklet=${!!(ctx && ctx.audioWorklet)} visible=${!document.hidden}`
  );
  const mode = !localStream ? "aucun" : localStream === silentAudioStream ? "muette" : micProcessing ? "RNNoise" : "brut";
  const lt = localStream && localStream.getAudioTracks()[0];
  const rt = rawMicStream && rawMicStream.getAudioTracks()[0];
  lines.push(
    `micro: coupe=${isMuted} toggling=${micToggling} piste=${mode}` +
    (lt ? ` [${lt.readyState} enabled=${lt.enabled} muted=${lt.muted}]` : "") +
    (rt ? ` brut=[${rt.readyState} muted=${rt.muted} ${rt.getSettings().sampleRate || "?"}Hz]` : "") +
    ` niveau=${localAnalyser ? getAudioLevel(localAnalyser).toFixed(2) : "-"}`
  );
  const ids = Object.keys(connections);
  lines.push(`peer=${peer ? (peer.open ? "ouvert" : peer.disconnected ? "deconnecte" : "...") : "absent"} connexions=${ids.length} salon=${myRoom ? myRoom.name : "-"} pairs=${roomPeers().length}`);
  for (const id of ids) {
    const call = connections[id];
    const pc = call.peerConnection;
    const name = allUsers[id]?.name || id.slice(0, 8);
    let sent = 0, recv = 0, srcLevel = null, inLevel = null, concealed = 0, sender = "-";
    if (pc) {
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "outbound-rtp" && s.kind === "audio") sent = s.packetsSent || 0;
          if (s.type === "inbound-rtp" && s.kind === "audio") {
            recv = s.packetsReceived || 0;
            if (typeof s.audioLevel === "number") inLevel = s.audioLevel;
            concealed = s.concealedSamples || 0;
          }
          if (s.type === "media-source" && s.kind === "audio" && typeof s.audioLevel === "number") srcLevel = s.audioLevel;
        });
      } catch (err) { /* stats indisponibles */ }
      const snd = pc.getSenders().find((x) => x.track && x.track.kind === "audio");
      if (snd) sender = `${snd.track.readyState}${snd.track === lt ? "" : " (PAS la piste locale)"}`;
    }
    const prev = debugPrev[id] || { sent, recv };
    debugPrev[id] = { sent, recv };
    const a = document.getElementById(`audio-${id}`);
    const ra = remoteAnalysers[id];
    lines.push(
      `- ${name}: ${pc ? pc.connectionState + "/" + pc.iceConnectionState : "?"} ${call.open ? "ouvert" : "ferme"} ${call.__initiator === myId ? "(j'appelle)" : "(il appelle)"}\n` +
      `    envoi: piste=${sender} niveau_src=${srcLevel === null ? "-" : srcLevel.toFixed(2)} paquets=${sent} (+${sent - prev.sent}/s)\n` +
      `    recu: paquets=${recv} (+${recv - prev.recv}/s) niveau=${inLevel === null ? "-" : inLevel.toFixed(2)} masques=${concealed}` +
      ` analyseur=${ra ? getAudioLevel(ra.analyser).toFixed(2) : "-"}\n` +
      `    <audio>: ${a ? `${a.paused ? "PAUSE" : "joue"} t=${a.currentTime.toFixed(1)} ready=${a.readyState} vol=${a.volume}` : "absent"}`
    );
  }
  debugOverlayEl.textContent = lines.join("\n");
}
if (debugEnabled()) {
  debugOverlayEl.style.display = "";
  setInterval(() => { debugTick().catch((err) => { debugOverlayEl.textContent = "debug: " + err; }); }, 1000);
}

// ---- Personnage change depuis skin.html (autre onglet) ----
window.addEventListener("storage", (e) => {
  if (e.key !== "hisam-avatar" || !appStarted) return;
  myAvatar = currentAvatar();
  db.ref(`users/${myId}/avatar`).set(myAvatar);
  renderRooms();
});

// ---- Cleanup on close ----
window.addEventListener("beforeunload", () => {
  // Salon memorise pour y revenir apres un refresh
  saveLastRoom();

  Object.values(connections).forEach((call) => call.close());
  releaseMicStreams();

  db.ref(`users/${myId}`).remove();
});
