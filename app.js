import { firebaseConfig, cloudinaryConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile,
  initializeAuth, inMemoryPersistence, browserSessionPersistence, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, updateDoc, collection, addDoc, query, orderBy,
  onSnapshot, serverTimestamp, where, getDocs, deleteDoc, increment, limit, arrayUnion, arrayRemove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ===================== helpers ===================== */
const APP_VERSION = "v21";
// koi element na mile (purani index.html) to poori app crash na ho, bas wo ek cheez kaam na kare
const $ = (s) => document.querySelector(s) || document.createElement("div");

// koi bhi JS error chup na rahe: screen par dikhao taake pata chale kya toota
let errShown = 0;
function showCrash(msg, where) {
  if (errShown++ > 2) return;
  const clean = String(msg || "").slice(0, 140);
  setTimeout(() => toast(`⚠️ App error: ${clean}${where ? " (" + where + ")" : ""}. Please send a screenshot of this.`), 300);
}
window.addEventListener("error", (e) => {
  if (e.message && !/ResizeObserver|Script error/i.test(e.message)) showCrash(e.message, (e.filename || "").split("/").pop() + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  const m = e.reason?.message || String(e.reason || "");
  if (m && !/auth\/|network|offline|permission|quota|cancel/i.test(m)) showCrash(m);
});

// index.html / app.js alag version ki hon to saaf warning
window.addEventListener("load", () => {
  const v = document.querySelector('meta[name="gs-version"]')?.content;
  if (v !== APP_VERSION) {
    setTimeout(() => toast(`⚠️ Files are from different versions (index.html: ${v || "old"}, app.js: ${APP_VERSION}). Replace all files from the zip (app.js, index.html, style.css) together and deploy again.`), 1500);
  }
});
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

const firebaseReady =
  firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");
const cloudinaryReady =
  cloudinaryConfig.cloudName && !cloudinaryConfig.cloudName.startsWith("YOUR_") &&
  cloudinaryConfig.uploadPreset && !cloudinaryConfig.uploadPreset.startsWith("YOUR_");

window.gsReady = true;                    // ui.js ko batata hai ke app.js load ho gayi
window.gsConfigMissing = !firebaseReady;

// Page kholne par login yaad rakha jaye ya nahi (sirf yeh ek lafz badalna hai):
//   "never"   -> har baar page khulne par pehle landing page (Sign up / Login) dikhega  (hackathon demo ke liye best)
//   "session" -> refresh par login rahega, lekin tab band karke dobara kholne par landing page aayega
//   "always"  -> hamesha login rahega (real apps ki tarah)
const LOGIN_MEMORY = "never";

let auth, db;
if (firebaseReady) {
  const fbApp = initializeApp(firebaseConfig);
  if (LOGIN_MEMORY === "never") auth = initializeAuth(fbApp, { persistence: inMemoryPersistence });
  else if (LOGIN_MEMORY === "session") auth = initializeAuth(fbApp, { persistence: browserSessionPersistence });
  else auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}

// invite link / QR se aaya hua dost: signup ya login ke baad bhi yaad rehta hai
const roomDeep = (() => {
  let r = new URLSearchParams(location.search).get("room");
  try { if (r) localStorage.setItem("gs_room_deep", r); else r = localStorage.getItem("gs_room_deep"); } catch (_) { /* ignore */ }
  return r;
})();
const statusDeep = (() => {
  let s = new URLSearchParams(location.search).get("status");
  try { if (s) localStorage.setItem("gs_status_deep", s); else s = localStorage.getItem("gs_status_deep"); } catch (_) { /* ignore */ }
  return s;
})();
const deepUid = (() => {
  let u = new URLSearchParams(location.search).get("u");
  try {
    if (u) localStorage.setItem("gs_deep", u); else u = localStorage.getItem("gs_deep");
  } catch (_) { /* ignore */ }
  return u;
})();

const state = {
  me: null,            // { uid, name, photoURL, phone }
  users: [],
  active: null,        // selected peer
  unsubUsers: null,
  unsubMsgs: null,
  unsubChat: null,
  unsubContacts: null,
  typingTimer: null,
  typingShown: false,
  heartbeat: null,
  authMode: "login",
  busyAuth: false,
  avatarFile: null,
  contacts: [],        // saved contacts [{id, name, phone, uid}]
  localContacts: [], cloudContacts: [], syncTried: new Set(), cloudFailShown: false,
  prefs: { fav: [], arch: [], lock: [], pin: "", cleared: {}, deleted: {}, sound: true }, filter: "all", unlocked: new Set(),
  groups: [], groupUsers: [], roomUsers: [], groupsLoaded: false, groupWarned: false, unsubGroups: null,
  statuses: [], unsubStatus: null, aiMsgs: [], deepDone: false,
  tab: "all",          // "all" | "contacts"
  animateNext: true,   // list ko sirf zaroorat par animate karte hain
  seenIds: null,       // messages jo pehle render ho chuke hain
  stripKey: "",        // online strip ka cache key
  justLoggedOut: false,
  chatMeta: {},        // har dost ki chat ka summary { lastText, lastFrom, lastAt, unread }
  metaUnsubs: {},      // har dost ke chat summary ke listeners
  iAmTyping: false,
};

const chatIdOf = (a, b) => [a, b].sort().join("_");

// Phone number ko ek standard format (+923001234567) mein badalta hai
function normalizePhone(raw) {
  let s = String(raw).replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (/^0\d{10}$/.test(s)) s = "+92" + s.slice(1);   // Pakistan local format 03xx...
  if (!s.startsWith("+")) s = "+" + s;
  return /^\d{8,15}$/.test(s.slice(1)) ? s : "";
}

// numbers ko format se qata nazar sirf aakhri 10 ginti se match karo (0300.., +92300.., 300.. sab barabar)
function samePhone(a, b) {
  const x = String(a || "").replace(/\D/g, ""), y = String(b || "").replace(/\D/g, "");
  if (x.length < 7 || y.length < 7) return false;
  return x.slice(-10) === y.slice(-10);
}

// number ya email se Glide-Chat user dhoondo
function findPeer(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.includes("@")) return state.users.find((u) => (u.email || "").toLowerCase() === s.toLowerCase()) || null;
  const p = normalizePhone(s);
  return p ? state.users.find((u) => samePhone(u.phone, p)) || null : null;
}

function friendlyError(err) {
  const code = err?.code || "";
  const map = {
    "auth/email-already-in-use": "This email is already registered. Try logging in.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-credential": "Incorrect email or password. If you forgot it, tap 'Forgot password?'.",
    "auth/missing-email": "Enter your email first.",
    "auth/user-not-found": "No account found for this email. Please sign up first.",
    "auth/wrong-password": "Incorrect password.",
    "auth/missing-password": "Enter your password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Check your internet connection.",
    "auth/operation-not-allowed": "Enable Email/Password in Firebase Console > Authentication.",
    "permission-denied": "Permission denied because of Firestore rules (see README).",
  };
  return map[code] || err?.message || "Something went wrong. Please try again.";
}

function colorFor(str = "") {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `linear-gradient(135deg,hsl(${h},80%,60%),hsl(${(h + 50) % 360},80%,55%))`;
}

function avatarEl(user, small = false, withDot = false) {
  const d = document.createElement("div");
  d.className = "av" + (small ? " sm" : "");
  if (user.isAI || user.isGroup) {
    d.style.background = user.isAI ? "linear-gradient(135deg,#7c5cff,#2dd4bf)" : "linear-gradient(135deg,#ff6b6b,#ffb84d)";
    d.textContent = user.isAI ? "🤖" : user.isRoom ? "🌐" : (user.type === "community" ? "📢" : "👥");
  } else if (user.photoURL) {
    d.style.backgroundImage = `url("${user.photoURL}")`;
  } else {
    d.style.background = colorFor(user.name);
    d.textContent = (user.name || "?").trim().charAt(0).toUpperCase();
  }
  if (withDot && isOnline(user)) {
    const dot = document.createElement("span");
    dot.className = "dot";
    d.appendChild(dot);
  }
  return d;
}

function isOnline(u) {
  if (!u.online) return false;
  const ms = u.lastSeen?.toMillis ? u.lastSeen.toMillis() : 0;
  return Date.now() - ms < 75000;
}

function lastSeenText(u) {
  if (isOnline(u)) return "online";
  const d = u.lastSeen?.toDate ? u.lastSeen.toDate() : null;
  if (!d) return "offline";
  const same = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return same ? `last seen today ${time}` : `last seen ${d.toLocaleDateString()}`;
}

async function uploadToCloudinary(file, kind = "image") {
  if (!cloudinaryReady) throw new Error("Cloudinary is not set in config.js.");
  const fd = new FormData();
  if (file instanceof Blob && !file.name) fd.append("file", file, "voice." + (file.type.includes("mp4") ? "m4a" : "webm"));
  else fd.append("file", file);
  fd.append("upload_preset", cloudinaryConfig.uploadPreset);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/${kind}/upload`,
    { method: "POST", body: fd }
  );
  const data = await res.json();
  if (!res.ok || !data.secure_url) {
    throw new Error(data?.error?.message || "Upload failed.");
  }
  return data.secure_url;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function shrinkImage(file, max = 1280, q = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("bad image")); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", q));
  } finally { URL.revokeObjectURL(url); }
}
/* Uploads to Cloudinary; if that fails (wrong preset, offline, timeout...) the file is stored
   inside the message itself so photos and voice still work. */
async function uploadMedia(file, kind = "image") {
  if (cloudinaryReady) {
    try { return await withTimeout(uploadToCloudinary(file, kind === "audio" ? "video" : "image"), 20000); }
    catch (err) { console.warn("Cloudinary upload failed, using inline fallback:", err.message); }
  }
  let blob = file;
  if (kind === "image") {
    for (const [m, q] of [[1000, 0.7], [800, 0.6], [600, 0.5]]) { blob = await shrinkImage(file, m, q); if (blob.size <= 650 * 1024) break; }
  }
  if (blob.size > 650 * 1024) throw new Error(kind === "audio" ? "Voice message is too long. Please record a shorter one (under about 1 minute)." : "This image is too large to send.");
  return blobToDataUrl(blob);
}

/* ===================== landing + modal ===================== */
function openModal(mode) {
  if (!firebaseReady) {
    toast("First paste your Firebase keys into config.js 🔧");
    return;
  }
  setMode(mode);
  show($("#authModal"));
}
function closeModal() {
  hide($("#authModal"));
  $("#authError").textContent = "";
}
function setMode(mode) {
  state.authMode = mode;
  $("#tabLogin").classList.toggle("active", mode === "login");
  $("#tabSignup").classList.toggle("active", mode === "signup");
  $("#signupOnly").classList.toggle("hidden", mode !== "signup");
  $("#authSubmit").textContent = mode === "signup" ? "Create account" : "Login";
  $("#passInput").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#authError").textContent = "";
}

["#openLogin", "#heroLogin"].forEach((s) => $(s).addEventListener("click", () => openModal("login")));
["#openSignup", "#heroSignup", "#bottomSignup"].forEach((s) => $(s).addEventListener("click", () => openModal("signup")));
$("#closeModal").addEventListener("click", closeModal);
$("#authModal").addEventListener("click", (e) => { if (e.target.id === "authModal") closeModal(); });
$("#tabLogin").addEventListener("click", () => setMode("login"));
$("#tabSignup").addEventListener("click", () => setMode("signup"));

$("#avatarInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.avatarFile = f;
  const prev = $("#avatarPreview");
  prev.textContent = "";
  prev.style.backgroundImage = `url("${URL.createObjectURL(f)}")`;
});

/* ===================== auth ===================== */
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = $("#authError");
  errBox.classList.remove("ok");
  errBox.textContent = "";

  if (!firebaseReady) {
    errBox.textContent = "⚠️ First paste your Firebase keys into config.js.";
    return;
  }
  state.authMode = $("#authForm").getAttribute("data-mode") || state.authMode;

  const email = $("#emailInput").value.trim();
  const pass = $("#passInput").value;
  const name = $("#nameInput").value.trim();
  const rawPhone = "";
  const phone = rawPhone ? normalizePhone(rawPhone) : "";

  if (state.authMode === "signup" && name.length < 2) { errBox.textContent = "Enter your name (at least 2 characters)."; return; }
  if (state.authMode === "signup" && rawPhone && !phone) { errBox.textContent = "Phone number is not valid. Example: 03001234567 or +923001234567"; return; }
  if (!email) { errBox.textContent = "Enter your email."; return; }
  if (pass.length < 6) { errBox.textContent = "Password must be at least 6 characters."; return; }

  const btn = $("#authSubmit");
  btn.disabled = true;
  btn.textContent = "Please wait…";
  state.busyAuth = true;

  try {
    if (state.authMode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);

      let photoURL = "";
      if (state.avatarFile) {
        try { photoURL = await uploadToCloudinary(state.avatarFile); }
        catch (upErr) { toast("Profile photo could not be uploaded. Please try again later."); }
      }

      await updateProfile(cred.user, { displayName: name, photoURL: photoURL || null });
      // Firestore write ka intezar nahi karte (agar database na bana ho to button atak jata hai)
      setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid,
        name,
        email,
        phone,
        photoURL,
        online: true,
        lastSeen: serverTimestamp(),
        createdAt: serverTimestamp(),
      }).catch((e2) => toast(friendlyError(e2)));
      toast("Account created! Welcome 🎉");
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }

    state.busyAuth = false;
    closeModal();
    $("#authForm").reset();
    state.avatarFile = null;
    $("#avatarPreview").style.backgroundImage = "";
    $("#avatarPreview").textContent = "📷";
    await enterApp(auth.currentUser);
  } catch (err) {
    state.busyAuth = false;
    errBox.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = state.authMode === "signup" ? "Create account" : "Login";
  }
});

/* ----- password reset ----- */
$("#forgotBtn").addEventListener("click", async () => {
  const errBox = $("#authError");
  errBox.classList.remove("ok");
  errBox.textContent = "";
  if (!firebaseReady) {
    errBox.textContent = "⚠️ First paste your Firebase keys into config.js.";
    return;
  }
  const email = $("#emailInput").value.trim();
  if (!email) {
    errBox.textContent = "Enter your email above first, then tap 'Forgot password?'.";
    return;
  }
  const btn = $("#forgotBtn");
  btn.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    errBox.classList.add("ok");
    errBox.textContent = "✅ Reset link sent. Check your email (Inbox and Spam), set a new password from the link, then log in.";
  } catch (err) {
    errBox.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
  }
});

if (firebaseReady) {
  onAuthStateChanged(auth, async (user) => {
    if (state.busyAuth) return;          // signup/login khud handle karega
    if (user) await enterApp(user);
    else leaveApp();
  });
}

/* ----- logout ----- */
$("#logoutBtn").addEventListener("click", async () => {
  if (!confirm("Do you want to log out?")) return;
  state.justLoggedOut = true;
  // Internet na ho to presence update atak sakta hai, is liye zyada intezar nahi karte
  await Promise.race([setPresence(false), new Promise((r) => setTimeout(r, 800))]);
  try { cancelRecordingIfAny(); await signOut(auth); }
  catch (err) { state.justLoggedOut = false; toast(friendlyError(err)); }
});

/* ===================== presence ===================== */
async function setPresence(online) {
  if (!state.me) return;
  try {
    await updateDoc(doc(db, "users", state.me.uid), { online, lastSeen: serverTimestamp() });
  } catch (_) { /* ignore */ }
}

document.addEventListener("visibilitychange", () => {
  if (!state.me) return;
  setPresence(document.visibilityState === "visible");
  if (document.visibilityState === "visible" && state.active) clearUnread(state.active.uid);
});
window.addEventListener("pagehide", () => { if (state.me) setPresence(false); });

/* ===================== enter / leave app ===================== */
async function enterApp(user) {
  if (!user || (state.me && state.me.uid === user.uid)) return;
  state.me = { uid: user.uid, name: user.displayName || user.email.split("@")[0], photoURL: user.photoURL || "", phone: "" };

  // agar user doc missing ho (purana account) to bana do
  setDoc(doc(db, "users", user.uid), {
    uid: user.uid, name: state.me.name, email: user.email,
    photoURL: state.me.photoURL, online: true, lastSeen: serverTimestamp(),
  }, { merge: true }).catch((err) => toast(friendlyError(err)));

  hide($("#landing"));
  show($("#app"));
  showSplash(state.me.name);

  $("#meName").textContent = state.me.name;
  const meAv = $("#meAvatar");
  meAv.innerHTML = "";
  meAv.appendChild(avatarEl(state.me));

  state.animateNext = true;
  state.stripKey = "";
  setTab("all");
  subscribeUsers();
  // har cheez alag try/catch mein: ek toote to baqi chalte rahein
  [loadPrefs, loadAi, loadRooms, subscribeContacts, subscribeGroups, subscribeStatuses].forEach((fn) => {
    try { fn(); } catch (err) { showCrash(err.message, fn.name); }
  });
  state.heartbeat = setInterval(() => { if (document.visibilityState === "visible") setPresence(true); }, 30000);
  buildEmojiPanel();
  if (roomDeep) {            // ?room=code wale link se aaye hon to seedha us room mein
    try { localStorage.removeItem("gs_room_deep"); history.replaceState(null, "", location.pathname); } catch (_) { /* ignore */ }
    setTimeout(() => joinRoom(roomDeep), 600);
  } else if (!state.roomUsers.length) {      // pehli baar: apna room khud bana do
    setTimeout(() => {
      if (state.roomUsers.length || !state.me) return;
      const slug = (state.me.name || "room").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "room";
      joinRoom(slug + "-" + Math.floor(1000 + Math.random() * 9000));
      setTimeout(() => toast("🔗 This is your room. Tap '🔗 Send link' above and send the link to a friend; they will log in and join right here."), 1500);
    }, 900);
  }
}

function leaveApp() {
  state.unsubUsers?.(); state.unsubMsgs?.(); state.unsubChat?.(); state.unsubContacts?.(); state.unsubGroups?.(); state.unsubStatus?.(); Object.values(state.roomUnsubs || {}).forEach((f) => f()); state.roomUnsubs = {};
  Object.values(state.metaUnsubs).forEach((f) => f());
  state.metaUnsubs = {};
  document.title = "Glide-Chat — Real-time Chat";
  clearInterval(state.heartbeat);
  Object.assign(state, {
    me: null, askedPhone: false, groupUsers: [], roomUsers: [], statuses: [], aiMsgs: [], deepDone: false, groupsLoaded: false, groupWarned: false, unsubGroups: null, unsubStatus: null, users: [], contacts: [], localContacts: [], cloudContacts: [], syncTried: new Set(), cloudFailShown: false, filter: "all", unlocked: new Set(), tab: "all", active: null, seenIds: null, stripKey: "",
    chatMeta: {}, iAmTyping: false,
    unsubUsers: null, unsubMsgs: null, unsubChat: null, unsubContacts: null,
  });
  $("#userList").innerHTML = "";
  $("#onlineRow").innerHTML = "";
  $("#messages").innerHTML = "";
  hide($("#onlineStrip"));
  hide($("#chatView")); show($("#emptyState"));
  hide($("#emojiPanel"));
  hide($("#inviteModal")); hide($("#contactModal"));
  $("#app").classList.remove("chat-open");
  hide($("#app")); show($("#landing"));
  window.scrollTo(0, 0);

  // Logout ke baad landing page (Login / Sign up buttons ke saath) dikhao
  if (state.justLoggedOut) {
    state.justLoggedOut = false;
    closeModal();
    $("#authForm").reset();
    toast("You are logged out 👋 Log in or sign up again");
    ["#openLogin", "#openSignup"].forEach((s) => {
      const b = $(s);
      b.classList.remove("pulse-cta");
      void b.offsetWidth;
      b.classList.add("pulse-cta");
      setTimeout(() => b.classList.remove("pulse-cta"), 5000);
    });
  }
}

/* ===================== users list ===================== */
function subscribeUsers() {
  state.unsubUsers?.();
  state.unsubUsers = onSnapshot(
    collection(db, "users"),
    (snap) => {
      const all = snap.docs.map((d) => d.data());
      updateMyPhone(all.find((u) => u.uid === state.me.uid));
      state.users = all.filter((u) => u.uid !== state.me.uid)
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      syncChatListeners();
      renderUsers();
      if (deepUid && !state.deepDone) {
        const t = state.users.find((u) => u.uid === deepUid);
        if (t) {
          state.deepDone = true;
          try { history.replaceState(null, "", location.pathname); localStorage.removeItem("gs_deep"); } catch (_) { /* ignore */ }
          // invite dene wale ko seedha contacts mein save karo aur chat kholo
          toast(`👋 ${t.name} invited you, opening the chat.`);
          setTab("all");
          openChat(t);
        } else if (deepUid === state.me.uid) {
          state.deepDone = true;
          try { localStorage.removeItem("gs_deep"); } catch (_) { /* ignore */ }
        }
      }
      if (state.active) {
        const fresh = state.users.find((u) => u.uid === state.active.uid);
        if (fresh) { state.active = fresh; updatePeerHeader(); }
      }
    },
    (err) => toast(friendlyError(err))
  );
}

/* ----- har dost ki chat par nazar: last message, unread badge, naye message ka alert ----- */
let audioCtx;
function playBeep() {
  if (state.prefs.sound === false) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, t0);
    o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + 0.26);
  } catch (_) { /* sound na chale to koi masla nahi */ }
}

function updateTitleBadge() {
  const total = Object.values(state.chatMeta).reduce((n, m) => n + (m.unread || 0), 0);
  document.title = total ? `(${total}) Glide-Chat — Real-time Chat` : "Glide-Chat — Real-time Chat";
}

function clearUnread(uid) {
  if (!state.me || uidIsSpecial(uid)) return;
  const cid = chatIdOf(state.me.uid, uid);
  setDoc(doc(db, "chats", cid), { unread: { [state.me.uid]: 0 } }, { merge: true }).catch(() => {});
}

function notifyIncoming(u, meta) {
  playBeep();
  toast(`💬 ${nameOf(u)}: ${(meta.lastText || "").slice(0, 60)}`);
}

function syncChatListeners() {
  const wanted = new Set(state.users.map((u) => u.uid));
  Object.keys(state.metaUnsubs).forEach((uid) => {
    if (!wanted.has(uid)) {
      state.metaUnsubs[uid]();
      delete state.metaUnsubs[uid];
      delete state.chatMeta[uid];
    }
  });

  state.users.forEach((u) => {
    if (state.metaUnsubs[u.uid]) return;
    const cid = chatIdOf(state.me.uid, u.uid);
    let first = true;
    state.metaUnsubs[u.uid] = onSnapshot(doc(db, "chats", cid), (d) => {
      const data = d.data({ serverTimestamps: "estimate" }) || {};
      const meta = {
        lastText: data.lastText || "",
        lastFrom: data.lastFrom || "",
        lastAt: data.lastAt?.toMillis ? data.lastAt.toMillis() : 0,
        unread: Number(data.unread?.[state.me.uid] || 0),
      };
      const prev = state.chatMeta[u.uid];
      const openNow = state.active?.uid === u.uid && document.visibilityState === "visible";

      if (openNow && meta.unread > 0) { clearUnread(u.uid); meta.unread = 0; }          // chat khuli hai => unread zero
      if (!first && prev && meta.unread > prev.unread && !openNow) notifyIncoming(u, meta); // naya message alert
      first = false;

      const changed = !prev || prev.lastText !== meta.lastText || prev.lastAt !== meta.lastAt || prev.unread !== meta.unread;
      state.chatMeta[u.uid] = meta;
      if (changed) { renderUsers(); updateTitleBadge(); }
    }, () => { /* rules / internet ka masla yahan chup rahta hai, messages wali listener error dikhati hai */ });
  });
}

function contactFor(u) {
  return state.contacts.find((c) => (c.uid && c.uid === u.uid) || samePhone(c.phone, u.phone));
}
function nameOf(u) {
  const c = contactFor(u);
  return c ? c.name : u.name;
}

// "Online now" wali strip (sirf tab dobara banti hai jab online log badlein)
function renderOnlineStrip() {
  const strip = $("#onlineStrip");
  const row = $("#onlineRow");
  const online = state.users.filter(isOnline);
  if (!online.length) { hide(strip); row.innerHTML = ""; state.stripKey = ""; return; }
  show(strip);
  const key = online.map((u) => u.uid + "|" + nameOf(u) + "|" + (u.photoURL || "")).join(",");
  if (key === state.stripKey) return;
  state.stripKey = key;
  row.innerHTML = "";
  online.forEach((u, i) => {
    const s = document.createElement("div");
    s.className = "story";
    s.style.animationDelay = i * 60 + "ms";
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.appendChild(avatarEl({ ...u, name: nameOf(u) }));
    const nm = document.createElement("span");
    nm.textContent = (nameOf(u) || "").split(" ")[0];
    s.append(ring, nm);
    s.addEventListener("click", () => tryOpenChat(u));
    row.appendChild(s);
  });
}

function renderUsers() {
  const list = $("#userList");
  const q = $("#searchInput").value.trim().toLowerCase();
  const anim = state.animateNext;
  state.animateNext = false;
  list.innerHTML = "";
  if (state.tab === "status") { renderStatusPane(list); return; }

  // rows = { user (Glide-Chat account, ho sakta hai na ho), contact (saved, ho sakta hai na ho) }
  let rows = [];
  if (state.tab === "contacts") {
    rows = state.contacts.map((c) => ({
      contact: c,
      user: state.users.find((u) => (c.uid && u.uid === c.uid) || samePhone(u.phone, c.phone)),
    }));
  } else {
    rows = [AI_USER, ...state.groupUsers, ...state.roomUsers, ...state.users]
      .filter((u) => state.filter === "fav" ? isFav(u.uid) : state.filter === "arch" ? isArch(u.uid) : !isArch(u.uid))
      .filter((u) => !isDeleted(u))
      .map((u) => ({ user: u, contact: (u.isAI || u.isGroup) ? null : contactFor(u) }));
    // favourite upar, phir jis se abhi baat hui
    rows.sort((a, b) => ((b.user.isAI ? 1 : 0) - (a.user.isAI ? 1 : 0)) || (isFav(b.user.uid) - isFav(a.user.uid))
      || ((state.chatMeta[b.user.uid]?.lastAt || 0) - (state.chatMeta[a.user.uid]?.lastAt || 0)));
  }

  rows = rows.filter((r) => {
    const nm = (r.user ? nameOf(r.user) : r.contact.name) || "";
    const ph = r.user?.phone || r.contact?.phone || "";
    return nm.toLowerCase().includes(q) || ph.includes(q.replace(/\s/g, ""));
  });

  $("#paneTitle").textContent = state.tab === "contacts" ? "Contacts" : state.filter === "fav" ? "Favourites" : state.filter === "arch" ? "Archived" : "Chats";
  $("#filterRow").classList.toggle("hidden", state.tab === "contacts");
  $("#paneCount").textContent = rows.length;
  renderOnlineStrip();

  if (!rows.length) {
    const div = document.createElement("div");
    div.className = "no-users";
    if (state.tab === "contacts") {
      if (state.contacts.length) div.textContent = "No contacts found.";
      else { div.className = "no-users contacts-empty"; buildContactsEmpty(div); }
    } else if (state.filter === "fav") {
      div.textContent = "No favourites yet. Open a chat and tap ☆ ⭐";
    } else if (state.filter === "arch") {
      div.textContent = "No archived chats 🗂";
    } else {
      div.textContent = state.users.length
        ? "No users found."
        : "No other users yet. Invite a friend with 🎁 Invite on the left 😊";
    }
    list.appendChild(div);
    return;
  }

  rows.forEach(({ user, contact }, idx) => {
    const row = document.createElement("div");
    row.className = "user" + (anim ? " enter" : "") + (user && state.active?.uid === user.uid ? " active" : "");
    row.style.setProperty("--i", Math.min(idx, 12));

    const shownName = user ? nameOf(user) : contact.name;
    row.appendChild(user ? avatarEl({ ...user, name: shownName }, false, true) : avatarEl({ name: shownName }));

    const meta = document.createElement("div");
    meta.className = "user-meta";
    const nm = document.createElement("b"); nm.textContent = shownName + (user && isFav(user.uid) ? " ⭐" : "");
    const cm = user ? state.chatMeta[user.uid] : null;
    const st = document.createElement("small");
    if (user && isLocked(user.uid)) {
      st.textContent = "🔒 Locked chat";
      st.className = "preview" + (cm && cm.unread ? " unread" : "");
    } else if (cm && cm.lastText) {
      st.textContent = (cm.lastFrom === state.me.uid ? "You: " : "") + cm.lastText;
      st.className = "preview" + (cm.unread ? " unread" : "");
    } else if (user && user.isAI) {
      st.textContent = "Built-in helper • ask anything";
    } else if (user && user.isRoom) {
      st.textContent = "🌐 Open room • code: " + user.room;
    } else if (user && user.isGroup) {
      st.textContent = (user.type === "community" ? "📢 Community • " : "👥 Group • ") + user.members.length + " members";
    } else if (user) {
      st.textContent = lastSeenText(user);
      if (isOnline(user)) st.className = "on";
    } else {
      st.textContent = "Not on Glide-Chat";
    }
    meta.append(nm, st);
    const phone = "";
    if (phone) {
      const ph = document.createElement("small");
      ph.className = "ph";
      ph.textContent = phone;
      meta.appendChild(ph);
    }
    row.appendChild(meta);

    if (cm && cm.unread) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = cm.unread > 99 ? "99+" : String(cm.unread);
      row.appendChild(badge);
    }

    // contact Not on Glide-Chat -> WhatsApp se invite
    if (!user && contact) {
      const inv = document.createElement("button");
      inv.className = "inv-mini";
      inv.textContent = "📨 Invite";
      inv.title = "Send invite on WhatsApp";
      inv.addEventListener("click", (e) => {
        e.stopPropagation();
        sendInviteToNumber(contact.phone);
      });
      const lk = document.createElement("button");
      lk.className = "inv-mini link";
      lk.textContent = "💬 Chat";
      lk.title = "Pick your friend's Glide-Chat account and chat";
      lk.addEventListener("click", (e) => { e.stopPropagation(); openLinkModal(contact); });
      row.append(lk, inv);
    }

    if (state.tab === "contacts" && contact) {
      const ed = document.createElement("button");
      ed.className = "del ed"; ed.title = "Rename"; ed.textContent = "✏️";
      ed.addEventListener("click", (e) => { e.stopPropagation(); renameContact(contact); });
      row.appendChild(ed);
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Delete contact";
      del.textContent = "🗑";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`"${contact.name}" remove from contacts?`)) removeContact(contact);
      });
      row.appendChild(del);
    }

    row.addEventListener("click", (e) => {
      if (user) tryOpenChat(user);
      else if (contact) openLinkModal(contact);
    });
    list.appendChild(row);
  });
}
$("#searchInput").addEventListener("input", renderUsers);
setInterval(() => { if (state.me) renderUsers(); }, 30000); // online status refresh

/* ===================== chat ===================== */
function updatePeerHeader() {
  const u = state.active;
  if (!u) return;
  $("#peerName").textContent = nameOf(u);
  const st = $("#peerStatus");
  if (u.isRoom) { st.textContent = "🌐 Open room • code: " + u.room; st.className = ""; }
  else if (u.isGroup) { st.textContent = (u.type === "community" ? "📢 Community • " : "👥 ") + u.members.length + " members"; st.className = ""; }
  else if (u.isAI) { st.textContent = "built-in helper • hamesha online"; st.className = "on"; }
  else { st.textContent = lastSeenText(u); st.className = isOnline(u) ? "on" : ""; }
  const readOnly = !!u.isGroup && u.type === "community" && u.createdBy !== state.me.uid;
  if (!rec.mr || rec.mr.state !== "recording") {
    $("#msgInput").disabled = readOnly;
    $("#msgInput").placeholder = readOnly ? "📢 Only the admin can send messages" : "Type a message…";
  }
  const holder = $("#peerAvatar");
  holder.innerHTML = "";
  holder.appendChild(avatarEl({ ...u, name: nameOf(u) }, true, true));
  syncHeaderButtons();
}

async function tryOpenChat(user) {
  if (isLocked(user.uid) && !state.unlocked.has(user.uid)) {
    if (!(await verifyPin("🔒 " + nameOf(user) + " chat is locked"))) return;
    state.unlocked.add(user.uid);
  }
  openChat(user);
}

function openChat(user) {
  cancelRecordingIfAny();
  if (state.active && state.active.uid !== user.uid) state.unlocked.delete(state.active.uid);   // chat chhodte hi dobara lock
  state.unsubMsgs?.(); state.unsubChat?.();
  state.active = user;
  state.seenIds = null;
  state.peerSeen = 0; state.lastMsgs = null;
  state.typingShown = false;
  state.iAmTyping = false;
  clearUnread(user.uid);
  if (state.chatMeta[user.uid]) { state.chatMeta[user.uid].unread = 0; updateTitleBadge(); }
  renderUsers();
  hide($("#emptyState")); show($("#chatView"));
  $("#app").classList.add("chat-open");
  hide($("#emojiPanel"));
  updatePeerHeader();
  $("#messages").innerHTML = "";

  if (user.isAI) { renderAiChat(); setTimeout(() => $("#msgInput").focus(), 50); return; }

  const base = user.isRoom ? ["rooms", user.room] : user.isGroup ? ["groups", user.gid] : ["chats", chatIdOf(state.me.uid, user.uid)];
  chatBanner("");
  clearTimeout(state.firstMsgTimer);
  state.firstMsgTimer = setTimeout(() => {
    if (state.active === user && state.seenIds === null) chatBanner(CONNECT_HELP);
  }, 10000);

  state.unsubMsgs = onSnapshot(
    query(collection(db, ...base, "messages"), orderBy("createdAt", "asc")),
    { includeMetadataChanges: true },   // 🕓 -> ✓ badalne ke liye
    (snap) => {
      clearTimeout(state.firstMsgTimer);
      chatBanner("");
      state.lastMsgs = visibleMsgs(snap.docs.map((d) => ({
        id: d.id,
        ...d.data({ serverTimestamps: "estimate" }),
        pending: d.metadata.hasPendingWrites,
      })), user.uid);
      renderMessages(state.lastMsgs);
      if (state.lastMsgs.some((m) => m.from !== state.me.uid)) markSeen();
    },
    (err) => {
      clearTimeout(state.firstMsgTimer);
      chatBanner(err?.code === "permission-denied"
        ? "🚫 <b>Permission denied</b> — Firestore Rules are blocking this chat. Paste the full text of <b>RULES.txt</b> into Firebase → Firestore → Rules, click <b>Publish</b>, then refresh the page."
        : "⚠️ " + friendlyError(err));
    }
  );

  // typing indicator (1-1 only) + "seen" ticks (all chats)
  state.unsubChat = onSnapshot(doc(db, ...base), (d) => {
    const data = d.data() || {};
    if (!user.isGroup) renderTyping(!!(data.typing || {})[user.uid]);
    const seenMap = data.seen || {};
    const others = Object.entries(seenMap).filter(([uid]) => uid !== state.me.uid).map(([, v]) => msOf(v));
    const ps = others.length ? Math.max(...others) : 0;
    if (ps !== state.peerSeen) {
      state.peerSeen = ps;
      if (state.active === user && state.lastMsgs) renderMessages(state.lastMsgs);
    }
  }, () => {});
  markSeen();

  setTimeout(() => $("#msgInput").focus(), 50);
}

function renderMessages(msgs) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const firstLoad = state.seenIds === null;
  const prevSeen = state.seenIds || new Set();
  box.innerHTML = "";
  let lastDay = "";

  msgs.forEach((m) => {
    const date = m.createdAt?.toDate ? m.createdAt.toDate() : new Date();
    const dayKey = date.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const day = document.createElement("div");
      day.className = "day";
      const today = new Date().toDateString();
      const yest = new Date(Date.now() - 864e5).toDateString();
      day.textContent = dayKey === today ? "Today" : dayKey === yest ? "Yesterday" : date.toLocaleDateString();
      box.appendChild(day);
    }

    const isNew = !firstLoad && !prevSeen.has(m.id);
    const el = document.createElement("div");
    el.className = "msg " + (m.from === state.me.uid ? "mine" : "theirs")
      + (m.imageUrl && !m.text ? " img-only" : "") + (isNew ? " new" : "");
    if (m.imageUrl) {
      const img = document.createElement("img");
      img.src = m.imageUrl;
      img.alt = "photo";
      img.loading = "lazy";
      img.addEventListener("click", (ev) => { ev.stopPropagation(); $("#lbImg").src = m.imageUrl; show($("#lightbox")); });
      img.addEventListener("load", () => { box.scrollTop = box.scrollHeight; });
      el.appendChild(img);
    }
    if (state.active?.isGroup && m.from !== state.me.uid) {
      const sn = document.createElement("b");
      sn.className = "sender";
      sn.textContent = m.fromName || "Member";
      el.appendChild(sn);
    }
    if (m.audioUrl) el.appendChild(buildVoicePlayer(m.audioUrl, m.audioSecs));
    if (m.sticker) { el.classList.add("sticker-msg"); const st = document.createElement("div"); st.className = "sticker"; st.textContent = m.sticker; el.appendChild(st); }
    if (m.location) el.appendChild(buildLocation(m.location));
    if (m.poll) el.appendChild(buildPoll(m));
    if (m.call) {
      const cc = buildCall(m);
      el.appendChild(cc.node);
      if (isNew && m.from !== state.me.uid && cc.live && !celebrated.has("c" + m.id)) { celebrated.add("c" + m.id); ringIncoming(m); }
    }
    if (m.text) {
      const p = document.createElement("span");
      p.textContent = m.text;            // textContent => XSS safe
      el.appendChild(p);
    }
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (m.from === state.me.uid) {
      const tk = document.createElement("span");
      const seen = !m.pending && !state.active?.isAI && (state.peerSeen || 0) >= msOf(m.createdAt) && msOf(m.createdAt) > 0;
      tk.className = "tick" + (seen ? " seen" : "");
      tk.textContent = m.pending ? " 🕓" : seen ? " ✓✓" : " ✓";
      tk.title = m.pending ? "Sending…" : seen ? "Seen" : "Delivered";
      t.appendChild(tk);
    }
    el.appendChild(t);
    el.dataset.mid = m.id;
    if (m.replyTo) el.insertBefore(buildQuote(m.replyTo), el.firstChild);
    if (isNew && m.from !== state.me.uid && CELEBRATE.test(m.text || "") && !celebrated.has(m.id)) { celebrated.add(m.id); setTimeout(confettiBurst, 250); }
    const chips = buildReactChips(m);
    if (chips) el.appendChild(chips);
    box.appendChild(el);
    if (!state.active?.isAI) {
      el.classList.add("tapable");
      el.addEventListener("click", (ev) => { if (ev.target.closest("img,.vp,.react-chip,.reply-quote")) return; toggleMsgMenu(m, el); });
      el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); toggleMsgMenu(m, el); });
      if (state.menuMsgId === m.id) box.appendChild(buildMsgMenu(m, el.classList.contains("mine")));
    }
  });
  paintReply();
  applyChatSearch();

  state.seenIds = new Set(msgs.map((m) => m.id));

  if (state.typingShown) appendTypingBar();
  if (nearBottom || msgs.length <= 1 || msgs[msgs.length - 1]?.from === state.me.uid) {
    box.scrollTop = box.scrollHeight;
  }
}

function appendTypingBar() {
  const box = $("#messages");
  if (box.querySelector(".typing-bar")) return;
  const tb = document.createElement("div");
  tb.className = "typing-bar";
  tb.innerHTML = "<i></i><i></i><i></i>";
  box.appendChild(tb);
  box.scrollTop = box.scrollHeight;
}
function renderTyping(isTyping) {
  state.typingShown = isTyping;
  const box = $("#messages");
  const existing = box.querySelector(".typing-bar");
  if (isTyping) appendTypingBar();
  else existing?.remove();
}

async function setTyping(flag) {
  if (!state.active || uidIsSpecial(state.active.uid)) return;
  const cid = chatIdOf(state.me.uid, state.active.uid);
  try {
    await setDoc(doc(db, "chats", cid), {
      members: [state.me.uid, state.active.uid],
      typing: { [state.me.uid]: flag },
    }, { merge: true });
  } catch (_) { /* ignore */ }
}

$("#msgInput").addEventListener("input", () => {
  if (!state.iAmTyping) { state.iAmTyping = true; setTyping(true); }   // har key par write nahi
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => { state.iAmTyping = false; setTyping(false); }, 1800);
});

async function sendMessage({ text = "", imageUrl = "", audioUrl = "", audioSecs = 0, extra = {} }) {
  if (!state.active) return;
  if (state.active.isAI) { aiAsk(text); return; }
  if (state.active.isGroup) return sendGroupMessage({ text, imageUrl, audioUrl, audioSecs, extra });
  const cid = chatIdOf(state.me.uid, state.active.uid);
  const peerUid = state.active.uid;
  await addDoc(collection(db, "chats", cid, "messages"), {
    from: state.me.uid,
    to: peerUid,
    text,
    imageUrl,
    ...takeReply(),
    ...extra,
    ...(audioUrl ? { audioUrl, audioSecs } : {}),
    createdAt: serverTimestamp(),
  });
  state.iAmTyping = false;
  clearTimeout(state.typingTimer);
  // chat ka summary: list mein last message aur samne wale ke liye unread badge
  setDoc(doc(db, "chats", cid), {
    members: [state.me.uid, peerUid],
    lastText: lastLabelOf({ text, audioUrl, ...extra }),
    lastFrom: state.me.uid,
    lastAt: serverTimestamp(),
    unread: { [peerUid]: increment(1) },
    typing: { [state.me.uid]: false },
  }, { merge: true }).catch(() => {});
}

$("#msgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#msgInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  hide($("#emojiPanel"));

  if (CELEBRATE.test(text)) setTimeout(confettiBurst, 150);
  const sb = $("#sendBtn");           // send button ki chhoti si animation
  sb.classList.remove("fly");
  void sb.offsetWidth;
  sb.classList.add("fly");

  const slow = setTimeout(() => toast("⚠️ Message has not reached the server yet. Check your internet or Firestore Rules (tap 🩺 Connection check)."), 6000);
  try { await sendMessage({ text }); }
  catch (err) { toast(friendlyError(err)); input.value = text; }
  finally { clearTimeout(slow); }
});

// photo bhejna
$("#attachBtn").addEventListener("click", () => {
  if (state.active?.isAI) { toast("🤖 The AI only replies to text."); return; }
  $("#imgInput").click();
});
let pendingImg = null;
$("#imgInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.active) return;
  if (!file.type.startsWith("image/")) { toast("Please select an image only."); return; }
  if (file.size > 25 * 1024 * 1024) { toast("Image must be smaller than 25MB."); return; }
  try {
    pendingImg = await shrinkImage(file, 1280, 0.82);
    $("#ipImg").src = URL.createObjectURL(pendingImg);
    $("#ipCaption").value = "";
    show($("#imgPrev"));
    setTimeout(() => $("#ipCaption").focus(), 60);
  } catch (_) { toast("Could not read this image. Try another photo."); }
});
$("#ipCancel").addEventListener("click", () => { hide($("#imgPrev")); pendingImg = null; });
$("#ipCaption").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#ipSend").click(); } });
$("#ipSend").addEventListener("click", async () => {
  if (!pendingImg || !state.active) return;
  const blob = pendingImg, caption = $("#ipCaption").value.trim();
  pendingImg = null; hide($("#imgPrev"));
  const box = $("#messages");
  const note = document.createElement("div");
  note.className = "uploading"; note.textContent = "📤 Sending photo…";
  box.appendChild(note); box.scrollTop = box.scrollHeight;
  try {
    const url = await uploadMedia(blob, "image");
    await sendMessage({ text: caption, imageUrl: url });
  } catch (err) { toast(err.message || "There was a problem sending the photo."); }
  finally { note.remove(); }
});
$("#lightbox").addEventListener("click", () => hide($("#lightbox")));

/* ===================== emoji ===================== */
function buildEmojiPanel() {
  const panel = $("#emojiPanel");
  if (panel.childElementCount) return;
  const list = "😀 😁 😂 🤣 😊 😍 😘 😎 🤩 🥳 😇 🙂 😉 😋 🤔 😴 😢 😭 😡 🥺 😅 🙈 👍 👎 👏 🙌 🙏 💪 🤝 👋 ❤️ 💙 💜 🔥 ✨ 🎉 🎁 💯 ✅ ❌ 🚀 ⭐ 🌙 ☀️ 🍕 ☕ 🎵 📸 💻 📱".split(" ");
  list.forEach((em) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = em;
    b.addEventListener("click", () => {
      const inp = $("#msgInput");
      inp.value += em;
      inp.focus();
    });
    panel.appendChild(b);
  });
}
$("#emojiBtn").addEventListener("click", () => $("#emojiPanel").classList.toggle("hidden"));

/* ===================== mobile back ===================== */
$("#backBtn").addEventListener("click", () => {
  cancelRecordingIfAny();
  $("#app").classList.remove("chat-open");
  state.unsubMsgs?.(); state.unsubChat?.();
  state.active = null;
  hide($("#chatView")); show($("#emptyState"));
  renderUsers();
});

/* ===================== contacts ===================== */
/*
  Contacts "local-first" hain:
   - save karte hi foran list mein aa jate hain (server ka intezar nahi)
   - is device ke localStorage mein bhi mehfooz rehte hain
   - background mein Firestore se sync hote hain (rules / internet theek ho to)
*/
const LS_KEY = () => `gs_contacts_${state.me.uid}`;

function loadLocalContacts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY()) || "[]"); } catch (_) { return []; }
}
function persistLocalContacts() {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(state.localContacts)); } catch (_) { /* ignore */ }
}
function rebuildContacts() {
  const map = new Map();
  state.localContacts.forEach((c) => map.set(c.id, c));
  state.cloudContacts.forEach((c) => map.set(c.id, { ...(map.get(c.id) || {}), ...c }));
  state.contacts = [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}
function refreshContactsUI() {
  rebuildContacts();
  renderUsers();
  if (state.active) updatePeerHeader();
}

function cloudFailed(err) {
  if (state.cloudFailShown) return;
  state.cloudFailShown = true;
  toast(err?.code === "permission-denied"
    ? "⚠️ Contact is saved on this device but not in the cloud. Add the contacts section to Firestore Rules (README)."
    : "⚠️ Contact is saved on this device; cloud sync has not happened yet.");
}

function pushContact(c) {
  return setDoc(
    doc(db, "users", state.me.uid, "contacts", c.id),
    { name: c.name, phone: c.phone || "", uid: c.uid || "", createdAt: serverTimestamp() },
    { merge: true }
  ).catch(cloudFailed);
}

function subscribeContacts() {
  state.unsubContacts?.();
  state.localContacts = loadLocalContacts();
  state.cloudContacts = [];
  rebuildContacts();
  state.unsubContacts = onSnapshot(
    collection(db, "users", state.me.uid, "contacts"),
    (snap) => {
      state.cloudContacts = snap.docs.map((d) => ({ id: d.id, ...d.data(), pending: false }));
      const cloudIds = new Set(state.cloudContacts.map((c) => c.id));
      let changed = false;
      state.localContacts.forEach((c) => {
        if (cloudIds.has(c.id)) {
          if (c.pending) { c.pending = false; changed = true; }
        } else if (c.pending && !state.syncTried.has(c.id)) {
          state.syncTried.add(c.id);            // jo cloud tak nahi pahunche unhe dobara bhejo
          pushContact(c);
        }
      });
      if (changed) persistLocalContacts();
      refreshContactsUI();
    },
    (err) => { cloudFailed(err); refreshContactsUI(); }
  );
}

// Contact save / update (foran). true => pehle se saved tha (sirf update hua)
function saveContact({ name, phone = "", uid = "" }) {
  const id = phone ? phone.replace(/\D/g, "") : uid;
  const existed = state.contacts.some((c) => c.id === id);
  // ek hi dost ke do contact na banein: purana (alag id wala) hata do
  if (uid) {
    state.contacts.filter((c) => c.uid === uid && c.id !== id).forEach((c) => {
      state.localContacts = state.localContacts.filter((x) => x.id !== c.id);
      state.cloudContacts = state.cloudContacts.filter((x) => x.id !== c.id);
      deleteDoc(doc(db, "users", state.me.uid, "contacts", c.id)).catch(() => {});
    });
  }
  const entry = { id, name, phone, uid, pending: true };
  const i = state.localContacts.findIndex((c) => c.id === id);
  if (i >= 0) state.localContacts[i] = { ...state.localContacts[i], ...entry };
  else state.localContacts.push(entry);
  persistLocalContacts();
  state.cloudContacts = state.cloudContacts.map((c) => (c.id === id ? { ...c, name, phone, uid } : c));
  refreshContactsUI();
  state.syncTried.add(id);
  pushContact(entry);
  return existed;
}

function removeContact(c) {
  state.localContacts = state.localContacts.filter((x) => x.id !== c.id);
  state.cloudContacts = state.cloudContacts.filter((x) => x.id !== c.id);
  persistLocalContacts();
  refreshContactsUI();
  deleteDoc(doc(db, "users", state.me.uid, "contacts", c.id)).catch(() => {});
}

function renameContact(c) {
  const nn = prompt("Enter a new name:", c.name || "");
  if (nn === null) return;
  const name = nn.trim();
  if (!name) return;
  saveContact({ name, phone: c.phone || "", uid: c.uid || "" });
  toast("Name updated ✅");
}

// Glide-Chat user ko ek click mein save (naam aur number khud aa jata hai)
function quickSave(u) {
  saveContact({ name: u.name, phone: u.phone || "", uid: u.uid });
  toast(`⭐ ${u.name} saved to contacts`);
}

/* ----- apna number ----- */
function updateMyPhone() {
  const el = $("#mePhone");
  el.textContent = "● online";
  el.classList.remove("addnum");
}

function openPhoneModal() {
  $("#myPhoneInput").value = "";
  $("#myPhoneError").textContent = "";
  show($("#phoneModal"));
  setTimeout(() => $("#myPhoneInput").focus(), 60);
}
$("#mePhone").addEventListener("click", async () => {
  if (!state.me) return;
  if (!state.me.phone) { openPhoneModal(); return; }
  try { await navigator.clipboard.writeText(state.me.phone); toast("Your number is copied 📋 Send it to a friend"); }
  catch (_) { toast("Your number: " + state.me.phone); }
});
$("#phoneLater").addEventListener("click", () => hide($("#phoneModal")));
$("#phoneForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = normalizePhone($("#myPhoneInput").value.trim());
  if (!p) { $("#myPhoneError").textContent = "Number is not valid. Example: 03001234567"; return; }
  const btn = $("#phoneSave");
  btn.disabled = true;
  try {
    await setDoc(doc(db, "users", state.me.uid), { phone: p }, { merge: true });
    state.me.phone = p;
    updateMyPhone({ phone: p });
    hide($("#phoneModal"));
    toast("✅ Your number is saved. Friends can now find you by number.");
  } catch (err) { $("#myPhoneError").textContent = friendlyError(err); }
  finally { btn.disabled = false; }
});

/* ----- tabs ----- */
function setTab(t) {
  state.tab = t;
  state.animateNext = true;
  $("#tabAll").classList.toggle("active", t === "all");
  $("#tabContacts").classList.toggle("active", t === "contacts");
  $("#tabStatus").classList.toggle("active", t === "status");
  renderUsers();
}
$("#tabAll").addEventListener("click", () => setTab("all"));
$("#tabContacts").addEventListener("click", () => setTab("contacts"));

/* ----- contacts tab khali ho to madad ----- */
const supportsPicker = () => "contacts" in navigator && "ContactsManager" in window;

function buildContactsEmpty(box) {
  box.innerHTML = "";
  const t = document.createElement("div");
  t.className = "ce-title";
  t.textContent = "No contacts saved yet 📇";
  const p = document.createElement("p");
  p.textContent = "Easy ways to save a contact:";
  box.append(t, p);
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.className = "ea";
    b.textContent = label;
    b.addEventListener("click", fn);
    box.appendChild(b);
  };
  mk("⭐ Pick from Glide-Chat users in one click", () => setTab("all"));
  mk("＋ Save by typing a number or email", openContactModal);
  if (supportsPicker()) mk("📱 Import from phone contacts", importFromPhone);
}

/* ----- contact save wala popup ----- */
let nameAutofilled = false;

function openContactModal() {
  $("#contactForm").reset();
  $("#contactError").textContent = "";
  $("#cHint").textContent = "";
  $("#cHint").className = "c-hint";
  nameAutofilled = false;
  hide($("#bulkWrap"));
  $("#importBtn").classList.toggle("hidden", !supportsPicker());
  show($("#contactModal"));
  setTimeout(() => $("#cPhone").focus(), 50);
}
function closeContactModal() { hide($("#contactModal")); }

$("#addRoomBtn").addEventListener("click", () => openRoomModal());
$("#contactCancel").addEventListener("click", closeContactModal);
$("#contactClose").addEventListener("click", closeContactModal);
$("#contactModal").addEventListener("click", (e) => { if (e.target.id === "contactModal") closeContactModal(); });

// number likhte hi dikhao ke ye is on Glide-Chat ya nahi, aur naam khud bhar do
$("#cPhone").addEventListener("input", () => {
  const raw = $("#cPhone").value.trim();
  const hint = $("#cHint");
  const nameInput = $("#cName");
  const isMail = raw.includes("@");
  if (!isMail && raw.replace(/\D/g, "").length < 10) { hint.textContent = ""; hint.className = "c-hint"; return; }
  const p = isMail ? raw : normalizePhone(raw);
  if (!p) { hint.textContent = "The number does not look valid."; hint.className = "c-hint warn"; return; }
  if (!isMail && samePhone(p, state.me.phone)) { hint.textContent = "This is your own number."; hint.className = "c-hint warn"; return; }
  const peer = findPeer(raw);
  if (peer) {
    hint.textContent = `✅ ${peer.name} is on Glide-Chat`;
    hint.className = "c-hint ok";
    if (!nameInput.value.trim() || nameAutofilled) { nameInput.value = peer.name; nameAutofilled = true; }
  } else {
    hint.textContent = isMail
      ? "No Glide-Chat account found for this email. Enter the email your friend signed up with."
      : "ℹ️ No Glide-Chat account found with this number (your friend may not have added their number). After saving you can pick their account from the list.";
    hint.className = isMail ? "c-hint warn" : "c-hint";
    if (nameAutofilled) { nameInput.value = ""; nameAutofilled = false; }
  }
});
$("#cName").addEventListener("input", () => { nameAutofilled = false; });

// Save: bilkul instant (koi network intezar nahi)
$("#contactForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const errBox = $("#contactError");
  errBox.textContent = "";
  const raw = $("#cPhone").value.trim();
  let name = $("#cName").value.trim();
  const isMail = raw.includes("@");

  let phone = "";
  let peer = findPeer(raw);
  if (isMail) {
    if (!peer) { errBox.textContent = "No Glide-Chat account found for this email."; return; }
    phone = peer.phone || "";
  } else {
    phone = normalizePhone(raw);
    if (!phone) { errBox.textContent = "Number is not valid. Example: 03001234567, or enter your friend's email."; return; }
    if (samePhone(phone, state.me.phone)) { errBox.textContent = "This is your own number."; return; }
  }
  if (!name && peer) name = peer.name;
  if (!name) { errBox.textContent = "Enter a name."; return; }

  const existed = saveContact({ name, phone, uid: peer ? peer.uid : "" });
  closeContactModal();
  setTab("contacts");
  if (peer) {
    toast(existed ? `${name} contact updated ✅` : `${name} saved ✅ Opening chat`);
    openChat(peer);
  } else {
    toast(`${name} saved ✅ Now pick their Glide-Chat account.`);
    const saved = state.contacts.find((c) => c.id === phone.replace(/\D/g, ""));
    if (saved) setTimeout(() => openLinkModal(saved), 350);
  }
});

// Bahut saare number ek saath (har line mein naam + number)
$("#pickBtn").addEventListener("click", () => { closeContactModal(); openLinkModal(null); });
$("#bulkToggle").addEventListener("click", () => {
  $("#bulkWrap").classList.toggle("hidden");
  setTimeout(() => $("#bulkText").focus(), 50);
});
$("#bulkSave").addEventListener("click", () => {
  const lines = $("#bulkText").value.split(/\r?\n/);
  let ok = 0;
  let bad = 0;
  lines.forEach((line) => {
    if (!line.trim()) return;
    const m = line.match(/\+?\d[\d\s\-()]{6,}\d/);
    const phone = m ? normalizePhone(m[0]) : "";
    if (!phone || samePhone(phone, state.me.phone)) { bad++; return; }
    const peer = state.users.find((u) => samePhone(u.phone, phone));
    let name = line.replace(m[0], " ").replace(/[,;:|]+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) name = peer ? peer.name : phone;
    saveContact({ name, phone, uid: peer ? peer.uid : "" });
    ok++;
  });
  if (!ok) { $("#contactError").textContent = "No valid number found. Write a name and number on each line."; return; }
  closeContactModal();
  toast(`✅ ${ok} contacts saved` + (bad ? `, ${bad} invalid lines` : ""));
  setTab("contacts");
});

// Phone ke contacts se import (Android Chrome par, https/deploy ke baad)
async function importFromPhone() {
  try {
    const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
    let ok = 0;
    picked.forEach((c) => {
      const phone = normalizePhone((c.tel && c.tel[0]) || "");
      if (!phone || samePhone(phone, state.me.phone)) return;
      const peer = state.users.find((u) => samePhone(u.phone, phone));
      saveContact({ name: (c.name && c.name[0]) || (peer ? peer.name : phone), phone, uid: peer ? peer.uid : "" });
      ok++;
    });
    closeContactModal();
    toast(ok ? `✅ ${ok} contacts imported` : "No valid number found.");
    if (ok) setTab("contacts");
  } catch (_) { /* user ne cancel kar diya */ }
}
$("#importBtn").addEventListener("click", importFromPhone);

// Chat ke upar "⭐ Save contact" (agar ye dost abhi saved nahi)
$("#headSave").addEventListener("click", () => { if (state.active) quickSave(state.active); });

/* ===================== naye features: favourite, archive, lock, voice, call ===================== */
const PREF_KEY = () => `gs_prefs_${state.me.uid}`;
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY()) || "{}"); } catch (_) { /* ignore */ }
  state.prefs = { fav: p.fav || [], arch: p.arch || [], lock: p.lock || [], pin: p.pin || "", cleared: p.cleared || {}, deleted: p.deleted || {}, sound: p.sound !== false, theme: p.theme || "sunset", wall: p.wall || "dots" };
  applyAppearance();
}
function savePrefs() { try { localStorage.setItem(PREF_KEY(), JSON.stringify(state.prefs)); } catch (_) { /* ignore */ } }
const isFav = (uid) => state.prefs.fav.includes(uid);
const isArch = (uid) => state.prefs.arch.includes(uid);
const isLocked = (uid) => state.prefs.lock.includes(uid);
function togglePref(list, uid) {
  const a = state.prefs[list];
  const i = a.indexOf(uid);
  if (i >= 0) a.splice(i, 1); else a.push(uid);
  savePrefs();
  return i < 0;
}

/* ----- filter chips (Sab / Favourites / Archived) ----- */
document.querySelectorAll("#filterRow .chip").forEach((b) => {
  b.addEventListener("click", () => {
    state.filter = b.dataset.f;
    state.animateNext = true;
    document.querySelectorAll("#filterRow .chip").forEach((x) => x.classList.toggle("active", x === b));
    if (state.tab !== "all") setTab("all"); else renderUsers();
  });
});

/* ----- PIN popup ----- */
async function hashPin(pin) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gs:" + pin));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch (_) { return "p" + btoa(pin); }
}
let pinResolve = null;
function askPin(title, sub = "") {
  return new Promise((res) => {
    pinResolve = res;
    $("#pinTitle").textContent = title;
    $("#pinSub").textContent = sub;
    $("#pinInput").value = "";
    $("#pinError").textContent = "";
    show($("#pinModal"));
    setTimeout(() => $("#pinInput").focus(), 60);
  });
}
function closePin(val) { hide($("#pinModal")); const r = pinResolve; pinResolve = null; r && r(val); }
$("#pinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#pinInput").value.trim();
  if (!/^\d{4,6}$/.test(v)) { $("#pinError").textContent = "Enter a PIN of 4 to 6 digits."; return; }
  closePin(v);
});
$("#pinCancel").addEventListener("click", () => closePin(null));

async function ensurePin() {            // pehli baar lock karte waqt PIN banwao
  if (state.prefs.pin) return true;
  const a = await askPin("🔒 Create a new PIN", "4 to 6 digits. This PIN stays on this device only.");
  if (!a) return false;
  const b = await askPin("🔒 Enter the PIN again");
  if (!b) return false;
  if (a !== b) { toast("PINs do not match, please try again."); return false; }
  state.prefs.pin = await hashPin(a);
  savePrefs();
  return true;
}
async function verifyPin(title = "🔒 Chat is locked") {
  const v = await askPin(title, "Enter your PIN");
  if (!v) return false;
  if ((await hashPin(v)) === state.prefs.pin) return true;
  toast("❌ Wrong PIN");
  return false;
}

/* ----- chat header buttons ----- */
function syncHeaderButtons() {
  const u = state.active;
  if (!u) return;
  $("#favBtn").textContent = isFav(u.uid) ? "⭐" : "☆";
  $("#favBtn").classList.toggle("on", isFav(u.uid));
  $("#archBtn").classList.toggle("on", isArch(u.uid));
  $("#archBtn").title = isArch(u.uid) ? "Unarchive" : "Archive chat";
  $("#lockBtn").textContent = isLocked(u.uid) ? "🔒" : "🔓";
  $("#lockBtn").classList.toggle("on", isLocked(u.uid));
  $("#headSave").classList.add("hidden");
  $("#headInvite").classList.toggle("hidden", !u.isRoom);
  $("#archBtn").classList.toggle("hidden", !!u.isAI);
  $("#lockBtn").classList.toggle("hidden", !!u.isAI);
  $("#favBtn").classList.toggle("hidden", !!u.isAI);
  $("#callBtn").classList.toggle("hidden", !!u.isAI);
  $("#vcallBtn").classList.toggle("hidden", !!u.isAI);
}
$("#favBtn").addEventListener("click", () => {
  const u = state.active; if (!u) return;
  const now = togglePref("fav", u.uid);
  toast(now ? `⭐ ${nameOf(u)} added to favourites` : "Removed from favourites");
  syncHeaderButtons(); renderUsers();
});
$("#archBtn").addEventListener("click", () => {
  const u = state.active; if (!u) return;
  const now = togglePref("arch", u.uid);
  toast(now ? "🗂 Chat archived (find it under Archived above)" : "Chat restored from archive");
  syncHeaderButtons(); renderUsers();
});
$("#lockBtn").addEventListener("click", async () => {
  const u = state.active; if (!u) return;
  if (isLocked(u.uid)) {
    if (!(await verifyPin("🔓 PIN to remove lock"))) return;
    togglePref("lock", u.uid);
    toast("Chat unlocked");
  } else {
    if (!(await ensurePin())) return;
    togglePref("lock", u.uid);
    state.unlocked.add(u.uid);
    toast("🔒 Chat locked. You will be asked for the PIN when you open it again.");
  }
  syncHeaderButtons(); renderUsers();
});

/* ----- voice message ----- */
const rec = { mr: null, chunks: [], stream: null, t0: 0, timer: null, cancelled: false };
function fmtSec(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function resetRecUI() {
  clearInterval(rec.timer);
  $("#micBtn").classList.remove("rec");
  $("#micBtn").textContent = "🎤";
  $("#micBtn").title = "Voice message";
  hide($("#micCancel"));
  $("#msgInput").placeholder = "Type a message…";
  $("#msgInput").disabled = false;
}
function cancelRecordingIfAny() { if (rec.mr && rec.mr.state === "recording") stopRecording(true); }
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("Voice messages are not supported in this browser."); return; }
  try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (_) { toast("Allow microphone access (🔒 icon in the browser)."); return; }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = []; rec.cancelled = false;
  rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.mr.onstop = onRecStop;
  rec.mr.start();
  rec.t0 = Date.now();
  $("#micBtn").classList.add("rec");
  $("#micBtn").textContent = "➤";
  $("#micBtn").title = "Send voice message";
  show($("#micCancel"));
  $("#msgInput").disabled = true;
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.t0) / 1000);
    $("#msgInput").placeholder = `🎙 Recording… ${fmtSec(s)}  (➤ send  •  🗑 cancel)`;
    if (s >= 120) stopRecording(false);
  }, 250);
}
function stopRecording(cancel) {
  if (!rec.mr || rec.mr.state === "inactive") return;
  rec.cancelled = cancel;
  rec.mr.stop();
}
async function onRecStop() {
  rec.stream?.getTracks().forEach((t) => t.stop());
  const secs = Math.round((Date.now() - rec.t0) / 1000);
  resetRecUI();
  if (rec.cancelled || secs < 1) { if (!rec.cancelled) toast("Voice message was too short."); return; }
  const blob = new Blob(rec.chunks, { type: rec.mr.mimeType || "audio/webm" });
  const note = document.createElement("div");
  note.className = "uploading";
  note.textContent = "📤 Sending voice message…";
  $("#messages").appendChild(note);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  try {
    const url = await uploadMedia(blob, "audio");
    await sendMessage({ audioUrl: url, audioSecs: secs });
  } catch (err) { toast(err.message || "There was a problem sending the voice message."); }
  finally { note.remove(); }
}
$("#micBtn").addEventListener("click", () => {
  if (!state.active) return;
  if (state.active.isAI) { toast("🤖 The AI only replies to text."); return; }
  if (rec.mr && rec.mr.state === "recording") stopRecording(false); else startRecording();
});
$("#micCancel").addEventListener("click", () => stopRecording(true));

/* ----- contact ko Glide-Chat account se jodna (agar number match na ho) ----- */
let linkTarget = null;
function openLinkModal(contact) {
  linkTarget = contact || null;
  $("#linkTitle").textContent = contact ? "🔗 Contact jodein" : "👥 Pick a friend";
  $("#linkWho").textContent = contact
    ? `"${contact.name}" — pick the Glide-Chat account (identify by name or email)`
    : "Tap the friend you want to save. Name and number will be saved automatically.";
  $("#linkInvite").classList.toggle("hidden", !contact?.phone);
  const box = $("#linkList");
  box.innerHTML = "";
  if (!state.users.length) {
    box.innerHTML = '<p class="pin-sub">No other users on Glide-Chat yet. Invite a friend 📨 first, let them sign up, then come back here.</p>';
  }
  // jis ka naam contact se milta ho wo upar
  const key = (contact?.name || "").toLowerCase().split(" ")[0];
  const list = [...state.users].sort((a, b) =>
    (key && b.name.toLowerCase().includes(key)) - (key && a.name.toLowerCase().includes(key)));
  list.forEach((u) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-row";
    b.appendChild(avatarEl(u));
    const t = document.createElement("span");
    t.innerHTML = "<b></b><small></small><small></small>";
    const [nm, s1, s2] = t.children;
    nm.textContent = u.name;
    s1.textContent = u.email || "";
    s2.textContent = u.phone || "number not added";
    b.appendChild(t);
    b.addEventListener("click", () => {
      hide($("#linkModal"));
      if (linkTarget) {
        saveContact({ name: linkTarget.name, phone: linkTarget.phone || u.phone || "", uid: u.uid });
        toast(`🔗 ${linkTarget.name} is now linked to ${u.name} ✅`);
      } else {
        saveContact({ name: u.name, phone: u.phone || "", uid: u.uid });
        toast(`⭐ ${u.name} saved to contacts`);
      }
      state.tab = "contacts"; setTab("contacts");
      openChat(u);
    });
    box.appendChild(b);
  });
  show($("#linkModal"));
}
$("#linkClose").addEventListener("click", () => hide($("#linkModal")));
$("#linkInvite").addEventListener("click", () => { hide($("#linkModal")); if (linkTarget?.phone) sendInviteToNumber(linkTarget.phone); });
$("#linkModal").addEventListener("click", (e) => { if (e.target.id === "linkModal") hide($("#linkModal")); });

/* ===================== v7: groups, communities, status, AI, QR, settings, help ===================== */
const AI_USER = { uid: "ai", name: "Glide-Chat AI", isAI: true };
const uidIsSpecial = (uid) => uid === "ai" || String(uid).startsWith("g:") || String(uid).startsWith("r:");
const msOf = (t) => (t?.toMillis ? t.toMillis() : t?.toDate ? t.toDate().getTime() : 0);
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function visibleMsgs(list, uid) {
  const t = state.prefs.cleared[uid] || 0;
  return t ? list.filter((m) => msOf(m.createdAt) === 0 || msOf(m.createdAt) > t) : list;
}
function isDeleted(u) {
  const t = state.prefs.deleted[u.uid];
  return !!t && (state.chatMeta[u.uid]?.lastAt || 0) <= t;
}

/* ----- dropdown menus ----- */
function toggleMenu(menu) {
  const open = menu.classList.contains("hidden");
  document.querySelectorAll(".dropdown").forEach((d) => d.classList.add("hidden"));
  if (open) menu.classList.remove("hidden");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown") && !e.target.closest(".kebab-wrap")) {
    document.querySelectorAll(".dropdown").forEach((d) => d.classList.add("hidden"));
  }
});
$("#paneMenuBtn").addEventListener("click", () => toggleMenu($("#paneMenu")));
$("#moreBtn").addEventListener("click", () => {
  const u = state.active;
  if (!u) return;
  const isG = !!u.isGroup;
  $("#mDelete").textContent = u.isRoom ? "🚪 Leave room" : isG ? "🚪 Group chhodein" : "🗑 Delete chat";
  $("#mShare").classList.toggle("hidden", !u.isRoom);
  $("#mDelete").classList.toggle("hidden", !!u.isAI);
  toggleMenu($("#headMenu"));
});
$("#paneMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  $("#paneMenu").classList.add("hidden");
  const act = b.dataset.act;
  if (act === "room") openRoomModal();
  else if (act === "group") openGroupModal("group");
  else if (act === "community") openGroupModal("community");
  else if (act === "status") { setTab("status"); openStatusModal(); }
  else if (act === "arch" || act === "fav") {
    state.filter = act;
    document.querySelectorAll("#filterRow .chip").forEach((x) => x.classList.toggle("active", x.dataset.f === act));
    if (state.tab !== "all") setTab("all"); else { state.animateNext = true; renderUsers(); }
  }
  else if (act === "ai") tryOpenChat(AI_USER);
  else if (act === "qr") openQr();
  else if (act === "settings") openSettings();
  else if (act === "help") show($("#helpModal"));
});

/* ----- clear / delete chat (sirf aapke device par, WhatsApp ki tarah "mere liye") ----- */
function clearChat(u) {
  state.prefs.cleared[u.uid] = Date.now();
  savePrefs();
  if (u.isAI) { state.aiMsgs = []; saveAi(); }
  if (state.active && state.active.uid === u.uid) openChat(state.active);
  renderUsers();
}
$("#mClear").addEventListener("click", () => {
  $("#headMenu").classList.add("hidden");
  const u = state.active;
  if (!u || !confirm("Clear all messages of this chat for you?")) return;
  clearChat(u);
  toast("🧹 Chat cleared");
});
$("#mDelete").addEventListener("click", async () => {
  $("#headMenu").classList.add("hidden");
  const u = state.active;
  if (!u) return;
  if (u.isRoom) {
    if (!confirm(`Room "${u.room}" — leave this room? (you can rejoin later with the code)`)) return;
    state.roomUsers = state.roomUsers.filter((r) => r.room !== u.room);
    saveRooms();
  } else if (u.isGroup) {
    if (!confirm(`"${u.name}" — leave this group?`)) return;
    try {
      await updateDoc(doc(db, "groups", u.gid), { members: u.members.filter((m) => m !== state.me.uid) });
      toast("You left the group");
    } catch (err) { toast(friendlyError(err)); return; }
  } else {
    if (!confirm(`"${nameOf(u)}" — delete this chat? (it will come back when a new message arrives)`)) return;
    state.prefs.deleted[u.uid] = Date.now();
    state.prefs.cleared[u.uid] = Date.now();
    savePrefs();
    toast("🗑 Chat deleted");
  }
  state.unsubMsgs?.(); state.unsubChat?.();
  state.active = null;
  $("#app").classList.remove("chat-open");
  hide($("#chatView")); show($("#emptyState"));
  renderUsers();
});

/* ===================== groups + communities ===================== */
function subscribeGroups() {
  state.unsubGroups?.();
  state.groupsLoaded = false;
  state.unsubGroups = onSnapshot(
    query(collection(db, "groups"), where("members", "array-contains", state.me.uid)),
    (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .filter((g) => (g.members || []).includes(state.me.uid));
      state.groupUsers = list.map((g) => ({
        uid: "g:" + g.id, gid: g.id, name: g.name || "Group", isGroup: true,
        members: g.members, createdBy: g.createdBy, type: g.type || "group",
      }));
      list.forEach((g) => {
        const key = "g:" + g.id;
        const meta = {
          lastText: g.lastText ? (g.lastFrom === state.me.uid ? "" : (g.lastFromName ? g.lastFromName + ": " : "")) + g.lastText : "",
          lastFrom: g.lastFrom || "", lastAt: msOf(g.lastAt), unread: 0,
        };
        const prev = state.chatMeta[key];
        if (state.groupsLoaded && prev && meta.lastAt > prev.lastAt && g.lastFrom !== state.me.uid && state.active?.uid !== key) {
          playBeep();
          toast(`${g.type === "community" ? "📢" : "👥"} ${g.name}: ${meta.lastText.slice(0, 60)}`);
        }
        state.chatMeta[key] = meta;
      });
      state.groupsLoaded = true;
      if (state.active?.isGroup) {
        const fresh = state.groupUsers.find((x) => x.uid === state.active.uid);
        if (fresh) { state.active = fresh; updatePeerHeader(); }
      }
      renderUsers();
    },
    (err) => {
      if (!state.groupWarned) {
        state.groupWarned = true;
        if (err?.code === "permission-denied") toast("⚠️ Update Firestore Rules for Groups/Status (RULES.txt file).");
      }
    }
  );
}

let groupKind = "group";
function openGroupModal(kind) {
  groupKind = kind;
  $("#groupTitle").textContent = kind === "community" ? "📢 New community" : "👥 New group";
  $("#groupHint").textContent = kind === "community"
    ? "In a community only you (admin) can send messages; everyone else can read."
    : "Everyone in the group can send messages.";
  $("#groupName").value = "";
  $("#groupError").textContent = "";
  const box = $("#groupMembers");
  box.innerHTML = "";
  if (!state.users.length) box.innerHTML = '<p class="pin-sub">No other users yet. Invite a friend first.</p>';
  state.users.forEach((u) => {
    const l = document.createElement("label");
    l.className = "link-row member";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = u.uid;
    const t = document.createElement("span");
    t.textContent = nameOf(u);
    l.append(cb, avatarEl({ ...u, name: nameOf(u) }, true), t);
    box.appendChild(l);
  });
  show($("#groupModal"));
  setTimeout(() => $("#groupName").focus(), 60);
}
$("#groupClose").addEventListener("click", () => hide($("#groupModal")));
$("#groupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#groupName").value.trim();
  const picked = [...$("#groupMembers").querySelectorAll("input:checked")].map((c) => c.value);
  if (!name) { $("#groupError").textContent = "Enter a name."; return; }
  if (!picked.length) { $("#groupError").textContent = "Select at least one member."; return; }
  const btn = $("#groupCreate");
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, "groups"), {
      name, type: groupKind, members: [state.me.uid, ...picked], createdBy: state.me.uid,
      createdAt: serverTimestamp(), lastText: "", lastAt: serverTimestamp(),
    });
    hide($("#groupModal"));
    toast(groupKind === "community" ? "📢 Community created" : "👥 Group created");
    setTab("all");
    const gu = { uid: "g:" + ref.id, gid: ref.id, name, isGroup: true, members: [state.me.uid, ...picked], createdBy: state.me.uid, type: groupKind };
    if (!state.groupUsers.some((x) => x.gid === ref.id)) state.groupUsers.unshift(gu);
    openChat(gu);
  } catch (err) {
    $("#groupError").textContent = err?.code === "permission-denied"
      ? "Add the groups section to Firestore Rules (RULES.txt) and Publish."
      : friendlyError(err);
  } finally { btn.disabled = false; }
});

async function sendGroupMessage({ text = "", imageUrl = "", audioUrl = "", audioSecs = 0, extra = {} }) {
  const g = state.active;
  if (g.type === "community" && g.createdBy !== state.me.uid) { toast("📢 Only the admin can send messages in this community."); return; }
  if (g.isRoom) {
    await addDoc(collection(db, "rooms", g.room, "messages"), {
      from: state.me.uid, fromName: state.me.name, text, imageUrl, ...takeReply(), ...extra,
      ...(audioUrl ? { audioUrl, audioSecs } : {}),
      createdAt: serverTimestamp(),
    });
    return;
  }
  await addDoc(collection(db, "groups", g.gid, "messages"), {
    from: state.me.uid, fromName: state.me.name, text, imageUrl, ...takeReply(), ...extra,
    ...(audioUrl ? { audioUrl, audioSecs } : {}),
    createdAt: serverTimestamp(),
  });
  setDoc(doc(db, "groups", g.gid), {
    lastText: lastLabelOf({ text, audioUrl, ...extra }),
    lastFrom: state.me.uid, lastFromName: state.me.name, lastAt: serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

/* ===================== Glide-Chat AI (built-in helper) ===================== */
const AI_KEY = () => `gs_ai_${state.me.uid}`;
function loadAi() { try { state.aiMsgs = JSON.parse(localStorage.getItem(AI_KEY()) || "[]"); } catch (_) { state.aiMsgs = []; } }
function saveAi() { try { localStorage.setItem(AI_KEY(), JSON.stringify(state.aiMsgs.slice(-80))); } catch (_) { /* ignore */ } }
function renderAiChat() {
  if (!state.aiMsgs.length) {
    state.aiMsgs.push({ id: "w", from: "ai", ts: Date.now(),
      text: "Hello! I'm Glide-Chat AI 🤖 (a helper built into the app).\nAsk me: how to send a link to a friend, how to create a group, status, QR, lock, or just say 'joke', 'quote', 'time', or a calculation like 12*7 😊" });
    saveAi();
  }
  const t = state.prefs.cleared.ai || 0;
  renderMessages(state.aiMsgs.filter((m) => m.ts > t).map((m) => ({
    id: m.id, text: m.text, from: m.from === "me" ? state.me.uid : "ai",
    createdAt: { toDate: () => new Date(m.ts), toMillis: () => m.ts }, pending: false,
  })));
}
const AI_JOKES = ["Teacher: Why are you late? Student: Sir, I was dreaming that I had arrived on time 😄", "Doctor: You need rest. Patient: Doctor, so does my phone battery 🔋", "What's the difference between WiFi and a friend? You always remember the WiFi password 😅"];
const AI_SHAYARI = ["A true friend is not the one who gives their life, but the one who stands by you in hard times 🌹", "Some people reach your heart without saying a word, and some never do, even after a lifetime 💙", "Life is short, so laugh through it and make up lovingly with those who are upset ✨"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function aiReply(raw) {
  const q = raw.toLowerCase().trim();
  const has = (...w) => w.some((x) => q.includes(x));
  if (/^[\d\s+\-*/().%^x×÷,]+$/.test(q) && /[+\-*/^x×÷%]/.test(q)) {
    try {
      const expr = q.replace(/[x×]/g, "*").replace(/÷/g, "/").replace(/\^/g, "**").replace(/,/g, "");
      const v = Function(`"use strict"; return (${expr})`)();
      if (Number.isFinite(v)) return `🧮 ${raw} = ${Math.round(v * 1e8) / 1e8}`;
    } catch (_) { /* fall through */ }
  }
  if (has("salam", "hello", "hi", "assalam", "hey")) return "Hello! 😊 How can I help? Type 'help' and I'll list the topics.";
  if (has("contact", "number", "room", "chat shuru")) return "🌐 To chat with a friend: in your room tap 🔗 Send link at the top, or Invite. Your friend opens the link, logs in and joins the same room. New room: ＋ above Chats.";
  if (has("invite", "dost bula", "link")) return "🎁 Tap Invite on the left: copy the link and send it via WhatsApp/Email. Or show 'My QR code' from the ⋮ menu and your friend can scan it to open your chat.";
  if (has("call", "video")) return "📞 Open a chat and tap 📞 (voice) or 📹 (video) at the top. A call card appears in the chat and everyone taps Join. Calls open in a new tab using Jitsi Meet.";
  if (has("group")) return "👥 ⋮ menu → New group. Enter a name, pick members, tap Create. Everyone in the group can send messages.";
  if (has("community")) return "📢 ⋮ menu → New community. Only the admin (you) can send messages and everyone else reads; best for announcements.";
  if (has("status")) return "✨ Tap Status in the sidebar → ＋ → add text or a photo. Friends can see it for 24 hours.";
  if (has("qr")) return "🔳 ⋮ menu → My QR code. When a friend scans it with their phone camera, the link opens and they can start chatting with you.";
  if (has("lock", "pin")) return "🔒 Open a chat → tap 🔓 at the top → create a PIN. The preview of that chat is hidden and the PIN is asked when opening it.";
  if (has("archive")) return "🗂 Open a chat → tap 🗂 at the top. Archived chats are in the 'Archived' chip above Chats.";
  if (has("favourite", "favorite", "fav")) return "⭐ Open a chat → tap ☆. Favourites appear at the top of the list.";
  if (has("delete", "clear", "saaf")) return "🧹 Tap ⋮ at the top of the chat → 'Clear chat' or 'Delete'. This only affects you, not your friend's chat.";
  if (has("voice", "awaz", "mic")) return "🎤 Tap the mic next to the message box, speak, then tap again to send. 🗑 cancels.";
  if (has("joke", "latifa", "hasao")) return "😄 " + pick(AI_JOKES);
  if (has("shayari", "shair", "poetry")) return "📝 " + pick(AI_SHAYARI);
  if (has("time", "waqt", "baje")) return "🕒 It is " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " now.";
  if (has("date", "tareekh", "aaj")) return "📅 Today is " + new Date().toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + ".";
  if (has("help", "madad", "kya kar")) return "I can help with: room/link, invite, group, community, status, QR, lock, archive, favourite, voice, delete/clear, joke, quote, time/date, and calculations (12*7). Ask me anything 🙂";
  if (has("thanks", "shukriya", "thank")) return "You're welcome! 😊";
  return "I didn't understand that 😅 I'm the app's helper. Type 'help' to see what I can do, or try 'joke', 'quote', 'time'.";
}
function aiAsk(text) {
  state.aiMsgs.push({ id: "u" + Date.now(), from: "me", ts: Date.now(), text });
  saveAi();
  renderAiChat();
  renderTyping(true);
  setTimeout(() => {
    state.aiMsgs.push({ id: "a" + Date.now(), from: "ai", ts: Date.now(), text: aiReply(text) });
    saveAi();
    renderTyping(false);
    if (state.active?.isAI) renderAiChat();
  }, 650);
}

/* ===================== Status (24 ghante) ===================== */
const STATUS_BG = ["linear-gradient(135deg,#ff6b6b,#ffb84d)", "linear-gradient(135deg,#2dd4bf,#3b82f6)", "linear-gradient(135deg,#7c5cff,#ec4899)", "linear-gradient(135deg,#22c55e,#14b8a6)", "linear-gradient(135deg,#f97316,#ef4444)", "linear-gradient(135deg,#1e293b,#475569)"];
let stBg = STATUS_BG[0];
let stImage = "";

function subscribeStatuses() {
  state.unsubStatus?.();
  state.unsubStatus = onSnapshot(
    query(collection(db, "statuses"), where("createdAt", ">", new Date(Date.now() - 864e5)), orderBy("createdAt", "asc")),
    (snap) => {
      const cutoff = Date.now() - 864e5;
      state.statuses = snap.docs
        .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .filter((s) => msOf(s.createdAt) > cutoff)
        .filter(canSeeStatus);
      if (state.tab === "status") renderUsers();
      updateStatusDot();
      openDeepStatus();
      refreshViewerStats();
    },
    () => { /* rules na hon to chup rehta hai; groups wali warning kaafi hai */ }
  );
}
function updateStatusDot() {
  const has = state.statuses.some((s) => s.uid !== state.me?.uid);
  $("#tabStatus").classList.toggle("has-new", has);
}
function statusGroups() {
  const m = new Map();
  state.statuses.forEach((s) => { if (!m.has(s.uid)) m.set(s.uid, []); m.get(s.uid).push(s); });
  return m;
}
function renderStatusPane(list) {
  $("#paneTitle").textContent = "Status";
  $("#filterRow").classList.add("hidden");
  const groups = statusGroups();
  $("#paneCount").textContent = groups.size;

  const mine = groups.get(state.me.uid) || [];
  const myRow = document.createElement("div");
  myRow.className = "user enter st-row";
  const av = avatarEl(state.me);
  av.classList.add("ring"); if (!mine.length) av.classList.add("dashed");
  myRow.appendChild(av);
  const mm = document.createElement("div");
  mm.className = "user-meta";
  mm.innerHTML = "<b>My status</b><small></small>";
  mm.querySelector("small").textContent = mine.length ? `${mine.length} update • ${ago(msOf(mine[mine.length - 1].createdAt))} • 👁 ${statTotal(mine, "viewedBy")} • ❤ ${statTotal(mine, "likedBy")}` : "Tap to add a status";
  myRow.appendChild(mm);
  const add = document.createElement("button");
  add.className = "add-btn st-add"; add.textContent = "＋"; add.title = "New status";
  add.addEventListener("click", (e) => { e.stopPropagation(); openStatusModal(); });
  myRow.appendChild(add);
  myRow.addEventListener("click", () => (mine.length ? openViewer(mine) : openStatusModal()));
  list.appendChild(myRow);

  const others = [...groups.entries()].filter(([uid]) => uid !== state.me.uid)
    .sort((a, b) => msOf(b[1][b[1].length - 1].createdAt) - msOf(a[1][a[1].length - 1].createdAt));
  const lab = document.createElement("div");
  lab.className = "st-label";
  lab.textContent = others.length ? "Recent updates" : "No friend statuses yet 🌙";
  list.appendChild(lab);
  others.forEach(([uid, items], idx) => {
    const u = state.users.find((x) => x.uid === uid) || { uid, name: items[0].name, photoURL: items[0].photoURL };
    const row = document.createElement("div");
    row.className = "user enter st-row";
    row.style.setProperty("--i", Math.min(idx, 12));
    const a = avatarEl({ ...u, name: nameOf(u) });
    a.classList.add("ring");
    row.appendChild(a);
    const meta = document.createElement("div");
    meta.className = "user-meta";
    meta.innerHTML = "<b></b><small></small>";
    meta.querySelector("b").textContent = nameOf(u);
    meta.querySelector("small").textContent = `${items.length} update • ${ago(msOf(items[items.length - 1].createdAt))}`;
    row.appendChild(meta);
    row.addEventListener("click", () => openViewer(items));
    list.appendChild(row);
  });
}

function openStatusModal() {
  stImage = "";
  $("#stText").value = "";
  $("#stError").textContent = "";
  $("#stImgName").textContent = "";
  stBg = STATUS_BG[0];
  $("#stAudience").value = "all";
  buildAudiencePick();
  paintStatusPreview();
  show($("#statusModal"));
  setTimeout(() => $("#stText").focus(), 60);
}
function paintStatusPreview() {
  const p = $("#stPreview");
  p.style.background = stImage ? `center/cover url("${stImage}")` : stBg;
  p.textContent = $("#stText").value || (stImage ? "" : "Write something…");
  document.querySelectorAll("#stColors i").forEach((i) => i.classList.toggle("on", i.dataset.bg === stBg));
}
(function buildStatusColors() {
  const box = $("#stColors");
  STATUS_BG.forEach((bg) => {
    const i = document.createElement("i");
    i.dataset.bg = bg; i.style.background = bg;
    i.addEventListener("click", () => { stBg = bg; stImage = ""; paintStatusPreview(); });
    box.appendChild(i);
  });
})();
$("#stText").addEventListener("input", paintStatusPreview);
$("#stClose").addEventListener("click", () => hide($("#statusModal")));
$("#stPhotoBtn").addEventListener("click", () => $("#stFile").click());
$("#stFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !f.type.startsWith("image/")) return;
  $("#stImgName").textContent = "📤 uploading…";
  try { stImage = await uploadMedia(f, "image"); $("#stImgName").textContent = "✅ photo added"; paintStatusPreview(); }
  catch (err) { $("#stImgName").textContent = ""; $("#stError").textContent = err.message || "Photo could not be uploaded."; }
});
$("#stPost").addEventListener("click", async () => {
  const text = $("#stText").value.trim();
  if (!text && !stImage) { $("#stError").textContent = "Write something or add a photo."; return; }
  const aud = audienceFields();
  if (aud.error) { $("#stError").textContent = aud.error; return; }
  const btn = $("#stPost");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "statuses"), {
      uid: state.me.uid, name: state.me.name, photoURL: state.me.photoURL || "",
      text, imageUrl: stImage, bg: stBg, viewedBy: [], likedBy: [], ...aud, createdAt: serverTimestamp(),
    });
    hide($("#statusModal"));
    toast("✨ Status posted, visible for 24 hours");
  } catch (err) {
    $("#stError").textContent = err?.code === "permission-denied" ? "Add the statuses section to Firestore Rules (RULES.txt)." : friendlyError(err);
  } finally { btn.disabled = false; }
});

/* status privacy: who can see it */
function canSeeStatus(s) { return s.uid === state.me?.uid || !s.allowed || s.allowed.includes(state.me?.uid); }
function buildAudiencePick() {
  const box = $("#stPick");
  box.innerHTML = "";
  hide(box);
  state.users.filter((u) => u.uid !== state.me.uid).forEach((u) => {
    const l = document.createElement("label");
    l.className = "pick-row";
    l.innerHTML = '<input type="checkbox"><span></span>';
    l.querySelector("input").value = u.uid;
    l.querySelector("span").textContent = nameOf(u);
    box.appendChild(l);
  });
  if (!box.children.length) { const e = document.createElement("div"); e.className = "svl-e"; e.textContent = "No other users yet."; box.appendChild(e); }
}
$("#stAudience").addEventListener("change", () => {
  const m = $("#stAudience").value;
  $("#stPick").classList.toggle("hidden", !(m === "only" || m === "except"));
  $("#stAudHint").textContent = m === "fav" ? "Only people you marked ⭐ as favourite can see it." : m === "only" ? "Tick the people who can see it." : m === "except" ? "Tick the people who should NOT see it." : "All your contacts can see it.";
});
function audienceFields() {
  const mode = $("#stAudience").value;
  const others = state.users.filter((u) => u.uid !== state.me.uid).map((u) => u.uid);
  const picked = [...document.querySelectorAll("#stPick input:checked")].map((i) => i.value);
  if (mode === "fav") { const a = others.filter(isFav); return a.length ? { audience: "fav", allowed: a } : { error: "You have no favourite contacts yet. Open a chat and tap ☆ first." }; }
  if (mode === "only") return picked.length ? { audience: "only", allowed: picked } : { error: "Tick at least one person." };
  if (mode === "except") return { audience: "except", allowed: others.filter((u) => !picked.includes(u)) };
  return { audience: "all", allowed: null };
}
const audLabel = (s) => (s.audience === "fav" ? "⭐ Favourites" : s.audience === "only" ? `🔒 ${(s.allowed || []).length} people` : s.audience === "except" ? "🔒 Hidden from some" : "🌐 Everyone");

/* status viewer */
let view = { items: [], i: 0, timer: null };
function openViewer(items) {
  view = { items, i: 0, timer: null };
  show($("#statusViewer"));
  showStatusItem();
}
function closeViewer() { clearTimeout(view.timer); hide($("#statusViewer")); hide($("#svList")); }
const statTotal = (items, k) => items.reduce((n, s) => n + ((s[k] || []).filter((u) => u !== s.uid).length), 0);
const viewedOnce = new Set();
const whoName = (uid) => (uid === state.me.uid ? "You" : nameOf(state.users.find((x) => x.uid === uid) || { name: "Someone" }));
const statusLink = (id) => location.origin + location.pathname.replace(/index\.html$/, "") + "?status=" + encodeURIComponent(id);

function paintViewerStats() {
  const s = view.items[view.i];
  if (!s) return;
  const mineS = s.uid === state.me.uid;
  const views = (s.viewedBy || []).filter((u) => u !== s.uid);
  const likes = s.likedBy || [];
  const liked = likes.includes(state.me.uid);
  $("#svLike").classList.toggle("on", liked);
  $("#svLike").textContent = (liked ? "❤️ " : "🤍 ") + likes.length;
  $("#svStats").textContent = mineS ? `👁 ${views.length} seen • ❤ ${likes.length} likes • ${audLabel(s)}` : `👁 ${views.length} seen`;
  $("#svStats").classList.toggle("tap", mineS);
}
function refreshViewerStats() {
  if (!view.items.length || $("#statusViewer").classList.contains("hidden")) return;
  view.items = view.items.map((x) => state.statuses.find((s) => s.id === x.id) || x);
  paintViewerStats();
  if (!$("#svList").classList.contains("hidden")) paintViewerList();
}
function paintViewerList() {
  const s = view.items[view.i];
  const box = $("#svList");
  if (!s) return;
  const views = (s.viewedBy || []).filter((u) => u !== s.uid);
  const likes = s.likedBy || [];
  box.innerHTML = "";
  const h = document.createElement("div");
  h.className = "svl-h"; h.textContent = `👁 Seen by ${views.length} • ❤ ${likes.length} likes`;
  box.appendChild(h);
  if (!views.length && !likes.length) { const e = document.createElement("div"); e.className = "svl-e"; e.textContent = "Nobody has seen this yet."; box.appendChild(e); }
  [...new Set([...views, ...likes])].forEach((uid) => {
    const r = document.createElement("div");
    r.className = "svl-r";
    r.textContent = `${likes.includes(uid) ? "❤️" : "👁"} ${whoName(uid)}`;
    box.appendChild(r);
  });
}
function openDeepStatus() {
  if (!statusDeep || !state.me || state.deepStatusDone) return;
  const s = state.statuses.find((x) => x.id === statusDeep);
  if (!s) return;
  state.deepStatusDone = true;
  try { localStorage.removeItem("gs_status_deep"); } catch (_) { /* ignore */ }
  setTab("status");
  const items = state.statuses.filter((x) => x.uid === s.uid);
  openViewer(items);
  view.i = Math.max(0, items.findIndex((x) => x.id === s.id));
  showStatusItem();
}
function showStatusItem() {
  clearTimeout(view.timer);
  const s = view.items[view.i];
  if (!s) { closeViewer(); return; }
  const bars = $("#svBars");
  bars.innerHTML = "";
  view.items.forEach((_, n) => {
    const b = document.createElement("i");
    if (n < view.i) b.className = "done";
    if (n === view.i) { const f = document.createElement("u"); b.appendChild(f); }
    bars.appendChild(b);
  });
  const stage = $("#svStage");
  stage.style.background = s.imageUrl ? `#000 center/contain no-repeat url("${s.imageUrl}")` : (s.bg || STATUS_BG[0]);
  $("#svText").textContent = s.text || "";
  $("#svName").textContent = s.uid === state.me.uid ? "You" : (nameOf(state.users.find((x) => x.uid === s.uid) || s));
  $("#svTime").textContent = ago(msOf(s.createdAt));
  $("#svDel").classList.toggle("hidden", s.uid !== state.me.uid);
  hide($("#svList"));
  // views: count each person once
  if (s.uid !== state.me.uid && !viewedOnce.has(s.id) && !(s.viewedBy || []).includes(state.me.uid)) {
    viewedOnce.add(s.id);
    updateDoc(doc(db, "statuses", s.id), { viewedBy: arrayUnion(state.me.uid) }).catch(() => {});
    s.viewedBy = [...(s.viewedBy || []), state.me.uid];
  }
  paintViewerStats();
  view.timer = setTimeout(() => { view.i++; showStatusItem(); }, 5000);
}
$("#svNext").addEventListener("click", () => { view.i++; showStatusItem(); });
$("#svPrev").addEventListener("click", () => { view.i = Math.max(0, view.i - 1); showStatusItem(); });
$("#svClose").addEventListener("click", closeViewer);
$("#svLike").addEventListener("click", async () => {
  const s = view.items[view.i];
  if (!s) return;
  clearTimeout(view.timer);                       // pause while interacting
  const liked = (s.likedBy || []).includes(state.me.uid);
  s.likedBy = liked ? s.likedBy.filter((u) => u !== state.me.uid) : [...(s.likedBy || []), state.me.uid];
  paintViewerStats();
  try { await updateDoc(doc(db, "statuses", s.id), { likedBy: liked ? arrayRemove(state.me.uid) : arrayUnion(state.me.uid) }); }
  catch (err) { toast(friendlyError(err)); }
});
$("#svStats").addEventListener("click", () => {
  const s = view.items[view.i];
  if (!s || s.uid !== state.me.uid) return;
  clearTimeout(view.timer);
  const box = $("#svList");
  if (box.classList.contains("hidden")) { paintViewerList(); show(box); } else hide(box);
});
$("#svShare").addEventListener("click", async () => {
  const s = view.items[view.i];
  if (!s) return;
  clearTimeout(view.timer);
  const link = statusLink(s.id);
  try { if (navigator.share) { await navigator.share({ title: "Glide-Chat status", text: "Watch my status on Glide-Chat", url: link }); return; } } catch (_) { /* cancelled */ }
  try { await navigator.clipboard.writeText(link); toast("Status link copied ✅"); }
  catch (_) { prompt("Copy this status link:", link); }
});
$("#svDel").addEventListener("click", async () => {
  const s = view.items[view.i];
  if (!s || !confirm("Delete this status?")) return;
  try { await deleteDoc(doc(db, "statuses", s.id)); toast("Status deleted"); } catch (err) { toast(friendlyError(err)); }
  closeViewer();
});

/* ===================== QR code ===================== */
function loadQrLib() {
  return new Promise((res) => {
    if (window.QRCode) { res(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = () => res(!!window.QRCode);
    s.onerror = () => res(false);
    document.head.appendChild(s);
  });
}
async function openQr() {
  const link = inviteLink();
  $("#qrLink").value = link;
  $("#qrName").textContent = state.me.name;
  const box = $("#qrBox");
  box.innerHTML = "";
  show($("#qrModal"));
  const ok = await loadQrLib();
  if (ok) new window.QRCode(box, { text: link, width: 210, height: 210, colorDark: "#1a1033", colorLight: "#ffffff" });
  else {
    const img = document.createElement("img");
    img.width = 210; img.height = 210; img.alt = "QR";
    img.src = "https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=0&data=" + encodeURIComponent(link);
    box.appendChild(img);
  }
}
$("#qrClose").addEventListener("click", () => hide($("#qrModal")));
$("#qrCopy").addEventListener("click", async () => { toast((await copyText($("#qrLink").value)) ? "Link copied ✅" : "Could not copy the link"); });
$("#qrShare").addEventListener("click", () => {
  if (navigator.share) navigator.share({ title: "Glide-Chat", text: "Chat with me on Glide-Chat 💬", url: $("#qrLink").value }).catch(() => {});
  else window.open("https://wa.me/?text=" + encodeURIComponent("Chat with me on Glide-Chat 💬 " + $("#qrLink").value), "_blank", "noopener");
});

/* ===================== Settings + Help ===================== */
function openSettings() {
  $("#setName").value = state.me.name;
  $("#setPhoneVal").textContent = state.me.phone || "not added";
  $("#setSoundVal").textContent = state.prefs.sound === false ? "Off" : "On";
  show($("#settingsModal"));
}
$("#settingsClose").addEventListener("click", () => hide($("#settingsModal")));
$("#helpClose").addEventListener("click", () => hide($("#helpModal")));
$("#setHelp").addEventListener("click", () => { hide($("#settingsModal")); show($("#helpModal")); });
$("#setQr").addEventListener("click", () => { hide($("#settingsModal")); openQr(); });
$("#setPhone").addEventListener("click", () => { hide($("#settingsModal")); openPhoneModal(); });
$("#setSound").addEventListener("click", () => {
  state.prefs.sound = state.prefs.sound === false;
  savePrefs();
  $("#setSoundVal").textContent = state.prefs.sound === false ? "Off" : "On";
  if (state.prefs.sound !== false) playBeep();
});
$("#setFav").addEventListener("click", () => { hide($("#settingsModal")); $("#paneMenu").querySelector('[data-act="fav"]').click(); });
$("#setArch").addEventListener("click", () => { hide($("#settingsModal")); $("#paneMenu").querySelector('[data-act="arch"]').click(); });
$("#setNameSave").addEventListener("click", async () => {
  const n = $("#setName").value.trim();
  if (n.length < 2) { toast("Name must be at least 2 characters."); return; }
  try {
    await updateProfile(auth.currentUser, { displayName: n });
    await setDoc(doc(db, "users", state.me.uid), { name: n }, { merge: true });
    state.me.name = n;
    $("#meName").textContent = n;
    toast("✅ Name updated");
  } catch (err) { toast(friendlyError(err)); }
});
$("#setPin").addEventListener("click", async () => {
  if (!state.prefs.pin) { toast("No PIN yet. Tap 🔓 on a chat to lock it first."); return; }
  if (!(await verifyPin("🔒 Enter the old PIN"))) return;
  const a = await askPin("🔒 New PIN");
  if (!a) return;
  state.prefs.pin = await hashPin(a);
  savePrefs();
  toast("PIN changed ✅");
});
$("#setClearAll").addEventListener("click", () => {
  if (!confirm("Clear all messages in all chats for you? (your friend's side will not change)")) return;
  const now = Date.now();
  [...state.users, ...state.groupUsers, AI_USER].forEach((u) => { state.prefs.cleared[u.uid] = now; });
  state.aiMsgs = []; saveAi();
  savePrefs();
  if (state.active) openChat(state.active);
  renderUsers();
  hide($("#settingsModal"));
  toast("🧹 All messages cleared");
});
$("#setReset").addEventListener("click", async () => {
  try { await sendPasswordResetEmail(auth, auth.currentUser.email); toast("📧 Password reset email sent (also check your spam folder)."); }
  catch (err) { toast(friendlyError(err)); }
});
$("#setLogout").addEventListener("click", () => { hide($("#settingsModal")); $("#logoutBtn").click(); });

/* ----- Status tab button ----- */
$("#tabStatus").addEventListener("click", () => setTab("status"));
$("#settingsBtn").addEventListener("click", openSettings);


/* ===================== Open rooms (sirf code se real-time chat) ===================== */
const CONNECT_HELP = "⚠️ No response from the server. Check: 1) Is your internet working? 2) Is a <b>Firestore Database</b> created in Firebase? 3) Did you paste the <b>RULES.txt</b> text into Rules and <b>Publish</b> it? Then tap 🩺 Connection check.";
function chatBanner(html) {
  const b = $("#chatBanner");
  if (!html) { hide(b); return; }
  b.innerHTML = html;
  show(b);
}
const ROOMS_KEY = () => `gs_rooms_${state.me.uid}`;
const cleanRoom = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
const roomUser = (room) => ({ uid: "r:" + room, room, name: "# " + room, isGroup: true, isRoom: true, members: [], type: "room" });
function syncRoomListeners() {
  state.roomUnsubs = state.roomUnsubs || {};
  const want = new Set(state.roomUsers.map((r) => r.room));
  Object.keys(state.roomUnsubs).forEach((r) => {
    if (!want.has(r)) { state.roomUnsubs[r](); delete state.roomUnsubs[r]; delete state.chatMeta["r:" + r]; }
  });
  state.roomUsers.forEach((r) => {
    if (state.roomUnsubs[r.room]) return;
    let first = true;
    state.roomUnsubs[r.room] = onSnapshot(
      query(collection(db, "rooms", r.room, "messages"), orderBy("createdAt", "desc"), limit(1)),
      (snap) => {
        const key = "r:" + r.room;
        const prev = state.chatMeta[key] || { lastText: "", lastFrom: "", lastAt: 0, unread: 0 };
        const d = snap.docs[0]?.data({ serverTimestamps: "estimate" });
        if (!d) { state.chatMeta[key] = prev; first = false; return; }
        const at = msOf(d.createdAt);
        const text = lastLabelOf(d);
        const mine = d.from === state.me.uid;
        const open = state.active?.uid === key && document.visibilityState === "visible";
        let unread = prev.unread;
        if (!first && at > prev.lastAt && !mine && !open) {
          unread++;
          playBeep();
          toast(`🌐 ${r.room} • ${d.fromName || ""}: ${text.slice(0, 50)}`);
        }
        state.chatMeta[key] = { lastText: (mine ? "" : (d.fromName ? d.fromName + ": " : "")) + text, lastFrom: d.from || "", lastAt: at, unread };
        first = false;
        renderUsers();
        updateTitleBadge();
      },
      () => { /* error chat kholne par banner mein dikhta hai */ }
    );
  });
}
function loadRooms() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(ROOMS_KEY()) || "[]"); } catch (_) { /* ignore */ }
  state.roomUsers = list.map(roomUser);
  syncRoomListeners();
}
function saveRooms() {
  try { localStorage.setItem(ROOMS_KEY(), JSON.stringify(state.roomUsers.map((r) => r.room))); } catch (_) { /* ignore */ }
  syncRoomListeners();
  renderUsers();
}
function joinRoom(raw) {
  const room = cleanRoom(raw);
  if (room.length < 3) { toast("Room code must be at least 3 letters/digits (a-z, 0-9)."); return false; }
  let ru = state.roomUsers.find((r) => r.room === room);
  if (!ru) { ru = roomUser(room); state.roomUsers.unshift(ru); saveRooms(); }
  setTab("all");
  openChat(ru);
  toast(`🌐 You joined room "${room}". Send this code to your friend.`);
  return true;
}
function openRoomModal() {
  $("#roomCode").value = "";
  $("#roomError").textContent = "";
  show($("#roomModal"));
  setTimeout(() => $("#roomCode").focus(), 60);
}
$("#roomClose").addEventListener("click", () => hide($("#roomModal")));
$("#roomRandom").addEventListener("click", () => {
  const a = (state.me?.name || "room").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "room";
  $("#roomCode").value = a + "-" + Math.floor(1000 + Math.random() * 9000);
});
$("#roomForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (joinRoom($("#roomCode").value)) hide($("#roomModal"));
  else $("#roomError").textContent = "Code must be at least 3 letters/digits (a-z, 0-9, - or _).";
});
async function shareRoom() {
  $("#headMenu").classList.add("hidden");
  const u = state.active;
  if (!u?.isRoom) return;
  const link = roomLinkFor(u.room);
  const text = `Chat with me on Glide-Chat 💬 Room code: ${u.room}\n${link}`;
  if (navigator.share) { try { await navigator.share({ title: "Glide-Chat", text, url: link }); return; } catch (_) { /* cancel */ } }
  toast((await copyText(link)) ? "Room link copied ✅ Send it to a friend" : "Code: " + u.room);
}
$("#mShare").addEventListener("click", shareRoom);
$("#headInvite").addEventListener("click", shareRoom);

