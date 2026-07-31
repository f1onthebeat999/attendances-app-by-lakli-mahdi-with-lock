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
  lockStatus: (lockName) => ipcRenderer.invoke("lock:status", lockName)
});
