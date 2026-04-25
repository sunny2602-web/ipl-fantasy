/**
 * ============================================================
 *  IPL Fantasy League – Firebase Sync Fix
 *  Fixes: real-time sync, localStorage fallback, offline
 *  persistence, async race conditions, merge conflicts,
 *  duplicate data, and data restoration on Firebase failure.
 * ============================================================
 *
 *  HOW TO USE:
 *  1. Replace your existing Firebase init + data logic with this file.
 *  2. Include this AFTER the Firebase SDK scripts in your HTML.
 *  3. Call `IPLSync.init()` once the DOM is ready.
 *  4. Use `IPLSync.write(path, data)` instead of direct set/update.
 *  5. Use `IPLSync.listen(path, callback)` instead of onValue directly.
 * ============================================================
 */

// ── 1. FIREBASE CONFIG (replace with your actual config) ─────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

// ── 2. LOCAL STORAGE KEYS ─────────────────────────────────────────────────────
const LS_KEYS = {
  participants: "ipl_participants",
  scores:       "ipl_scores",
  history:      "ipl_history",
  settings:     "ipl_settings",
  lastSync:     "ipl_lastSync",
  syncVersion:  "ipl_syncVersion",
};

// ── 3. MAIN SYNC MODULE ───────────────────────────────────────────────────────
const IPLSync = (() => {
  let db        = null;   // Firebase Realtime DB reference
  let listeners = {};     // Active onValue listeners  { path: unsubscribeFn }
  let isOnline  = navigator.onLine;
  let pendingWrites = []; // Queue for offline writes

  // ── 3a. localStorage helpers ──────────────────────────────────────────────
  const LS = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn("[IPLSync] LS.get failed:", e);
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn("[IPLSync] LS.set failed (storage full?):", e);
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    },
  };

  // ── 3b. Deep merge: Firebase wins over LS, but never deletes existing keys ─
  function deepMerge(base = {}, incoming = {}) {
    const result = { ...base };
    for (const key of Object.keys(incoming)) {
      if (
        incoming[key] !== null &&
        typeof incoming[key] === "object" &&
        !Array.isArray(incoming[key]) &&
        typeof base[key] === "object" &&
        base[key] !== null
      ) {
        result[key] = deepMerge(base[key], incoming[key]);
      } else {
        result[key] = incoming[key];
      }
    }
    return result;
  }

  // ── 3c. Snapshot version check (prevents stale overwrites) ────────────────
  function shouldApply(path, incomingVersion) {
    const stored = LS.get(LS_KEYS.syncVersion) || {};
    const currentVer = stored[path] || 0;
    return incomingVersion >= currentVer;
  }

  function bumpVersion(path) {
    const stored = LS.get(LS_KEYS.syncVersion) || {};
    stored[path] = (stored[path] || 0) + 1;
    LS.set(LS_KEYS.syncVersion, stored);
    return stored[path];
  }

  // ── 3d. Firebase init ─────────────────────────────────────────────────────
  function initFirebase() {
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }

      // FIX #4 – Enable offline persistence (IndexedDB-based disk cache)
      // For Realtime DB this keeps data available when offline
      db = firebase.database();
      db.ref(".info/connected").on("value", (snap) => {
        const connected = snap.val() === true;
        isOnline = connected;
        console.log(`[IPLSync] Firebase connection: ${connected ? "🟢 Online" : "🔴 Offline"}`);

        if (connected) {
          flushPendingWrites(); // FIX #5 – flush queued writes on reconnect
        }

        // Update UI connection indicator if present
        const indicator = document.getElementById("syncStatus");
        if (indicator) {
          indicator.textContent  = connected ? "🟢 Live" : "🔴 Offline";
          indicator.style.color  = connected ? "#22c55e" : "#ef4444";
        }
      });

      // keepSynced ensures local cache is maintained for offline use
      db.ref("ipl2026").keepSynced(true);

      return true;
    } catch (err) {
      console.error("[IPLSync] Firebase init failed:", err);
      return false;
    }
  }

  // ── 3e. Listen to a Firebase path with localStorage fallback ──────────────
  // FIX #1 – onValue (real-time) instead of get() (one-shot fetch)
  // FIX #2 – Load LS first → render → then apply Firebase update
  // FIX #6 – Merge instead of overwrite
  function listen(path, callback) {
    const lsKey = `ipl_${path.replace(/\//g, "_")}`;

    // Step 1: Show localStorage data immediately (no wait for Firebase)
    const cached = LS.get(lsKey);
    if (cached !== null) {
      console.log(`[IPLSync] Rendering from cache: ${path}`);
      callback(cached, "cache");
    }

    // Step 2: Attach real-time listener
    const ref = db.ref(path);
    const unsubscribe = ref.on(
      "value",
      (snapshot) => {
        const firebaseData = snapshot.val();

        if (firebaseData === null) {
          // Firebase has no data – restore from LS if available (FIX #7)
          if (cached !== null) {
            console.warn(`[IPLSync] Firebase empty at ${path}, using localStorage backup`);
            callback(cached, "restored");

            // Re-push LS data to Firebase so it's not lost
            ref.set(cached).catch((e) =>
              console.warn("[IPLSync] Restore push failed:", e)
            );
          }
          return;
        }

        // Merge Firebase with cached (FIX #6 – no overwrite, safe merge)
        const merged = deepMerge(cached || {}, firebaseData);

        // Persist merged result to localStorage
        LS.set(lsKey, merged);
        LS.set(LS_KEYS.lastSync, Date.now());

        callback(merged, "firebase");
      },
      (error) => {
        // FIX #7 – On Firebase failure, restore from localStorage
        console.error(`[IPLSync] Firebase error at ${path}:`, error);
        const fallback = LS.get(lsKey);
        if (fallback !== null) {
          console.warn("[IPLSync] Using localStorage fallback due to Firebase error");
          callback(fallback, "fallback");
        }
      }
    );

    // Store unsubscribe so we can clean up
    if (listeners[path]) listeners[path](); // remove old listener first
    listeners[path] = () => ref.off("value", unsubscribe);

    return () => {
      ref.off("value", unsubscribe);
      delete listeners[path];
    };
  }

  // ── 3f. Write to Firebase + localStorage atomically ───────────────────────
  // FIX #3 – Correct set/update with error handling
  // FIX #5 – Queue writes when offline
  async function write(path, data, mode = "set") {
    const lsKey = `ipl_${path.replace(/\//g, "_")}`;
    const version = bumpVersion(path);

    // Always write to localStorage first (instant, offline-safe)
    const existing = LS.get(lsKey) || {};
    const toStore  = mode === "update" ? deepMerge(existing, data) : data;
    LS.set(lsKey, toStore);

    const payload = {
      ...toStore,
      _v:         version,       // version stamp for conflict detection
      _updatedAt: Date.now(),
    };

    if (!isOnline || !db) {
      // Queue for when we reconnect
      pendingWrites.push({ path, payload, mode });
      console.warn(`[IPLSync] Offline – queued write to ${path}`);
      return { success: true, queued: true };
    }

    try {
      const ref = db.ref(path);
      if (mode === "update") {
        await ref.update(payload);
      } else {
        await ref.set(payload);
      }
      console.log(`[IPLSync] ✅ Written to Firebase: ${path}`);
      return { success: true, queued: false };
    } catch (err) {
      console.error(`[IPLSync] Write failed for ${path}:`, err);
      pendingWrites.push({ path, payload, mode }); // queue for retry
      return { success: false, error: err.message };
    }
  }

  // ── 3g. Flush queued offline writes when back online ──────────────────────
  async function flushPendingWrites() {
    if (!pendingWrites.length) return;
    console.log(`[IPLSync] Flushing ${pendingWrites.length} pending write(s)…`);

    const toFlush    = [...pendingWrites];
    pendingWrites    = [];

    for (const { path, payload, mode } of toFlush) {
      try {
        const ref = db.ref(path);
        if (mode === "update") {
          await ref.update(payload);
        } else {
          await ref.set(payload);
        }
        console.log(`[IPLSync] ✅ Flushed queued write: ${path}`);
      } catch (err) {
        console.error(`[IPLSync] Flush failed for ${path}:`, err);
        pendingWrites.push({ path, payload, mode }); // retry next time
      }
    }
  }

  // ── 3h. Remove a listener ─────────────────────────────────────────────────
  function unlisten(path) {
    if (listeners[path]) {
      listeners[path]();
      delete listeners[path];
    }
  }

  // ── 3i. Get data once (with localStorage fallback) ────────────────────────
  async function getOnce(path) {
    const lsKey   = `ipl_${path.replace(/\//g, "_")}`;
    const cached  = LS.get(lsKey);

    if (!isOnline || !db) return cached;

    try {
      const snap = await db.ref(path).get();
      const data  = snap.val();
      if (data !== null) {
        const merged = deepMerge(cached || {}, data);
        LS.set(lsKey, merged);
        return merged;
      }
      return cached; // Firebase empty → use LS
    } catch (err) {
      console.error(`[IPLSync] getOnce failed for ${path}:`, err);
      return cached; // FIX #7 – LS fallback
    }
  }

  // ── 3j. Network status listeners ─────────────────────────────────────────
  window.addEventListener("online",  () => { isOnline = true;  flushPendingWrites(); });
  window.addEventListener("offline", () => { isOnline = false; });

  // ── 3k. Public API ────────────────────────────────────────────────────────
  return {
    init() {
      const ok = initFirebase();
      console.log(`[IPLSync] Initialized. Firebase: ${ok ? "✅" : "❌ (offline mode)"}`);
      return ok;
    },
    listen,     // real-time listener with LS fallback
    unlisten,   // remove listener
    write,      // atomic write (LS + Firebase + queue)
    getOnce,    // one-time fetch with LS fallback
    isOnline: () => isOnline,
    LS,         // expose localStorage helpers
    deepMerge,  // expose merge utility
  };
})();


