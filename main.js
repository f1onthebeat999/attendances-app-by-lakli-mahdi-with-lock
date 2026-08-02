// main.js — Electron main process.
// Creates the app window, loads index.html, and handles all real file-system
// work (auto-backups + attendance TXT exports into hidden AppData folders).
// The renderer (index.html) never touches the filesystem directly — it asks
// this process to do it via IPC (see preload.js for the bridge).

const { app, BrowserWindow, Menu, shell, ipcMain, dialog, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

// ---------- hidden folder locations ----------
// app.getPath("userData") is the standard, OS-correct per-user app data folder —
// on Windows this is %APPDATA%\class-attendance-manager, which is inside the
// AppData folder Explorer hides by default. Nothing exotic, just the normal
// place Windows apps are supposed to keep their own data.
function backupsDir() {
  const dir = path.join(app.getPath("userData"), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function attendanceTxtDir() {
  const dir = path.join(app.getPath("userData"), "attendance-exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_BACKUPS = 5;

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Writes a new timestamped backup file, then deletes older ones beyond MAX_BACKUPS.
function writeBackup(jsonString) {
  const dir = backupsDir();
  const filename = `backup-${timestampForFilename()}.json`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, jsonString, "utf-8");

  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
    .sort(); // filenames are timestamp-sortable as-is
  const excess = files.length - MAX_BACKUPS;
  if (excess > 0) {
    files.slice(0, excess).forEach((f) => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
    });
  }

  // Fire-and-forget — mirrors this backup into the user's private cloud repo if
  // they're signed in, without making the local backup wait on network round-trips.
  cloudPushBackup(filename, jsonString);

  return file;
}

// Writes an attendance TXT export using the same filename convention the app already used.
function writeAttendanceTxt(filename, content) {
  const dir = attendanceTxtDir();
  const safeName = filename.replace(/[/\\?%*:|"<>]/g, "-"); // strip characters Windows won't allow in filenames
  const file = path.join(dir, safeName);
  fs.writeFileSync(file, content, "utf-8");

  // Fire-and-forget — mirrors this export into the user's private cloud repo if signed in.
  cloudPushAttendanceTxt(safeName, content);

  return file;
}

// ---------- password locks ----------
// Two fully independent locks, each its own file in the same hidden AppData folder
// as backups — not visible from Program Files, survives reinstalls/updates (those
// only touch the install folder, never AppData).
//   lock-app.json     → gates the whole app on launch
//   lock-salary.json  → gates the Salary tab specifically, asked every time it's opened
//
// Format on disk, normally:   { "hash": "...", "salt": "...", "failedAttempts": 0, "lockedUntil": 0 }
// Format right after you edit it to set a NEW password:
//                              { "plainPassword": "whatever you typed" }
// The app detects "plainPassword", hashes it, and rewrites the file with only the
// hash — the plain text never stays on disk longer than the next check.
function lockFilePath(lockName) {
  return path.join(app.getPath("userData"), `lock-${lockName}.json`);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}

function readLockFile(lockName) {
  try {
    const raw = fs.readFileSync(lockFilePath(lockName), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeLockFile(lockName, data) {
  fs.writeFileSync(lockFilePath(lockName), JSON.stringify(data, null, 2), "utf-8");
}

// Call before checking any password. Handles: no lock file yet (first run for that
// lock — creates one with the given default password), and "plainPassword" present
// (someone just edited the file to change the password — hash it and wipe the plain text).
function ensureLockFile(lockName, defaultPassword) {
  let data = readLockFile(lockName);

  if (!data) {
    const salt = crypto.randomBytes(16).toString("hex");
    data = { hash: hashPassword(defaultPassword, salt), salt, failedAttempts: 0, lockedUntil: 0 };
    writeLockFile(lockName, data);
    return data;
  }

  if (typeof data.plainPassword === "string" && data.plainPassword.length > 0) {
    const salt = crypto.randomBytes(16).toString("hex");
    data = { hash: hashPassword(data.plainPassword, salt), salt, failedAttempts: 0, lockedUntil: 0 };
    writeLockFile(lockName, data);
    return data;
  }

  return data;
}

function verifyPassword(lockName, defaultPassword, attempt) {
  const data = ensureLockFile(lockName, defaultPassword);
  const now = Date.now();

  if (data.lockedUntil && now < data.lockedUntil) {
    return { ok: false, lockedUntil: data.lockedUntil };
  }

  const attemptHash = hashPassword(attempt, data.salt);
  const matches = attemptHash === data.hash;

  if (matches) {
    data.failedAttempts = 0;
    data.lockedUntil = 0;
    writeLockFile(lockName, data);
    return { ok: true };
  }

  data.failedAttempts = (data.failedAttempts || 0) + 1;
  // 3 wrong tries → 30s lockout, doubling each time it happens again (30s, 60s, 120s, ...)
  if (data.failedAttempts >= 3) {
    const lockoutSeconds = 30 * Math.pow(2, Math.floor((data.failedAttempts - 3) / 3));
    data.lockedUntil = now + lockoutSeconds * 1000;
  }
  writeLockFile(lockName, data);
  return { ok: false, lockedUntil: data.lockedUntil };
}

const APP_LOCK_DEFAULT_PASSWORD = "1234";     // change via lock-app.json — see README
const SALARY_LOCK_DEFAULT_PASSWORD = "1234";  // change via lock-salary.json — see README

// ---------- GitHub cloud sync ----------
// Sign-in via GitHub's Device Flow (no client secret needed — safe to ship this ID).
// Register your own at github.com/settings/developers -> OAuth Apps -> enable "Device Flow".
const GITHUB_CLIENT_ID = "REPLACE_WITH_YOUR_OAUTH_APP_CLIENT_ID";

// Each signed-in user gets exactly one auto-created private repo under their own
// account. We never touch anyone else's repos, and never see their password —
// only a token they can revoke any time from github.com/settings/applications.
const SYNC_REPO_NAME = "attendance-manager-cloud-data";
const SYNC_FILE_PATH = "state.json";

function ghTokenFilePath() { return path.join(app.getPath("userData"), "gh-token.enc"); }
function ghMetaFilePath() { return path.join(app.getPath("userData"), "gh-sync-meta.json"); }

// The token can read/write the user's private repo, so it's encrypted at rest using
// the OS's own credential store (Windows DPAPI / macOS Keychain / Linux libsecret)
// instead of sitting around as plain text.
function saveGithubToken(token) {
  const file = ghTokenFilePath();
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(file, safeStorage.encryptString(token));
  } else {
    // Rare (e.g. some bare-bones Linux setups with no keyring) — fall back rather
    // than silently failing to sign in at all.
    fs.writeFileSync(file, "PLAIN:" + token, "utf-8");
  }
}
function loadGithubToken() {
  try {
    const buf = fs.readFileSync(ghTokenFilePath());
    const str = buf.toString("utf-8");
    if (str.startsWith("PLAIN:")) return str.slice(6);
    return safeStorage.decryptString(buf);
  } catch (e) {
    return null;
  }
}
function readGhMeta() {
  try { return JSON.parse(fs.readFileSync(ghMetaFilePath(), "utf-8")); }
  catch (e) { return null; }
}
function writeGhMeta(meta) {
  fs.writeFileSync(ghMetaFilePath(), JSON.stringify(meta, null, 2), "utf-8");
}
function clearGithubSession() {
  try { fs.unlinkSync(ghTokenFilePath()); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(ghMetaFilePath()); } catch (e) { /* ignore */ }
}

function ghApiHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "class-attendance-manager"
  };
}
async function ghRequest(token, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...ghApiHeaders(token), ...(options.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* some responses have no body */ }
  return { status: res.status, ok: res.ok, body };
}

// ---- Sign-in (Device Flow) ----
async function ghStartDeviceFlow() {
  let res, data;
  try {
    res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo" })
    });
    data = await res.json();
  } catch (e) {
    throw new Error("Network error reaching GitHub: " + String(e.message || e));
  }
  if (!res.ok || data.error) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function ghPollForToken(deviceCode, intervalSeconds, expiresInSeconds) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });
    const data = await res.json();
    if (data.access_token) return { ok: true, token: data.access_token };
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { interval += 5; continue; }
    if (data.error === "expired_token") return { ok: false, reason: "expired" };
    if (data.error === "access_denied") return { ok: false, reason: "denied" };
    return { ok: false, reason: data.error || "unknown_error" };
  }
  return { ok: false, reason: "expired" };
}

