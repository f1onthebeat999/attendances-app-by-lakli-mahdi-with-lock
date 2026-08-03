// preload.js — the only bridge between index.html (renderer) and the
// file-system code in main.js. Runs in an isolated context: it exposes a
// small, specific set of functions on window.nativeFiles instead of giving
// the page raw Node.js access (kept sandboxed/contextIsolated on purpose).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nativeFiles", {
  // Backups (hidden AppData\backups folder, JSON, last 5 kept automatically)
  saveBackup: (jsonString) => ipcRenderer.invoke("backup:save", jsonString),
  pickAndLoadBackup: () => ipcRenderer.invoke("backup:pickAndLoad"),

  // Attendance TXT exports (hidden AppData\attendance-exports folder)
  saveAttendanceTxt: (filename, content) => ipcRenderer.invoke("attendanceTxt:save", { filename, content }),
  pickAndLoadAttendanceTxt: () => ipcRenderer.invoke("attendanceTxt:pickAndLoad"),

  // Password locks — app-wide lock on launch, separate salary lock asked every time
  // the Salary tab is opened. Passwords are verified in the main process; the
  // renderer never sees the real password or its hash, only true/false + lockout info.
  verifyAppPassword: (attempt) => ipcRenderer.invoke("lock:verifyApp", attempt),
  verifySalaryPassword: (attempt) => ipcRenderer.invoke("lock:verifySalary", attempt),
  lockStatus: (lockName) => ipcRenderer.invoke("lock:status", lockName),
  changeLockPassword: (lockName, oldPassword, newPassword) =>
    ipcRenderer.invoke("lock:changePassword", { lockName, oldPassword, newPassword }),

  // Auto-update: main.js checks GitHub Releases in the background and downloads
  // silently, but only ever installs when the person clicks the button that calls
  // installUpdateNow(). onUpdateAvailable/onUpdateReady let index.html show a notice.
  onUpdateAvailable: (callback) => ipcRenderer.on("update:available", (event, data) => callback(data)),
  onUpdateReady: (callback) => ipcRenderer.on("update:ready", (event, data) => callback(data)),
  onUpdateChecking: (callback) => ipcRenderer.on("update:checking", () => callback()),
  onUpdateNotAvailable: (callback) => ipcRenderer.on("update:notAvailable", (event, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on("update:error", (event, data) => callback(data)),
  installUpdateNow: () => ipcRenderer.invoke("update:installNow"),
  checkForUpdatesNow: () => ipcRenderer.invoke("update:checkNow"),
  setZoomFactor: (factor) => ipcRenderer.invoke("ui:setZoomFactor", factor),

  // GitHub cloud sync — sign in with a GitHub account, get a private auto-created
  // repo, and sync app data across any PC signed in to the same account.
  ghStartDeviceFlow: () => ipcRenderer.invoke("gh:startDeviceFlow"),
  ghPollForToken: (deviceInfo) => ipcRenderer.invoke("gh:pollForToken", deviceInfo),
  ghStatus: () => ipcRenderer.invoke("gh:status"),
  ghDisconnect: () => ipcRenderer.invoke("gh:disconnect"),
  ghSyncNow: (stateJson) => ipcRenderer.invoke("gh:syncNow", stateJson),
  listCloudBackups: () => ipcRenderer.invoke("gh:listCloudBackups"),
  listCloudAttendanceTxt: () => ipcRenderer.invoke("gh:listCloudAttendanceTxt"),
  fetchCloudFile: (filePath) => ipcRenderer.invoke("gh:fetchCloudFile", filePath),
  reconcileCloudFiles: () => ipcRenderer.invoke("gh:reconcileLocalFiles"),
  checkForUpdatesNow: () => ipcRenderer.invoke("update:checkNow")
});
