// ============================================================
// HiSam — Bureau virtuel audio (multi-salons)
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
//   /rooms/{roomId}  → { name, passwordHash, createdAt, createdBy, createdById }
//   /users/{userId}  → { name, online, activeRooms: { roomId: true }, ts }
//
// ============================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAnMeev1Im_FRV1j7AHE7ikUSEbisQ_Wpo",
  authDomain: "hisam-5b58f.firebaseapp.com",
  databaseURL: "https://hisam-5b58f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "hisam-5b58f",
};

// ---- Init Firebase ----
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
let peer = null;
let localStream = null;
let isMuted = false;
let connections = {}; // peerId → MediaConnection
let myActiveRooms = {}; // roomId → true (rooms this TAB joined)
let allRooms = {}; // roomId → { name, passwordHash, createdAt, createdBy }
let allUsers = {}; // userId → { name, online, activeRooms, ts }
let knownUsers = {}; // for notification diffing
let initialLoadDone = false;
let pendingJoinRoomId = null; // roomId waiting for password modal
const REJOIN_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// Check if I'm in a room (this tab or another tab via Firebase)
function isInRoom(roomId) {
  return !!myActiveRooms[roomId] || !!(allUsers[myId]?.activeRooms?.[roomId]);
}

// All rooms I'm in (this tab + other tabs from Firebase)
function getMyRoomIds() {
  const firebaseRooms = allUsers[myId]?.activeRooms || {};
  return [...new Set([...Object.keys(myActiveRooms), ...Object.keys(firebaseRooms)])];
}

// Audio level analysers
let audioContext = null;
let localAnalyser = null;
let localAnalyserSource = null;
let localAnalyserRaf = null;
let remoteAnalysers = {}; // peerId → { analyser, source, raf }
let remoteRafLoop = null;
let faviconBlinkInterval = null;

// Room passwords cached in localStorage
function getCachedPasswords() {
  try {
    return JSON.parse(localStorage.getItem("hisam-room-passwords") || "{}");
  } catch {
    return {};
  }
}

function setCachedPassword(roomId, hash) {
  const cache = getCachedPasswords();
  cache[roomId] = hash;
  localStorage.setItem("hisam-room-passwords", JSON.stringify(cache));
}

// ---- DOM ----
const loginScreen = document.getElementById("login-screen");
const mainScreen = document.getElementById("main-screen");
const usernameInput = document.getElementById("username-input");
const loginError = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");
const myNameEl = document.getElementById("my-name");
const onlineCount = document.getElementById("online-count");
const onlineTooltip = document.getElementById("online-tooltip");
const roomsList = document.getElementById("rooms-list");
const createRoomBtn = document.getElementById("create-room-btn");
const notifBtn = document.getElementById("notif-btn");
const audioContainer = document.getElementById("audio-container");

// Active bar
const activeBar = document.getElementById("active-bar");
const activeBarRooms = document.getElementById("active-bar-rooms");
const globalMuteBtn = document.getElementById("global-mute-btn");
const micIcon = document.getElementById("mic-icon");
const micOffIcon = document.getElementById("mic-off-icon");
const leaveAllBtn = document.getElementById("leave-all-btn");
const micSelect = document.getElementById("mic-select");

// Modal: Create Room
const modalCreate = document.getElementById("modal-create");
const createRoomNameInput = document.getElementById("create-room-name");
const createRoomPasswordInput = document.getElementById("create-room-password");
const createRoomError = document.getElementById("create-room-error");
const createRoomCancel = document.getElementById("create-room-cancel");
const createRoomConfirm = document.getElementById("create-room-confirm");

// Modal: Password
const modalPassword = document.getElementById("modal-password");
const passwordRoomName = document.getElementById("password-room-name");
const roomPasswordInput = document.getElementById("room-password-input");
const roomPasswordError = document.getElementById("room-password-error");
const passwordCancel = document.getElementById("password-cancel");
const passwordConfirm = document.getElementById("password-confirm");

// Modal: Settings
const modalSettings = document.getElementById("modal-settings");
const settingsRoomName = document.getElementById("settings-room-name");
const settingsNewPassword = document.getElementById("settings-new-password");
const settingsError = document.getElementById("settings-error");
const settingsSuccess = document.getElementById("settings-success");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave = document.getElementById("settings-save");

// ---- Hash helper (consistent across all browsers/contexts) ----
async function sha256(text) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---- Login ----
if (myName) {
  startApp();  // skip login screen
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
  startApp();
});

