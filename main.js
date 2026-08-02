// main.js — Electron main process.
// Creates the app window, loads index.html, and handles all real file-system
// work (auto-backups + attendance TXT exports into hidden AppData folders).
// The renderer (index.html) never touches the filesystem directly — it asks
// this process to do it via IPC (see preload.js for the bridge).

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
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
  const file = path.join(dir, `backup-${timestampForFilename()}.json`);
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
  return file;
}

// Writes an attendance TXT export using the same filename convention the app already used.
function writeAttendanceTxt(filename, content) {
  const dir = attendanceTxtDir();
  const safeName = filename.replace(/[/\\?%*:|"<>]/g, "-"); // strip characters Windows won't allow in filenames
  const file = path.join(dir, safeName);
  fs.writeFileSync(file, content, "utf-8");
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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