/* ===================== invite friends ===================== */
function roomLinkFor(room) {
  return location.origin + location.pathname.replace(/index\.html$/, "") + "?room=" + encodeURIComponent(room);
}
function inviteLink() {
  const base = location.origin + location.pathname.replace(/index\.html$/, "");
  const r = state.active?.isRoom ? state.active : state.roomUsers?.[0];
  return r ? roomLinkFor(r.room) : base;        // link kholne wala login karke seedha is room mein aata hai
}
function inviteText() {
  return `Hi! Join Glide-Chat with this link, log in / sign up and we can all chat in real time 💬 ${inviteLink()}`;
}

function sendInviteToNumber(rawPhone) {
  const p = normalizePhone(rawPhone);
  if (!p) { toast("Number is not valid. Example: 03001234567"); return false; }
  const digits = p.replace(/\D/g, "");
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(inviteText())}`, "_blank", "noopener");
  return true;
}

function openInvite() {
  const link = inviteLink();
  $("#inviteLink").value = link;
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) || location.protocol === "file:";
  $("#inviteWarn").classList.toggle("hidden", !isLocal);
  const text = encodeURIComponent(inviteText());
  $("#shareWa").href = `https://wa.me/?text=${text}`;
  $("#shareMail").href = `mailto:?subject=${encodeURIComponent("Join us on Glide-Chat!")}&body=${text}`;
  $("#shareNative").classList.toggle("hidden", !navigator.share);
  $("#invPhone").value = "";
  show($("#inviteModal"));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const el = $("#inviteLink");
    el.select();
    el.setSelectionRange(0, 99999);
    try { return document.execCommand("copy"); } catch (_2) { return false; }
  }
}

