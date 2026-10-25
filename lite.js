// Glide-Chat Lite — login ke baghair real-time chat (Firebase Firestore, aapki config.js use hoti hai)
import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, query, orderBy, limitToLast, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
const show = (e) => e.classList.remove("hidden");
const hide = (e) => e.classList.add("hidden");

let toastTimer;
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ---------- Firebase ---------- */
let db = null;
try {
  if (!firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith("YOUR_")) throw new Error("Firebase keys are missing in config.js.");
  db = getFirestore(initializeApp(firebaseConfig, "lite"));
} catch (e) {
  $("#joinErr").textContent = "⚠️ " + e.message;
}

/* ---------- helpers ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};
const cleanRoom = (s) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
const colorFor = (n) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 75% 68%)`; };
let myId = store.get("gl_id");
if (!myId) { myId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("gl_id", myId); }

/* ---------- state ---------- */
let name = "", room = "", unsub = null, seen = null, unread = 0, sound = store.get("gl_sound") !== "off", firstTimer = null;
$("#soundBtn").textContent = sound ? "🔔" : "🔕";

let audioCtx;
function beep() {
  if (!sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.32);
  } catch (_) { /* ignore */ }
}

function setStatus(kind, text) {
  const s = $("#status");
  s.className = "st " + kind;
  s.textContent = text;
}
function banner(html) {
  const b = $("#banner");
  if (!html) { hide(b); return; }
  b.innerHTML = html;
  show(b);
}

/* ---------- join ---------- */
const params = new URLSearchParams(location.search);
$("#nameIn").value = store.get("gl_name");
$("#roomIn").value = cleanRoom(params.get("room") || store.get("gl_room"));

$("#joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = $("#nameIn").value.trim();
  const r = cleanRoom($("#roomIn").value);
  if (n.length < 2) { $("#joinErr").textContent = "Name must be at least 2 characters."; return; }
  if (r.length < 3) { $("#joinErr").textContent = "Room code must be at least 3 letters/digits (a-z, 0-9)."; return; }
  if (!db) return;
  name = n; room = r;
  store.set("gl_name", n); store.set("gl_room", r);
  $("#joinErr").textContent = "";
  enterRoom();
});

function enterRoom() {
  hide($("#join")); show($("#chat"));
  $("#roomTitle").textContent = "# " + room;
  $("#msgs").innerHTML = '<div class="empty">Loading messages…</div>';
  banner("");
  setStatus("wait", "connecting…");
  seen = null; unread = 0; document.title = "Glide-Chat Lite";
  history.replaceState(null, "", "?room=" + encodeURIComponent(room));

  // 10 second tak pehla jawab na aaye to wajah batao
  clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    if (seen === null) {
      setStatus("bad", "not connected");
      banner("⚠️ No response from the server. Check these 3 things:<br>1) Is your internet working?<br>2) Is a <b>Firestore Database</b> created in Firebase Console?<br>3) Did you paste the <code>RULES_LITE.txt</code> part into <b>Rules</b> and <b>Publish</b>?");
    }
  }, 10000);

  unsub?.();
  unsub = onSnapshot(
    query(collection(db, "liteRooms", room, "messages"), orderBy("createdAt", "asc"), limitToLast(200)),
    { includeMetadataChanges: true },
    (snap) => {
      clearTimeout(firstTimer);
      banner("");
      setStatus(snap.metadata.fromCache && !snap.metadata.hasPendingWrites ? "wait" : "ok",
        snap.metadata.fromCache && !snap.metadata.hasPendingWrites ? "offline / connecting…" : "🟢 live");
      render(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }), pending: d.metadata.hasPendingWrites })));
    },
    (err) => {
      clearTimeout(firstTimer);
      setStatus("bad", "error");
      banner(err.code === "permission-denied"
        ? "🚫 <b>Permission denied</b>: the Lite section is missing from Firestore Rules.<br>Add the <code>RULES_LITE.txt</code> part in Firebase Console → Firestore → <b>Rules</b> and <b>Publish</b>."
        : "⚠️ Error: " + (err.message || err.code));
    }
  );
  setTimeout(() => $("#msgIn").focus(), 80);
}