async function ghGetUser(token) {
  const r = await ghRequest(token, "/user");
  if (!r.ok) throw new Error("Couldn't read your GitHub account info");
  return r.body; // includes .login
}

// Creates the user's private "room" the first time they sign in; reuses it after that.
async function ghEnsureSyncRepo(token, owner) {
  const check = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}`);
  if (check.ok) return check.body;
  const create = await ghRequest(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: SYNC_REPO_NAME,
      private: true,
      description: "Private data storage for Class & Attendance Manager — auto-created, safe to leave alone.",
      auto_init: true
    })
  });
  if (!create.ok) throw new Error("Couldn't create your private sync repo on GitHub");
  return create.body;
}

// ---- Reading/writing the synced data file ----
async function ghGetRemoteState(token, owner) {
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${SYNC_FILE_PATH}`);
  if (r.status === 404) return { exists: false, sha: null, wrapper: null };
  if (!r.ok) throw new Error("Couldn't read your cloud data");
  const raw = Buffer.from(r.body.content, "base64").toString("utf-8");
  let wrapper = null;
  try { wrapper = JSON.parse(raw); } catch (e) { /* treat as empty if unreadable */ }
  return { exists: true, sha: r.body.sha, wrapper };
}

async function ghPutRemoteState(token, owner, wrapperObj, sha) {
  const content = Buffer.from(JSON.stringify(wrapperObj, null, 2), "utf-8").toString("base64");
  const body = {
    message: `Sync from ${os.hostname()} — ${new Date(wrapperObj.updatedAt).toISOString()}`,
    content
  };
  if (sha) body.sha = sha;
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${SYNC_FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) return { ok: false, conflict: false, error: (r.body && r.body.message) || `HTTP ${r.status}` };
  return { ok: true, sha: r.body.content.sha };
}