$("#inviteBtn").addEventListener("click", openInvite);
$("#inviteCta").addEventListener("click", openInvite);
$("#inviteClose").addEventListener("click", () => hide($("#inviteModal")));
$("#inviteModal").addEventListener("click", (e) => { if (e.target.id === "inviteModal") hide($("#inviteModal")); });

$("#copyInvite").addEventListener("click", async () => {
  const ok = await copyText($("#inviteLink").value);
  toast(ok ? "Link copied ✅ Now send it to a friend" : "Copy failed, please select the link and copy it manually.");
});
$("#shareNative").addEventListener("click", async () => {
  try { await navigator.share({ title: "Glide-Chat", text: "Join Glide-Chat and chat in real time 💬", url: inviteLink() }); }
  catch (_) { /* user ne cancel kar diya */ }
});
$("#invSend").addEventListener("click", () => {
  if (sendInviteToNumber($("#invPhone").value.trim())) toast("Opening WhatsApp… send the message 📨");
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hide($("#inviteModal"));
  hide($("#contactModal"));
});

/* ===================== connection check ===================== */
$("#diagBtn").addEventListener("click", async () => {
  if (!state.me) return;
  toast("🩺 Checking…");
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 7000));
  try {
    await Promise.race([
      updateDoc(doc(db, "users", state.me.uid), { ping: serverTimestamp() }),
      timeout,
    ]);
    toast("✅ Firestore is working. For messages, both people must see each other in the list (a badge / alert will appear).");
  } catch (err) {
    toast(err.message === "timeout"
      ? "❌ Cannot reach the server: check your internet and make sure a Firestore Database exists in Firebase."
      : "❌ " + friendlyError(err));
  }
});