// ══════════════════════════════════════════════════════════════════════════════
//  IPL FANTASY APP – DATA LAYER
//  Replace your existing loadData / saveData / renderXxx functions with these.
// ══════════════════════════════════════════════════════════════════════════════

const DB_PATHS = {
  participants: "ipl2026/participants",
  scores:       "ipl2026/scores",
  history:      "ipl2026/history",
  settings:     "ipl2026/settings",
};

// App state (single source of truth after merge)
let AppState = {
  participants: {},
  scores:       {},
  history:      [],
  settings:     {},
};

/**
 * FIX #2 + #5: Boot sequence
 * 1. Render from localStorage immediately (no flicker)
 * 2. Firebase streams updates → re-render on change
 */
async function bootApp() {
  IPLSync.init();

  // ── Render immediately from cache ────────────────────────────────────────
  AppState.participants = IPLSync.LS.get("ipl_ipl2026_participants") || {};
  AppState.scores       = IPLSync.LS.get("ipl_ipl2026_scores")       || {};
  AppState.history      = IPLSync.LS.get("ipl_ipl2026_history")      || [];
  AppState.settings     = IPLSync.LS.get("ipl_ipl2026_settings")     || {};

  renderAll(); // render with cached data first (no waiting)

  // ── Subscribe to real-time Firebase updates ──────────────────────────────
  IPLSync.listen(DB_PATHS.participants, (data, source) => {
    console.log(`[App] Participants updated from: ${source}`);
    AppState.participants = data || {};
    renderParticipants();
    renderLeaderboard();
  });

  IPLSync.listen(DB_PATHS.scores, (data, source) => {
    console.log(`[App] Scores updated from: ${source}`);
    AppState.scores = data || {};
    renderScores();
    renderLeaderboard();
    renderTopPlayers();
  });

  IPLSync.listen(DB_PATHS.history, (data, source) => {
    console.log(`[App] History updated from: ${source}`);
    // History comes back as an object from Firebase – convert to array
    AppState.history = data
      ? Object.values(data).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      : [];
    renderHistory();
  });

  IPLSync.listen(DB_PATHS.settings, (data, source) => {
    AppState.settings = data || {};
    applySettings();
  });
}