function startApp() {
  loginScreen.style.display = "none";
  mainScreen.style.display = "block";
  myNameEl.textContent = myName;
  updateNotifBtn();
  setupPresence();
  setupPeer();
  listenToRooms();
  listenToUsers();
  drawFavicon(false);
  handleDeepLink();
  handleAutoRejoin();
}

// ---- Deep link: #join=roomId ----
function handleDeepLink() {
  const hash = location.hash;
  if (!hash.startsWith("#join=")) return;
  const roomId = hash.slice(6);
  if (!roomId) return;
  // Clear hash so it doesn't re-trigger on reload
  history.replaceState(null, "", location.pathname + location.search);
  // Wait for rooms to load, then auto-join
  const unsubscribe = db.ref("rooms/" + roomId).on("value", (snap) => {
    if (snap.val()) {
      db.ref("rooms/" + roomId).off("value", unsubscribe);
      tryJoinRoom(roomId);
    }
  });
}

// ---- Auto-rejoin after refresh ----
async function handleAutoRejoin() {
  try {
    const saved = JSON.parse(localStorage.getItem("hisam-active-session") || "null");
    if (!saved) return;
    localStorage.removeItem("hisam-active-session");

    const age = Date.now() - saved.ts;
    if (age > REJOIN_TIMEOUT_MS || !saved.rooms || saved.rooms.length === 0) return;

    const snap = await db.ref("rooms").once("value");
    const rooms = snap.val() || {};
    const cached = getCachedPasswords();

    for (const roomId of saved.rooms) {
      if (rooms[roomId] && cached[roomId] && cached[roomId] === rooms[roomId].passwordHash) {
        try {
          await joinRoom(roomId);
        } catch (e) {
          console.warn("[HiSam] Auto-rejoin echoue pour", roomId, e);
        }
      }
    }
  } catch (e) {
    console.warn("[HiSam] Auto-rejoin error:", e);
    localStorage.removeItem("hisam-active-session");
  }
}

function saveSessionForRejoin() {
  const allMyRoomIds = getMyRoomIds();
  if (allMyRoomIds.length > 0) {
    localStorage.setItem("hisam-active-session", JSON.stringify({
      rooms: allMyRoomIds,
      ts: Date.now(),
    }));
  }
}