/* ===================== setup warning ===================== */
if (!firebaseReady) {
  console.warn("Set your Firebase keys in config.js.");
}


/* ===================== voice player ===================== */
let vpCurrent = null;
function buildVoicePlayer(url, secs) {
  const w = document.createElement("div"); w.className = "vp";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "vp-btn"; btn.textContent = "▶";
  const bar = document.createElement("div"); bar.className = "vp-wave";
  let seed = 0; for (let i = 0; i < Math.min(url.length, 400); i += 7) seed = (seed * 31 + url.charCodeAt(i)) % 9973;
  const N = 30, bars = [];
  for (let i = 0; i < N; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const s = document.createElement("i");
    s.style.height = (5 + Math.round((seed / 233280) * 17)) + "px";
    bar.appendChild(s); bars.push(s);
  }
  const tm = document.createElement("span"); tm.className = "vp-time"; tm.textContent = fmtSec(Math.round(secs || 0));
  const sp = document.createElement("button"); sp.type = "button"; sp.className = "vp-speed"; sp.textContent = "1×";
  w.append(btn, bar, tm, sp);
  const speeds = [1, 1.5, 2]; let si = 0, au = null;
  const dur = () => (au && isFinite(au.duration) && au.duration > 0 ? au.duration : (secs || 0));
  const prog = (r) => { const n = Math.round(r * N); bars.forEach((b, i) => b.classList.toggle("on", i < n)); };
  const ensure = () => {
    if (au) return au;
    au = new Audio(); au.preload = "auto"; au.src = url;
    au.addEventListener("timeupdate", () => { prog(Math.min(1, au.currentTime / (dur() || 1))); tm.textContent = fmtSec(Math.round(au.currentTime)); });
    au.addEventListener("pause", () => { if (!au.ended) { btn.textContent = "▶"; w.classList.remove("playing"); } });
    au.addEventListener("ended", () => { btn.textContent = "▶"; w.classList.remove("playing"); prog(0); tm.textContent = fmtSec(Math.round(secs || 0)); if (vpCurrent === au) vpCurrent = null; });
    au.addEventListener("error", () => { btn.textContent = "⚠️"; tm.textContent = "can't play"; });
    return au;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = ensure();
    if (a.paused) {
      if (vpCurrent && vpCurrent !== a) vpCurrent.pause();
      vpCurrent = a; a.playbackRate = speeds[si];
      a.play().then(() => { btn.textContent = "⏸"; w.classList.add("playing"); }).catch(() => { btn.textContent = "⚠️"; tm.textContent = "can't play"; });
    } else a.pause();
  });
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = ensure(); const r = bar.getBoundingClientRect(); const d = dur();
    if (d) a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
  });
  sp.addEventListener("click", (e) => { e.stopPropagation(); si = (si + 1) % speeds.length; sp.textContent = speeds[si] + "×"; if (au) au.playbackRate = speeds[si]; });
  return w;
}