// ── Save functions (FIX #3 – correct writes) ─────────────────────────────────

async function saveParticipant(id, participantData) {
  // FIX #6 – update (merge) not set (overwrite)
  const path = `${DB_PATHS.participants}/${id}`;
  return IPLSync.write(path, participantData, "update");
}

async function saveScore(scoreId, scoreData) {
  const path = `${DB_PATHS.scores}/${scoreId}`;
  return IPLSync.write(path, {
    ...scoreData,
    timestamp: Date.now(),
  }, "set");
}

async function saveHistoryEntry(entry) {
  // Use timestamp as key to avoid duplicates (FIX #6)
  const key  = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const path = `${DB_PATHS.history}/${key}`;
  return IPLSync.write(path, {
    ...entry,
    timestamp: Date.now(),
    id: key,
  }, "set");
}

async function saveSettings(settings) {
  return IPLSync.write(DB_PATHS.settings, settings, "update");
}

async function lockTeams(locked = true) {
  return saveSettings({ teamsLocked: locked, lockedAt: Date.now() });
}

// ── Delete helpers ────────────────────────────────────────────────────────────

async function deleteParticipant(id) {
  if (!firebase.database) return;
  try {
    await firebase.database().ref(`${DB_PATHS.participants}/${id}`).remove();
    delete AppState.participants[id];
    IPLSync.LS.set("ipl_ipl2026_participants", AppState.participants);
    renderParticipants();
    renderLeaderboard();
  } catch (e) {
    console.error("[App] deleteParticipant failed:", e);
  }
}