/* ---------- render ---------- */
function render(msgs) {
  const box = $("#msgs");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  const first = seen === null;
  const prev = seen || new Set();
  box.innerHTML = "";
  if (!msgs.length) {
    box.innerHTML = '<div class="empty">No messages yet 🌙<br>Send the first message!<br>Send this room code to your friend: <b>' + room + "</b></div>";
    seen = new Set();
    return;
  }
  let lastDay = "";
  let incoming = 0;
  msgs.forEach((m) => {
    const d = m.createdAt?.toDate ? m.createdAt.toDate() : new Date();
    const key = d.toDateString();
    if (key !== lastDay) {
      lastDay = key;
      const day = document.createElement("div");
      day.className = "day";
      day.textContent = key === new Date().toDateString() ? "Today" : key === new Date(Date.now() - 864e5).toDateString() ? "Yesterday" : d.toLocaleDateString();
      box.appendChild(day);
    }
    const mine = m.cid === myId;
    const isNew = !first && !prev.has(m.id);
    if (isNew && !mine) incoming++;
    const el = document.createElement("div");
    el.className = "msg " + (mine ? "mine" : "theirs") + (isNew ? " new" : "");
    if (!mine) {
      const w = document.createElement("span");
      w.className = "who"; w.style.color = colorFor(m.name || "?"); w.textContent = m.name || "Unknown";
      el.appendChild(w);
    }
    const t = document.createElement("span");
    t.textContent = m.text;                       // textContent => XSS safe
    el.appendChild(t);
    const tm = document.createElement("span");
    tm.className = "t";
    tm.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (mine ? (m.pending ? " 🕓" : " ✓") : "");
    el.appendChild(tm);
    box.appendChild(el);
  });
  seen = new Set(msgs.map((m) => m.id));
  if (nearBottom || first || msgs[msgs.length - 1].cid === myId) box.scrollTop = box.scrollHeight;
  if (incoming) {
    beep();
    if (document.visibilityState !== "visible") { unread += incoming; document.title = `(${unread}) Glide-Chat Lite`; }
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { unread = 0; document.title = "Glide-Chat Lite"; } });

/* ---------- send ---------- */
$("#msgForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("#msgIn");
  const text = inp.value.trim();
  if (!text || !db) return;
  inp.value = "";
  const sb = $("#sendBtn");
  sb.classList.remove("fly"); void sb.offsetWidth; sb.classList.add("fly");
  const slow = setTimeout(() => toast("⚠️ Message has not reached the server yet (🕓). Check your internet / Rules."), 6000);
  addDoc(collection(db, "liteRooms", room, "messages"), {
    name, text, cid: myId, createdAt: serverTimestamp(),
  }).then(() => clearTimeout(slow)).catch((err) => {
    clearTimeout(slow);
    inp.value = text;
    toast(err.code === "permission-denied" ? "🚫 Add the Lite section to Rules and Publish (RULES_LITE.txt)." : "Message not sent: " + (err.message || err.code));
  });
});

/* ---------- buttons ---------- */
$("#leaveBtn").addEventListener("click", () => {
  unsub?.(); unsub = null; clearTimeout(firstTimer);
  hide($("#chat")); show($("#join"));
  history.replaceState(null, "", location.pathname);
});
$("#soundBtn").addEventListener("click", () => {
  sound = !sound; store.set("gl_sound", sound ? "on" : "off");
  $("#soundBtn").textContent = sound ? "🔔" : "🔕";
  if (sound) beep();
});
$("#shareBtn").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "?room=" + encodeURIComponent(room);
  const text = `Chat with me on Glide-Chat Lite 💬 Room: ${room}\n${link}`;
  if (navigator.share) { try { await navigator.share({ title: "Glide-Chat Lite", text, url: link }); return; } catch (_) { /* cancel */ } }
  try { await navigator.clipboard.writeText(link); toast("Link copied ✅ Send it to a friend"); }
  catch (_) { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener"); }
});

// link se aaye hon (?room=...) to sirf naam poochho
if (params.get("room")) $("#nameIn").focus();