/* ===================== reactions, reply, copy, delete ===================== */
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
function msgBase() {
  const a = state.active;
  return a.isRoom ? ["rooms", a.room] : a.isGroup ? ["groups", a.gid] : ["chats", chatIdOf(state.me.uid, a.uid)];
}
async function reactTo(m, emoji) {
  const next = { ...(m.reactions || {}) };
  if (next[state.me.uid] === emoji) delete next[state.me.uid];
  else { next[state.me.uid] = emoji; if (emoji === "🎉") confettiBurst(); else emojiBurst(emoji, 12); }
  try { await updateDoc(doc(db, ...msgBase(), "messages", m.id), { reactions: next }); }
  catch (err) { toast(friendlyError(err)); }
}
function buildReactChips(m) {
  const rx = m.reactions || {};
  const groups = {};
  Object.entries(rx).forEach(([u, e]) => { (groups[e] = groups[e] || []).push(u); });
  const keys = Object.keys(groups);
  if (!keys.length) return null;
  const row = document.createElement("div");
  row.className = "reacts";
  keys.forEach((e) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "react-chip" + (groups[e].includes(state.me.uid) ? " mine" : "");
    b.textContent = groups[e].length > 1 ? `${e} ${groups[e].length}` : e;
    b.title = groups[e].map((u) => (u === state.me.uid ? "You" : nameOf(state.users.find((x) => x.uid === u) || { name: "Someone" }))).join(", ");
    b.addEventListener("click", (ev) => { ev.stopPropagation(); reactTo(m, e); });
    row.appendChild(b);
  });
  return row;
}
function buildMsgMenu(m, mine) {
  const menu = document.createElement("div");
  menu.className = "msg-menu " + (mine ? "mine" : "theirs");
  menu.dataset.id = m.id;
  const emo = document.createElement("div"); emo.className = "mm-emojis";
  REACTIONS.forEach((e) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = e;
    if ((m.reactions || {})[state.me.uid] === e) b.className = "on";
    b.addEventListener("click", (ev) => { ev.stopPropagation(); state.menuMsgId = null; reactTo(m, e); });
    emo.appendChild(b);
  });
  menu.appendChild(emo);
  const acts = document.createElement("div"); acts.className = "mm-acts";
  const add = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", (ev) => { ev.stopPropagation(); state.menuMsgId = null; fn(); document.querySelectorAll(".msg-menu").forEach((x) => x.remove()); }); acts.appendChild(b); };
  add("↩ Reply", () => setReply(m));
  if (m.text) add("📋 Copy", async () => { try { await navigator.clipboard.writeText(m.text); toast("Copied ✅"); } catch (_) { toast("Could not copy"); } });
  if (m.from === state.me.uid) add("🗑 Delete", async () => {
    if (!confirm("Delete this message for everyone?")) return;
    try { await deleteDoc(doc(db, ...msgBase(), "messages", m.id)); } catch (err) { toast(friendlyError(err)); }
  });
  menu.appendChild(acts);
  return menu;
}
function toggleMsgMenu(m, el) {
  const box = $("#messages");
  const old = box.querySelector(".msg-menu");
  const same = old && old.dataset.id === m.id;
  old?.remove();
  if (same) { state.menuMsgId = null; return; }
  state.menuMsgId = m.id;
  el.after(buildMsgMenu(m, el.classList.contains("mine")));
  const mn = box.querySelector(".msg-menu"); mn?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function previewOf(m) { return lastLabelOf(m).slice(0, 90); }
function buildQuote(r) {
  const q = document.createElement("div");
  q.className = "reply-quote";
  const b = document.createElement("b"); b.textContent = r.name || "";
  const s = document.createElement("span"); s.textContent = r.text || "";
  q.append(b, s);
  q.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const t = [...document.querySelectorAll("#messages .msg")].find((x) => x.dataset.mid === r.id);
    if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1200); }
  });
  return q;
}
function setReply(m) {
  const name = m.from === state.me.uid ? "You" : (m.fromName || nameOf(state.active));
  state.reply = { id: m.id, name, text: previewOf(m), chat: state.active.uid };
  paintReply();
  $("#msgInput").focus();
}
function takeReply() {
  const r = state.reply;
  state.reply = null; paintReply();
  return r && r.chat === state.active?.uid ? { replyTo: { id: r.id, name: r.name, text: r.text } } : {};
}
function paintReply() {
  const r = state.reply;
  const ok = r && state.active && r.chat === state.active.uid;
  $("#replyBar").classList.toggle("hidden", !ok);
  if (ok) { $("#replyName").textContent = r.name; $("#replyText").textContent = r.text; }
}
$("#replyX").addEventListener("click", () => { state.reply = null; paintReply(); });