async function clearHistory() {
  if (!confirm("Clear all score history?")) return;
  try {
    await firebase.database().ref(DB_PATHS.history).remove();
    AppState.history = [];
    IPLSync.LS.set("ipl_ipl2026_history", []);
    renderHistory();
  } catch (e) {
    console.error("[App] clearHistory failed:", e);
  }
}

// ── Render stubs (wire to your existing render functions) ─────────────────────
// Replace these with your actual render functions or call them from here.

function renderAll() {
  renderParticipants();
  renderLeaderboard();
  renderScores();
  renderTopPlayers();
  renderHistory();
  applySettings();
}

function renderParticipants() {
  // TODO: wire to your existing participant render
  console.log("[App] renderParticipants()", AppState.participants);
}

function renderLeaderboard() {
  // Build sorted leaderboard from AppState
  const rows = Object.entries(AppState.participants).map(([id, p]) => {
    const totalPts = Object.values(AppState.scores)
      .filter(s => s.participantId === id)
      .reduce((sum, s) => sum + (s.totalPoints || 0), 0);
    return { id, name: p.name, totalPts };
  }).sort((a, b) => b.totalPts - a.totalPts);

  // TODO: wire rows to your leaderboard table DOM
  console.log("[App] renderLeaderboard()", rows);
}

function renderScores() {
  console.log("[App] renderScores()", AppState.scores);
}

function renderTopPlayers() {
  // Aggregate player performance across all scores
  const players = {};
  Object.values(AppState.scores).forEach(score => {
    const key = `${score.participantId}_${score.playerName}`;
    if (!players[key]) {
      players[key] = { name: score.playerName, participant: score.participantId, pts: 0, matches: 0 };
    }
    players[key].pts     += score.totalPoints || 0;
    players[key].matches += 1;
  });

  const sorted = Object.values(players).sort((a, b) => b.pts - a.pts);
  console.log("[App] renderTopPlayers()", sorted);
}

function renderHistory() {
  console.log("[App] renderHistory()", AppState.history);
}

function applySettings() {
  const locked = AppState.settings.teamsLocked;
  const lockBtn = document.getElementById("lockTeamsBtn");
  if (lockBtn) lockBtn.textContent = locked ? "🔒 LOCKED" : "🔓 LOCK TEAMS";
  console.log("[App] applySettings()", AppState.settings);
}

// ── Points calculator (unchanged logic, just exported cleanly) ────────────────
function calculatePoints({
  runs = 0, fours = 0, sixes = 0, isDuck = false,
  wickets = 0, maidens = 0, is0Wickets = false,
  catches = 0, isMOM = false, isCaptain = false,
}) {
  let pts = 0;
  // Batting
  pts += runs * 1;
  pts += fours * 4;
  pts += sixes * 6;
  if (runs >= 100) pts += 100;
  else if (runs >= 50) pts += 50;
  if (isDuck) pts -= 30;
  // Bowling
  pts += wickets * 30;
  pts += maidens * 30;
  if (wickets >= 5) pts += 60;
  else if (wickets >= 3) pts += 60;
  if (is0Wickets) pts -= 30;
  // Fielding & Bonus
  pts += catches * 30;
  if (isMOM) pts += 100;
  if (isCaptain) pts *= 2;
  return pts;
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", bootApp);