function clearSessionForRejoin() {
  localStorage.removeItem("hisam-active-session");
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
function setupPresence() {
  const userRef = db.ref(`users/${myId}`);
  const connectedRef = db.ref(".info/connected");

  connectedRef.on("value", (snap) => {
    if (snap.val() === true) {
      // Use update (not set) to preserve activeRooms from other tabs
      userRef.update({
        name: myName,
        online: true,
        ts: firebase.database.ServerValue.TIMESTAMP,
      });
      userRef.onDisconnect().remove();

      // Re-write this tab's rooms (may have been lost by onDisconnect)
      Object.keys(myActiveRooms).forEach((roomId) => {
        db.ref(`users/${myId}/activeRooms/${roomId}`).set(true);
      });
    }
  });

  // Re-register if our entry is deleted by another tab's onDisconnect
  let reRegistering = false;
  userRef.on("value", (snap) => {
    if (!snap.val() && myName && !reRegistering) {
      reRegistering = true;
      userRef.update({
        name: myName,
        online: true,
        ts: firebase.database.ServerValue.TIMESTAMP,
      }).then(() => {
        userRef.onDisconnect().remove();
        // Re-add rooms this tab has joined
        Object.keys(myActiveRooms).forEach((roomId) => {
          db.ref(`users/${myId}/activeRooms/${roomId}`).set(true);
        });
        reRegistering = false;
      });
    }
  });
}

// ---- Listen to rooms ----
function listenToRooms() {
  db.ref("rooms").on("value", (snap) => {
    allRooms = snap.val() || {};
    renderRooms();
  });
}

// ---- Listen to users ----
function listenToUsers() {
  db.ref("users").on("value", (snap) => {
    const users = snap.val() || {};

    if (initialLoadDone) {
      // Notifications: only when someone joins a room
      Object.entries(users).forEach(([id, user]) => {
        if (id === myId || !user.online) return;
        const prev = knownUsers[id];
        if (prev) {
          const prevRooms = prev.activeRooms || {};
          const currRooms = user.activeRooms || {};
          Object.keys(currRooms).forEach((roomId) => {
            if (!prevRooms[roomId]) {
              const roomName = allRooms[roomId]?.name || "un salon";
              notify(`${user.name} a rejoint ${roomName}`, "room");
            }
          });
        }
      });
    }

    knownUsers = {};
    Object.entries(users).forEach(([id, user]) => {
      knownUsers[id] = { ...user, activeRooms: { ...(user.activeRooms || {}) } };
    });

    if (!initialLoadDone) initialLoadDone = true;

    allUsers = users;
    renderRooms();
    updateOnlineCount();
    syncConnections();
  });
}

function updateOnlineCount() {
  const onlineUsers = Object.values(allUsers).filter((u) => u.online);
  onlineCount.textContent = `${onlineUsers.length} en ligne`;

  if (onlineUsers.length === 0) {
    onlineTooltip.innerHTML = '<div class="online-tooltip-empty">Personne en ligne</div>';
  } else {
    onlineTooltip.innerHTML = onlineUsers
      .map((u) => `<div class="online-tooltip-item">${u.name}</div>`)
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

// ---- Render rooms ----
function renderRooms() {
  const roomEntries = Object.entries(allRooms);

  if (roomEntries.length === 0) {
    roomsList.innerHTML = '<p class="empty-state">Aucun salon pour l\'instant...</p>';
    return;
  }

  // Sort: rooms I'm in first, then by name
  roomEntries.sort((a, b) => {
    const aActive = isInRoom(a[0]);
    const bActive = isInRoom(b[0]);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a[1].name.localeCompare(b[1].name);
  });

  roomsList.innerHTML = roomEntries
    .map(([roomId, room]) => {
      const members = getRoomMembers(roomId);
      const memberNames = members.map((u) => escapeHtml(u.name)).join(", ");
      const isActive = isInRoom(roomId);

      return `
      <div class="room-card ${isActive ? "room-active" : ""}">
        <div class="room-card-header">
          <div class="room-info">
            <span class="room-name">${escapeHtml(room.name)}</span>
            <span class="room-count">${members.length} personne${members.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="room-actions">
            <button class="btn-room-action ${isActive ? "btn-leave" : "btn-join"}" data-room-id="${roomId}">
              ${isActive ? "Quitter" : "Rejoindre"}
            </button>
            ${isActive && room.createdById === myId ? `<button class="btn-room-settings" data-room-id="${roomId}" title="Parametres">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            </button>` : ""}
          </div>
        </div>
        ${members.length > 0 ? `<div class="room-members">${memberNames}</div>` : ""}
      </div>`;
    })
    .join("");

  // Attach event listeners
  roomsList.querySelectorAll(".btn-room-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const roomId = btn.dataset.roomId;
      if (isInRoom(roomId)) {
        leaveRoom(roomId);
      } else {
        tryJoinRoom(roomId);
      }
    });
  });

  roomsList.querySelectorAll(".btn-room-settings").forEach((btn) => {
    btn.addEventListener("click", () => {
      openSettingsModal(btn.dataset.roomId);
    });
  });

  updateActiveBar();
}

function getRoomMembers(roomId) {
  return Object.entries(allUsers)
    .filter(([, u]) => u.online && u.activeRooms && u.activeRooms[roomId])
    .map(([id, u]) => ({ id, name: u.name }));
}

// ---- Create Room Modal ----
createRoomBtn.addEventListener("click", () => {
  createRoomNameInput.value = "";
  createRoomPasswordInput.value = "";
  createRoomError.textContent = "";
  modalCreate.style.display = "flex";
  createRoomNameInput.focus();
});

createRoomCancel.addEventListener("click", () => {
  modalCreate.style.display = "none";
});

modalCreate.addEventListener("click", (e) => {
  if (e.target === modalCreate) modalCreate.style.display = "none";
});

createRoomNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createRoomPasswordInput.focus();
});

createRoomPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createRoomConfirm.click();
});

createRoomConfirm.addEventListener("click", async () => {
  const name = createRoomNameInput.value.trim();
  const password = createRoomPasswordInput.value;

  if (!name) {
    createRoomError.textContent = "Entre un nom pour le salon";
    return;
  }
  if (!password) {
    createRoomError.textContent = "Entre un mot de passe";
    return;
  }

  createRoomConfirm.disabled = true;
  createRoomConfirm.textContent = "Creation...";

  try {
    const hash = await sha256(password);
    const roomRef = db.ref("rooms").push();
    await roomRef.set({
      name: name,
      passwordHash: hash,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      createdBy: myName,
      createdById: myId,
    });

    // Cache the password for this room
    setCachedPassword(roomRef.key, hash);

    modalCreate.style.display = "none";
  } catch (err) {
    createRoomError.textContent = "Erreur lors de la creation";
  }

  createRoomConfirm.disabled = false;
  createRoomConfirm.textContent = "Creer";
});