function getGhSession() {
  const token = loadGithubToken();
  const meta = readGhMeta();
  if (!token || !meta) return null;
  return { token, meta };
}

async function ghListFolder(token, owner, folder) {
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${folder}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("Couldn't list cloud files");
  return Array.isArray(r.body) ? r.body : [];
}

async function ghPutFile(token, owner, filePath, bufferContent, message, sha) {
  const body = { message, content: bufferContent.toString("base64") };
  if (sha) body.sha = sha;
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error((r.body && r.body.message) || `HTTP ${r.status}`);
  return r.body;
}

async function ghDeleteFile(token, owner, filePath, sha, message) {
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${filePath}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha })
  });
  if (!r.ok) throw new Error((r.body && r.body.message) || `HTTP ${r.status}`);
}

async function ghFetchFileContent(token, owner, filePath) {
  const r = await ghRequest(token, `/repos/${owner}/${SYNC_REPO_NAME}/contents/${filePath}`);
  if (!r.ok) throw new Error("That file isn't in the cloud repo");
  return Buffer.from(r.body.content, "base64").toString("utf-8");
}

// Mirrors a local timestamped backup into backups/ in the cloud repo, then prunes
// old ones there too so the cloud copy matches the same "last 5" rule as local.
// Fire-and-forget from the caller's perspective — a slow/offline cloud push should
// never delay or break the local backup that already succeeded.
async function cloudPushBackup(filename, jsonString) {
  const session = getGhSession();
  if (!session) return;
  try {
    const filePath = `backups/${filename}`;
    await ghPutFile(session.token, session.meta.login, filePath, Buffer.from(jsonString, "utf-8"), `Backup ${filename}`, null);
    const files = await ghListFolder(session.token, session.meta.login, "backups");
    const names = files.map((f) => f.name).filter((n) => n.startsWith("backup-") && n.endsWith(".json")).sort();
    const excess = names.length - MAX_BACKUPS;
    if (excess > 0) {
      for (const name of names.slice(0, excess)) {
        const f = files.find((x) => x.name === name);
        if (f) {
          try { await ghDeleteFile(session.token, session.meta.login, f.path, f.sha, `Prune old backup ${name}`); }
          catch (e) { /* non-fatal — next prune pass will catch it */ }
        }
      }
    }
  } catch (e) {
    console.warn("Cloud backup mirror failed:", e.message || e);
  }
}