/* ===================== v17: effects, polls, stickers, location, search, themes ===================== */
const lastLabelOf = (d) => d.text || (d.call ? (d.call.video ? "📹 Video call" : "📞 Voice call") : d.poll ? "📊 Poll" : d.sticker ? d.sticker + " Sticker" : d.location ? "📍 Location" : d.audioUrl ? "🎤 Voice message" : "📷 Photo");
const CELEBRATE = /🎉|🥳|congrat|happy birthday|mubarak|eid mubarak|well done/i;
const celebrated = new Set();

/* --- effects --- */
function fxLayer() {
  let l = document.getElementById("fx");
  if (!l) { l = document.createElement("div"); l.id = "fx"; document.body.appendChild(l); }
  return l;
}
function confettiBurst() {
  const l = fxLayer();
  const colors = ["#ff6b6b", "#ffc46b", "#2dd4bf", "#8b5cf6", "#38bdf8", "#f472b6", "#a3e635"];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("i");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.setProperty("--dx", (Math.random() * 200 - 100) + "px");
    c.style.setProperty("--rot", (Math.random() * 900 - 450) + "deg");
    c.style.animationDuration = (1.8 + Math.random() * 1.6) + "s";
    c.style.animationDelay = Math.random() * 0.5 + "s";
    c.style.width = (6 + Math.random() * 6) + "px"; c.style.height = (8 + Math.random() * 8) + "px";
    l.appendChild(c);
    setTimeout(() => c.remove(), 4200);
  }
}
function emojiBurst(emoji, n = 12) {
  const l = fxLayer();
  for (let i = 0; i < n; i++) {
    const e = document.createElement("span");
    e.className = "float-emoji";
    e.textContent = emoji;
    e.style.left = (15 + Math.random() * 70) + "vw";
    e.style.fontSize = (22 + Math.random() * 26) + "px";
    e.style.setProperty("--dx", (Math.random() * 120 - 60) + "px");
    e.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
    e.style.animationDelay = Math.random() * 0.4 + "s";
    l.appendChild(e);
    setTimeout(() => e.remove(), 3600);
  }
}
function showSplash(name) {
  const s = document.createElement("div");
  s.className = "splash";
  s.innerHTML = '<div class="sp-logo">G</div><div class="sp-name">Glide-Chat</div><div class="sp-hi"></div>';
  s.querySelector(".sp-hi").textContent = "Welcome, " + name + " 👋";
  document.body.appendChild(s);
  setTimeout(() => s.classList.add("out"), 1300);
  setTimeout(() => s.remove(), 1900);
}