// ---- Join Room (with password check) ----
async function tryJoinRoom(roomId) {
  const room = allRooms[roomId];
  if (!room) return;

  const cached = getCachedPasswords();
  if (cached[roomId] && cached[roomId] === room.passwordHash) {
    // Password already verified
    await joinRoom(roomId);
  } else {
    // Need password
    pendingJoinRoomId = roomId;
    passwordRoomName.textContent = room.name;
    roomPasswordInput.value = "";
    roomPasswordError.textContent = "";
    modalPassword.style.display = "flex";
    roomPasswordInput.focus();
  }
}

// ---- Password Modal ----
passwordCancel.addEventListener("click", () => {
  modalPassword.style.display = "none";
  pendingJoinRoomId = null;
});

modalPassword.addEventListener("click", (e) => {
  if (e.target === modalPassword) {
    modalPassword.style.display = "none";
    pendingJoinRoomId = null;
  }
});

roomPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") passwordConfirm.click();
});

passwordConfirm.addEventListener("click", async () => {
  const password = roomPasswordInput.value;
  if (!password) {
    roomPasswordError.textContent = "Entre le mot de passe";
    return;
  }

  const roomId = pendingJoinRoomId;
  const room = allRooms[roomId];
  if (!room) {
    roomPasswordError.textContent = "Salon introuvable";
    return;
  }

  passwordConfirm.disabled = true;
  passwordConfirm.textContent = "Verification...";

  const hash = await sha256(password);
  if (hash !== room.passwordHash) {
    roomPasswordError.textContent = "Mauvais mot de passe";
    passwordConfirm.disabled = false;
    passwordConfirm.textContent = "Rejoindre";
    return;
  }

  // Cache the password
  setCachedPassword(roomId, hash);
  modalPassword.style.display = "none";
  pendingJoinRoomId = null;
  passwordConfirm.disabled = false;
  passwordConfirm.textContent = "Rejoindre";

  await joinRoom(roomId);
});

// ---- Settings Modal ----
let settingsRoomId = null;

function openSettingsModal(roomId) {
  settingsRoomId = roomId;
  const room = allRooms[roomId];
  if (!room) return;

  settingsRoomName.textContent = room.name;
  settingsNewPassword.value = "";
  settingsError.textContent = "";
  settingsSuccess.textContent = "";
  modalSettings.style.display = "flex";
  settingsNewPassword.focus();
}

settingsCancel.addEventListener("click", () => {
  modalSettings.style.display = "none";
  settingsRoomId = null;
});

modalSettings.addEventListener("click", (e) => {
  if (e.target === modalSettings) {
    modalSettings.style.display = "none";
    settingsRoomId = null;
  }
});

settingsNewPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") settingsSave.click();
});

settingsSave.addEventListener("click", async () => {
  const password = settingsNewPassword.value;
  if (!password) {
    settingsError.textContent = "Entre un nouveau mot de passe";
    return;
  }

  settingsSave.disabled = true;
  settingsSave.textContent = "Sauvegarde...";

  try {
    const hash = await sha256(password);
    await db.ref(`rooms/${settingsRoomId}/passwordHash`).set(hash);
    setCachedPassword(settingsRoomId, hash);
    settingsError.textContent = "";
    settingsSuccess.textContent = "Mot de passe mis a jour";
    settingsNewPassword.value = "";
  } catch (err) {
    settingsError.textContent = "Erreur lors de la sauvegarde";
    settingsSuccess.textContent = "";
  }

  settingsSave.disabled = false;
  settingsSave.textContent = "Sauvegarder";
});

// ---- Join / Leave Room ----
async function joinRoom(roomId) {
  // Start mic if not already streaming
  if (!localStream) {
    try {
      const savedMicId = localStorage.getItem("hisam-mic-id");
      const audioConstraints = savedMicId
        ? { deviceId: { exact: savedMicId } }
        : true;
      localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      if (isMuted) {
        localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      }
      startLocalAnalyser(localStream);
      populateMicSelect();
    } catch (err) {
      // If exact deviceId fails, fallback to default
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (isMuted) {
          localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
        }
        startLocalAnalyser(localStream);
        localStorage.removeItem("hisam-mic-id");
        populateMicSelect();
      } catch (err2) {
        alert("Impossible d'acceder au micro. Verifie les permissions du navigateur.");
        return;
      }
    }
  }

  myActiveRooms[roomId] = true;
  // Write only this room (don't overwrite other tabs' rooms)
  await db.ref(`users/${myId}/activeRooms/${roomId}`).set(true);

  renderRooms();
  connectToPeersInRoom(roomId);
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