// Mirrors an attendance TXT export into attendance-exports/ in the cloud repo.
async function cloudPushAttendanceTxt(filename, content) {
  const session = getGhSession();
  if (!session) return;
  try {
    const filePath = `attendance-exports/${filename}`;
    let sha = null;
    const existing = await ghRequest(session.token, `/repos/${session.meta.login}/${SYNC_REPO_NAME}/contents/${filePath}`);
    if (existing.ok) sha = existing.body.sha;
    await ghPutFile(session.token, session.meta.login, filePath, Buffer.from(content, "utf-8"), `Attendance export ${filename}`, sha);
  } catch (e) {
    console.warn("Cloud attendance export mirror failed:", e.message || e);
  }
}
// another PC pushed since we last looked, our push is rejected instead of quietly
// overwriting their changes, and we pull theirs down instead.
async function performSync(localStateJson) {
  const token = loadGithubToken();
  const meta = readGhMeta();
  if (!token || !meta) return { ok: false, error: "not_connected" };

  const localState = JSON.parse(localStateJson);
  const remote = await ghGetRemoteState(token, meta.login);

  if (!remote.exists) {
    const wrapper = { updatedAt: Date.now(), device: os.hostname(), data: localState };
    const put = await ghPutRemoteState(token, meta.login, wrapper, null);
    if (!put.ok) return { ok: false, error: put.error || "push_failed" };
    writeGhMeta({ ...meta, lastSha: put.sha, lastUpdatedAt: wrapper.updatedAt });
    return { ok: true, pushed: true, lastSyncedAt: wrapper.updatedAt };
  }

  const remoteUpdatedAt = remote.wrapper ? remote.wrapper.updatedAt : 0;
  const lastKnownUpdatedAt = meta.lastUpdatedAt || 0;

  if (remoteUpdatedAt > lastKnownUpdatedAt) {
    // Another device pushed something we haven't seen yet — adopt it.
    writeGhMeta({ ...meta, lastSha: remote.sha, lastUpdatedAt: remoteUpdatedAt });
    return { ok: true, pulled: true, data: remote.wrapper.data, lastSyncedAt: remoteUpdatedAt };
  }

  const wrapper = { updatedAt: Date.now(), device: os.hostname(), data: localState };
  const put = await ghPutRemoteState(token, meta.login, wrapper, remote.sha);
  if (put.conflict) {
    // Someone pushed between our read and our write — take theirs rather than overwrite it.
    const fresh = await ghGetRemoteState(token, meta.login);
    if (fresh.exists && fresh.wrapper) {
      writeGhMeta({ ...meta, lastSha: fresh.sha, lastUpdatedAt: fresh.wrapper.updatedAt });
      return { ok: true, pulled: true, data: fresh.wrapper.data, lastSyncedAt: fresh.wrapper.updatedAt };
    }
    return { ok: false, error: "conflict" };
  }
  if (!put.ok) return { ok: false, error: put.error || "push_failed" };
  writeGhMeta({ ...meta, lastSha: put.sha, lastUpdatedAt: wrapper.updatedAt });
  return { ok: true, pushed: true, lastSyncedAt: wrapper.updatedAt };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0c0c0e", // matches the app's dark theme, avoids a white flash on load
    icon: path.join(__dirname, "app", "icons", "icon-512.png"), // Linux taskbar icon; Win/Mac use the packaged .ico/.icns
    autoHideMenuBar: true, // keeps the UI clean — no File/Edit/View bar taking up space
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile(path.join(__dirname, "app", "index.html"));

  // Open any external links (if ever added) in the OS browser instead of inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Minimal menu: keep zoom/reload/devtools available for troubleshooting, nothing else.
  const menu = Menu.buildFromTemplate([
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  setupAutoUpdater(win);

  return win;
}

// ---------- auto-update (checks GitHub Releases for this repo) ----------
// "Ask first" behavior: we check for and DOWNLOAD an update in the background so it's
// ready instantly, but we never install it without the person clicking a button first.
// autoUpdater.autoInstallOnAppQuit stays false so nothing installs itself unexpectedly.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

function setupAutoUpdater(win) {
  autoUpdater.on("checking-for-update", () => {
    win.webContents.send("update:checking");
  });

  autoUpdater.on("update-available", (info) => {
    win.webContents.send("update:available", { version: info.version });
  });

  autoUpdater.on("update-not-available", (info) => {
    win.webContents.send("update:notAvailable", { version: info.version });
  });

  autoUpdater.on("update-downloaded", (info) => {
    win.webContents.send("update:ready", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    const message = err == null ? "unknown error" : (err.stack || err).toString();
    console.warn("Auto-update check failed:", message);
    // The background/periodic check stays silent to the user (e.g. no internet is normal
    // and shouldn't nag anyone) — but we still forward it as an event so a manual
    // "Check for updates now" click in Settings can surface it instead of hanging forever.
    win.webContents.send("update:error", { message });
  });

  // Check once shortly after launch, and then every few hours while the app stays open.
  // Never blocks startup — the app is fully usable immediately regardless of the result.
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

// Renderer calls this once the person clicks "Install update" on the notice —
// this is the ONLY thing that actually triggers install + restart.
ipcMain.handle("update:installNow", async () => {
  autoUpdater.quitAndInstall();
  return { ok: true };
});

// Renderer calls this from the Settings "Check for updates now" button.
// Unlike the silent background check, this one reports back so the button
// can show a real result instead of just spinning forever.
ipcMain.handle("update:checkNow", async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- IPC: backups ----------
ipcMain.handle("backup:save", async (event, jsonString) => {
  try {
    const file = writeBackup(jsonString);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Opens a native "Open File" dialog pointed directly at the hidden backups folder.
ipcMain.handle("backup:pickAndLoad", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a backup to restore",
    defaultPath: backupsDir(),
    properties: ["openFile"],
    filters: [{ name: "Backup files", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(result.filePaths[0], "utf-8");
    return { ok: true, content, file: result.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- IPC: attendance TXT exports ----------
ipcMain.handle("attendanceTxt:save", async (event, { filename, content }) => {
  try {
    const file = writeAttendanceTxt(filename, content);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Opens a native "Open File" dialog pointed directly at the hidden attendance-TXT folder.
ipcMain.handle("attendanceTxt:pickAndLoad", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Choose an attendance file to import",
    defaultPath: attendanceTxtDir(),
    properties: ["openFile"],
    filters: [{ name: "Attendance TXT files", extensions: ["txt"] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(result.filePaths[0], "utf-8");
    return { ok: true, content, file: result.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- IPC: password locks ----------
ipcMain.handle("lock:verifyApp", async (event, attempt) => {
  return verifyPassword("app", APP_LOCK_DEFAULT_PASSWORD, attempt);
});
ipcMain.handle("lock:verifySalary", async (event, attempt) => {
  return verifyPassword("salary", SALARY_LOCK_DEFAULT_PASSWORD, attempt);
});
// Lets the renderer check remaining lockout time without attempting a password,
// e.g. to keep a countdown displayed if the app was reopened mid-lockout.
ipcMain.handle("lock:status", async (event, lockName) => {
  const defaultPassword = lockName === "salary" ? SALARY_LOCK_DEFAULT_PASSWORD : APP_LOCK_DEFAULT_PASSWORD;
  const data = ensureLockFile(lockName, defaultPassword);
  const now = Date.now();
  return { lockedUntil: data.lockedUntil && data.lockedUntil > now ? data.lockedUntil : 0 };
});

// ---------- IPC: GitHub cloud sync ----------
ipcMain.handle("gh:startDeviceFlow", async () => {
  try {
    const data = await ghStartDeviceFlow();
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// This call deliberately runs for as long as it takes the person to approve on
// github.com (up to the device code's expiry, ~15 min) — IPC invoke has no timeout.
ipcMain.handle("gh:pollForToken", async (event, { device_code, interval, expires_in }) => {
  const result = await ghPollForToken(device_code, interval, expires_in);
  if (!result.ok) return result;
  try {
    const user = await ghGetUser(result.token);
    const repo = await ghEnsureSyncRepo(result.token, user.login);
    saveGithubToken(result.token);
    writeGhMeta({ login: user.login, repo: repo.name, lastSha: null, lastUpdatedAt: 0 });
    return { ok: true, login: user.login, repo: repo.name };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
});

ipcMain.handle("gh:status", async () => {
  const token = loadGithubToken();
  const meta = readGhMeta();
  if (!token || !meta) return { connected: false };
  return { connected: true, login: meta.login, repo: meta.repo, lastSyncedAt: meta.lastUpdatedAt || null };
});

ipcMain.handle("gh:disconnect", async () => {
  clearGithubSession();
  return { ok: true };
});

ipcMain.handle("gh:syncNow", async (event, localStateJson) => {
  try { return await performSync(localStateJson); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle("gh:listCloudBackups", async () => {
  const session = getGhSession();
  if (!session) return { ok: false, error: "not_connected" };
  try {
    const files = await ghListFolder(session.token, session.meta.login, "backups");
    const list = files
      .filter((f) => f.name.startsWith("backup-") && f.name.endsWith(".json"))
      .map((f) => ({ name: f.name, path: f.path }))
      .sort((a, b) => b.name.localeCompare(a.name));
    return { ok: true, files: list };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("gh:listCloudAttendanceTxt", async () => {
  const session = getGhSession();
  if (!session) return { ok: false, error: "not_connected" };
  try {
    const files = await ghListFolder(session.token, session.meta.login, "attendance-exports");
    const list = files
      .filter((f) => f.name.endsWith(".txt"))
      .map((f) => ({ name: f.name, path: f.path }))
      .sort((a, b) => b.name.localeCompare(a.name));
    return { ok: true, files: list };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("gh:fetchCloudFile", async (event, filePath) => {
  const session = getGhSession();
  if (!session) return { ok: false, error: "not_connected" };
  try {
    const content = await ghFetchFileContent(session.token, session.meta.login, filePath);
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