/* --- appearance: accent theme + chat wallpaper --- */
const THEMES = {
  sunset: { name: "Sunset", sun: "linear-gradient(135deg,#ff6b6b 0%,#ff9a5a 55%,#ffc46b 100%)", o: ["#ff6b6b", "#2dd4bf", "#8b5cf6"] },
  ocean:  { name: "Ocean",  sun: "linear-gradient(135deg,#38bdf8 0%,#818cf8 55%,#c4b5fd 100%)", o: ["#38bdf8", "#6366f1", "#22d3ee"] },
  forest: { name: "Forest", sun: "linear-gradient(135deg,#34d399 0%,#86efac 55%,#d9f99d 100%)", o: ["#34d399", "#a3e635", "#14b8a6"] },
  violet: { name: "Violet", sun: "linear-gradient(135deg,#c084fc 0%,#f0abfc 55%,#fbcfe8 100%)", o: ["#c084fc", "#f472b6", "#818cf8"] },
  rose:   { name: "Rose",   sun: "linear-gradient(135deg,#fb7185 0%,#fda4af 55%,#fecdd3 100%)", o: ["#fb7185", "#f59e0b", "#e879f9"] },
};
const WALLS = { dots: "Dots", plain: "Plain", aurora: "Aurora", stars: "Stars" };
function applyAppearance() {
  const app = $("#app");
  const th = THEMES[state.prefs?.theme] || THEMES.sunset;
  [app, document.documentElement].forEach((el) => {          // modals live outside #app, so set it on :root too
    el.style.setProperty("--sun", th.sun);
    th.o.forEach((c, i) => el.style.setProperty("--o" + (i + 1), c));
  });
  Object.keys(WALLS).forEach((w) => app.classList.toggle("wp-" + w, (state.prefs?.wall || "dots") === w));
  document.querySelectorAll("#setThemes .sw").forEach((b) => b.classList.toggle("on", b.dataset.k === (state.prefs?.theme || "sunset")));
  document.querySelectorAll("#setWalls .chip").forEach((b) => b.classList.toggle("active", b.dataset.k === (state.prefs?.wall || "dots")));
}
(function buildAppearanceUI() {
  const tb = $("#setThemes"), wb = $("#setWalls");
  Object.entries(THEMES).forEach(([k, v]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "sw"; b.dataset.k = k; b.title = v.name; b.style.background = v.sun;
    b.addEventListener("click", () => { state.prefs.theme = k; savePrefs(); applyAppearance(); emojiBurst("✨", 6); });
    tb.appendChild(b);
  });
  Object.entries(WALLS).forEach(([k, n]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.dataset.k = k; b.textContent = n;
    b.addEventListener("click", () => { state.prefs.wall = k; savePrefs(); applyAppearance(); });
    wb.appendChild(b);
  });
})();