async function switchMicrophone(deviceId) {
  try {
    const audioConstraints = deviceId
      ? { deviceId: { exact: deviceId } }
      : true;
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Stop old tracks
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }

    // Apply mute state
    if (isMuted) {
      newStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    }

    localStream = newStream;

    // Replace track in all active PeerJS connections
    const newTrack = localStream.getAudioTracks()[0];
    Object.values(connections).forEach((call) => {
      if (call.peerConnection) {
        const senders = call.peerConnection.getSenders();
        const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
        if (audioSender) {
          audioSender.replaceTrack(newTrack);
        }
      }
    });

    // Restart local analyser
    startLocalAnalyser(localStream);
  } catch (err) {
    console.warn("[HiSam] Erreur changement de micro, fallback defaut:", err);
    // Fallback to default mic
    localStorage.removeItem("hisam-mic-id");
    micSelect.value = "";
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
      if (isMuted) {
        fallbackStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      }
      localStream = fallbackStream;
      const newTrack = localStream.getAudioTracks()[0];
      Object.values(connections).forEach((call) => {
        if (call.peerConnection) {
          const senders = call.peerConnection.getSenders();
          const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
          if (audioSender) {
            audioSender.replaceTrack(newTrack);
          }
        }
      });
      startLocalAnalyser(localStream);
    } catch (err2) {
      console.error("[HiSam] Impossible de revenir au micro par defaut:", err2);
    }
  }
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

function leaveRoom(roomId) {
  delete myActiveRooms[roomId];
  // Remove only this room from Firebase
  db.ref(`users/${myId}/activeRooms/${roomId}`).remove();

  // Close connections with peers we no longer share any room with
  cleanupConnections();

  // If no more active rooms in this tab, stop mic
  if (Object.keys(myActiveRooms).length === 0) {
    stopMic();
  }

  // Clear auto-rejoin if no rooms left anywhere
  if (getMyRoomIds().length === 0) {
    clearSessionForRejoin();
  }

  renderRooms();
}

function leaveAllRooms() {
  // Remove all rooms (own + from other tabs)
  getMyRoomIds().forEach((roomId) => {
    db.ref(`users/${myId}/activeRooms/${roomId}`).remove();
  });
  myActiveRooms = {};
  clearSessionForRejoin();

  // Close all connections
  Object.values(connections).forEach((call) => call.close());
  connections = {};

  stopAllAnalysers();
  stopMic();
  audioContainer.innerHTML = "";
  renderRooms();
}

function stopMic() {
  stopLocalAnalyser();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  isMuted = false;
  updateMuteBtn();
}

// ---- Active Bar ----
function updateActiveBar() {
  const activeRoomIds = getMyRoomIds();

  if (activeRoomIds.length === 0) {
    activeBar.style.display = "none";
    return;
  }

  activeBar.style.display = "flex";

  activeBarRooms.innerHTML = activeRoomIds
    .map((roomId) => {
      const room = allRooms[roomId];
      const name = room ? room.name : "...";
      return `<span class="active-room-pill">${escapeHtml(name)}</span>`;
    })
    .join("");

  updateMuteBtn();
}

// ---- Mute ----
leaveAllBtn.addEventListener("click", leaveAllRooms);

globalMuteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => {
    t.enabled = !isMuted;
  });
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

// ---- PeerJS (audio WebRTC) ----
function setupPeer() {
  peer = new Peer(myId, { debug: 0 });

  peer.on("open", () => {
    console.log("[HiSam] PeerJS connecte:", peer.id);
  });

  peer.on("call", (call) => {
    // Accept call if we share at least one room with the caller
    const metadata = call.metadata || {};
    const callerRoomId = metadata.roomId;

    // Check if we're in this room
    if (callerRoomId && myActiveRooms[callerRoomId] && localStream) {
      call.answer(localStream);
      setupCall(call);
    } else if (localStream && sharesAnyRoom(call.peer)) {
      // Fallback: accept if we share any room
      call.answer(localStream);
      setupCall(call);
    }
  });

  peer.on("error", (err) => {
    console.warn("[HiSam] PeerJS error:", err.type, err.message);
    if (err.type === "unavailable-id") {
      // Another tab already has this PeerJS ID — don't retry endlessly
      console.log("[HiSam] Audio actif dans un autre onglet");
    } else if (err.type === "network") {
      setTimeout(() => peer.reconnect(), 3000);
    }
  });

  peer.on("disconnected", () => {
    console.log("[HiSam] PeerJS deconnecte, reconnexion...");
    peer.reconnect();
  });
}