/* --- plus menu (poll / stickers / location / search / photo) --- */
$("#plusBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#plusMenu").classList.toggle("hidden"); hide($("#emojiPanel")); });
document.addEventListener("click", (e) => { if (!e.target.closest("#plusMenu,#plusBtn")) hide($("#plusMenu")); });
$("#plusMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-p]");
  if (!b) return;
  hide($("#plusMenu"));
  const k = b.dataset.p;
  if (k === "search") { toggleChatSearch(true); return; }
  if (state.active?.isAI) { toast("🤖 Open a real chat to use this."); return; }
  if (k === "photo") $("#attachBtn").click();
  else if (k === "poll") openPollModal();
  else if (k === "sticker") openStickers();
  else if (k === "loc") sendLocation();
});

/* --- stickers --- */
const STICKERS = ["🥳", "😎", "😂", "❤️", "🔥", "👏", "🙏", "😍", "🤩", "😭", "😴", "🤝", "🎉", "💯", "🚀", "🌈", "🐱", "🐶", "🦄", "🍕", "☕", "⚽", "🎁", "🏆"];
function openStickers() {
  const panel = $("#emojiPanel");
  panel.innerHTML = "";
  panel.classList.add("stickers");
  STICKERS.forEach((s) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = s;
    b.addEventListener("click", async () => {
      hide(panel);
      try { await sendMessage({ extra: { sticker: s } }); emojiBurst(s, 8); } catch (err) { toast(friendlyError(err)); }
    });
    panel.appendChild(b);
  });
  show(panel);
}
$("#emojiBtn").addEventListener("click", () => {
  const panel = $("#emojiPanel");
  if (panel.classList.contains("stickers")) { panel.classList.remove("stickers"); panel.innerHTML = ""; buildEmojiPanel(); show(panel); }
});

/* --- location --- */
function sendLocation() {
  if (!navigator.geolocation) { toast("Location is not supported in this browser."); return; }
  toast("📍 Getting your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => sendMessage({ extra: { location: { lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5) } } }).catch((err) => toast(friendlyError(err))),
    () => toast("Allow location access to share your location."),
    { timeout: 10000 }
  );
}
function buildLocation(loc) {
  const a = document.createElement("a");
  a.className = "loc-card";
  a.href = `https://www.google.com/maps?q=${encodeURIComponent(loc.lat + "," + loc.lng)}`;
  a.target = "_blank"; a.rel = "noopener";
  a.innerHTML = '<span class="loc-pin">📍</span><span><b>Shared location</b><small>Tap to open in Maps</small></span>';
  a.addEventListener("click", (e) => e.stopPropagation());
  return a;
}

/* --- polls --- */
function openPollModal() {
  $("#pollQ").value = "";
  document.querySelectorAll("#pollOpts input").forEach((i) => { i.value = ""; });
  $("#pollError").textContent = "";
  show($("#pollModal"));
  setTimeout(() => $("#pollQ").focus(), 60);
}
$("#pollClose").addEventListener("click", () => hide($("#pollModal")));
$("#pollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#pollQ").value.trim();
  const options = [...document.querySelectorAll("#pollOpts input")].map((i) => i.value.trim()).filter(Boolean);
  if (!q) { $("#pollError").textContent = "Write a question."; return; }
  if (options.length < 2) { $("#pollError").textContent = "Add at least 2 options."; return; }
  hide($("#pollModal"));
  try { await sendMessage({ extra: { poll: { q, options }, votes: {} } }); }
  catch (err) { toast(friendlyError(err)); }
});
const pollAnimated = new Set();
function buildPoll(m) {
  const box = document.createElement("div");
  box.className = "poll";
  const q = document.createElement("b"); q.className = "poll-q"; q.textContent = "📊 " + m.poll.q;
  box.appendChild(q);
  const votes = m.votes || {};
  const total = Object.keys(votes).length;
  const mineIdx = votes[state.me.uid];
  m.poll.options.forEach((opt, i) => {
    const n = Object.values(votes).filter((v) => v === i).length;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "poll-opt" + (mineIdx === i ? " mine" : "");
    row.innerHTML = '<i class="pf"></i><span class="pl"></span><span class="pc"></span>';
    row.querySelector(".pl").textContent = (mineIdx === i ? "✓ " : "") + opt;
    row.querySelector(".pc").textContent = `${n} • ${pct}%`;
    const fill = row.querySelector(".pf");
    if (pollAnimated.has(m.id)) fill.style.width = pct + "%";
    else { fill.style.width = "0%"; requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct + "%"; })); }
    row.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const next = { ...votes };
      if (next[state.me.uid] === i) delete next[state.me.uid]; else next[state.me.uid] = i;
      try { await updateDoc(doc(db, ...msgBase(), "messages", m.id), { votes: next }); } catch (err) { toast(friendlyError(err)); }
    });
    box.appendChild(row);
  });
  pollAnimated.add(m.id);
  const f = document.createElement("small"); f.className = "poll-total"; f.textContent = `${total} vote${total === 1 ? "" : "s"} • tap to vote`;
  box.appendChild(f);
  return box;
}

/* --- search inside a chat --- */
function toggleChatSearch(on) {
  const bar = $("#chatSearch");
  if (on === undefined) on = bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !on);
  if (on) { $("#csInput").value = ""; $("#csInput").focus(); }
  else { $("#csInput").value = ""; }
  applyChatSearch();
}
function applyChatSearch() {
  const q = $("#csInput").value.trim().toLowerCase();
  const msgs = document.querySelectorAll("#messages .msg");
  let hits = 0;
  msgs.forEach((el) => {
    el.classList.remove("hit", "dim");
    if (!q) return;
    if (el.innerText.toLowerCase().includes(q)) { el.classList.add("hit"); hits++; } else el.classList.add("dim");
  });
  $("#csCount").textContent = q ? `${hits} found` : "";
  if (q && hits) document.querySelector("#messages .msg.hit")?.scrollIntoView({ block: "center", behavior: "smooth" });
}
$("#csInput").addEventListener("input", applyChatSearch);
$("#csClose").addEventListener("click", () => toggleChatSearch(false));

document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelRecordingIfAny(); });


/* ===================== v21: seen ticks (✓✓) + voice / video calls ===================== */
let lastSeenWrite = 0;
function markSeen() {
  const a = state.active;
  if (!a || a.isAI || !state.me || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastSeenWrite < 1500) { clearTimeout(markSeen.t); markSeen.t = setTimeout(markSeen, 1600); return; }
  lastSeenWrite = now;
  setDoc(doc(db, ...msgBase()), { seen: { [state.me.uid]: serverTimestamp() } }, { merge: true }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") markSeen(); });
window.addEventListener("focus", markSeen);

/* Calls use Jitsi Meet (free, no account): a call message is posted in the chat and everyone taps Join. */
function callUrl(c) {
  const cfg = [
    "config.prejoinPageEnabled=false",
    "config.startWithVideoMuted=" + (!c.video),
    "config.startAudioOnly=" + (!c.video),
    "userInfo.displayName=" + encodeURIComponent(JSON.stringify(state.me.name)),
  ];
  return "https://meet.jit.si/" + encodeURIComponent(c.room) + "#" + cfg.join("&");
}
async function startCall(video) {
  const a = state.active;
  if (!a || a.isAI) return;
  const c = { room: "GlideChat-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), video: !!video };
  const w = window.open(callUrl(c), "_blank", "noopener");           // must open inside the click so popups are not blocked
  if (!w) toast("Allow pop-ups for this site to open the call window.");
  try { await sendMessage({ extra: { call: c } }); toast(video ? "📹 Video call started. Others can tap Join in the chat." : "📞 Voice call started. Others can tap Join in the chat."); }
  catch (err) { toast(friendlyError(err)); }
}
$("#callBtn").addEventListener("click", () => startCall(false));
$("#vcallBtn").addEventListener("click", () => startCall(true));
function buildCall(m) {
  const ms = msOf(m.createdAt) || Date.now();
  const live = Date.now() - ms < 15 * 60 * 1000;
  const mine = m.from === state.me.uid;
  const who = mine ? "You" : (m.fromName || nameOf(state.active || { name: "Someone" }));
  const box = document.createElement("div");
  box.className = "call-card" + (live ? "" : " ended");
  box.innerHTML = '<span class="cc-ic"></span><span class="cc-txt"><b></b><small></small></span><button type="button" class="cc-join"></button>';
  box.querySelector(".cc-ic").textContent = m.call.video ? "📹" : "📞";
  box.querySelector("b").textContent = m.call.video ? "Video call" : "Voice call";
  box.querySelector("small").textContent = live ? `Started by ${who}` : `${who} • call ended`;
  const btn = box.querySelector(".cc-join");
  btn.textContent = live ? "Join" : "Ended";
  btn.disabled = !live;
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (!window.open(callUrl(m.call), "_blank", "noopener")) toast("Allow pop-ups for this site to join the call."); });
  return { node: box, live };
}
function ringIncoming(m) {
  toast(`${m.call.video ? "📹" : "📞"} ${m.fromName || nameOf(state.active)} is calling… tap Join`);
  let n = 0;
  const id = setInterval(() => { playBeep(); if (++n >= 4) clearInterval(id); }, 900);
}