function setupCall(call) {
  // Deduplicate: if we already have a connection to this peer, close the old one
  if (connections[call.peer] && connections[call.peer] !== call) {
    connections[call.peer].close();
  }

  call.on("stream", (remoteStream) => {
    addAudio(call.peer, remoteStream);
  });
  call.on("close", () => {
    removeAudio(call.peer);
    delete connections[call.peer];
  });
  call.on("error", () => {
    removeAudio(call.peer);
    delete connections[call.peer];
  });
  connections[call.peer] = call;
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

  // Start remote analyser for this peer
  startRemoteAnalyser(peerId, stream);
}

// Global one-shot listener: resume any paused audio on first user gesture (mobile autoplay workaround)
let autoplayUnlocked = false;
function unlockAutoplay() {
  if (autoplayUnlocked) return;
  autoplayUnlocked = true;
  document.querySelectorAll("#audio-container audio").forEach((a) => {
    if (a.paused && a.srcObject) a.play().catch(() => {});
  });
  // Also resume AudioContext if suspended
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
  document.removeEventListener("touchstart", unlockAutoplay);
  document.removeEventListener("click", unlockAutoplay);
}
document.addEventListener("touchstart", unlockAutoplay, { once: true });
document.addEventListener("click", unlockAutoplay, { once: true });

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
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function getAudioLevel(analyser) {
  const data = new Uint8Array(analyser.frequencyBinCount);
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
function sharesAnyRoom(peerId) {
  const peerUser = allUsers[peerId];
  if (!peerUser || !peerUser.activeRooms) return false;

  return Object.keys(myActiveRooms).some(
    (roomId) => peerUser.activeRooms[roomId]
  );
}

function connectToPeersInRoom(roomId) {
  if (!localStream || !peer) return;

  Object.entries(allUsers).forEach(([id, user]) => {
    if (id === myId || !user.online) return;
    if (!user.activeRooms || !user.activeRooms[roomId]) return;

    // Already connected to this peer
    if (connections[id] && connections[id].open) return;

    const call = peer.call(id, localStream, { metadata: { roomId } });
    if (call) setupCall(call);
  });
}

function syncConnections() {
  if (!localStream || !peer || Object.keys(myActiveRooms).length === 0) return;

  // Connect to peers we share a room with but aren't connected to
  Object.entries(allUsers).forEach(([id, user]) => {
    if (id === myId || !user.online || !user.activeRooms) return;

    const shared = Object.keys(myActiveRooms).some(
      (roomId) => user.activeRooms[roomId]
    );

    if (shared && (!connections[id] || !connections[id].open)) {
      const sharedRoomId = Object.keys(myActiveRooms).find(
        (roomId) => user.activeRooms[roomId]
      );
      const call = peer.call(id, localStream, { metadata: { roomId: sharedRoomId } });
      if (call) setupCall(call);
    }
  });
}

function cleanupConnections() {
  Object.keys(connections).forEach((peerId) => {
    if (!sharesAnyRoom(peerId)) {
      connections[peerId].close();
      removeAudio(peerId);
      delete connections[peerId];
    }
  });
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
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } else if (type === "leave") {
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
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
  // Save session so we can auto-rejoin on refresh
  saveSessionForRejoin();

  // Remove only rooms THIS tab joined (not inherited from other tabs)
  Object.keys(myActiveRooms).forEach((roomId) => {
    db.ref(`users/${myId}/activeRooms/${roomId}`).remove();
  });

  // Close audio connections
  Object.values(connections).forEach((call) => call.close());
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  // Check if other tabs still have rooms (rooms in Firebase not owned by this tab)
  const firebaseRooms = allUsers[myId]?.activeRooms || {};
  const otherTabsHaveRooms = Object.keys(firebaseRooms).some((r) => !myActiveRooms[r]);

  if (otherTabsHaveRooms) {
    // Other tabs still active — cancel this tab's onDisconnect
    db.ref(`users/${myId}`).onDisconnect().cancel();
  } else {
    // No other tabs with rooms — remove user entirely
    db.ref(`users/${myId}`).remove();
  }
});
