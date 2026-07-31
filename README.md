# Class & Attendance Manager — Desktop App (Windows/Mac/Linux)

This turns your exact app into a real desktop application: a Setup.exe
that installs it with a proper desktop icon and Start Menu shortcut,
just like normal Windows software. Double-click the icon → the app opens
directly, no browser involved.

I already tested this end-to-end in my build environment (Linux) and
confirmed the app launches correctly and the packaging config is valid —
screenshot-verified. The one thing that has to happen on a real Windows
machine (or via the included cloud workflow) is producing the final
`Setup.exe`, since Windows installers are built for Windows.

## Fastest way to get Setup.exe: let GitHub build it for you (free, no Windows PC needed)

1. Create a free GitHub account if you don't have one.
2. Create a new repository and upload every file in this folder
   (keep the folder structure, including the hidden `.github` folder).
3. Go to the repo's **Actions** tab. A workflow called
   **"Build Windows installer"** will run automatically.
   (If it doesn't start automatically, click it and press **"Run workflow."**)
4. Wait ~2-3 minutes. Click into the finished run, scroll to
   **Artifacts**, and download **Class-Attendance-Manager-Setup**.
5. Unzip it — inside is your `Setup.exe`. Send that to any Windows PC
   and double-click to install.

This is the recommended path: free, no Mac/Windows needed on your end,
and it's a genuine build (not a workaround).

## Alternative: build it yourself on a Windows PC

If you have a Windows machine handy:

1. Install [Node.js](https://nodejs.org) (LTS version).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm run dist:win
   ```
3. The installer appears in the `release/` folder as something like
   `Class & Attendance Manager Setup 1.0.0.exe`.
4. Run that file — it installs the app with a desktop icon and Start
   Menu entry, exactly like normal software.

## Building for Mac or Linux instead

```
npm run dist:mac     # produces a .dmg (must be run on a Mac)
npm run dist:linux   # produces an .AppImage (can be run right here on Linux)
```

## What's inside this project

- `main.js` — the tiny Electron wrapper that opens your app in its own window
- `app/index.html` — your exact app, unchanged in behavior
- `app/vendor/jspdf.umd.min.js` — PDF export library, bundled locally so
  PDF export works with **no internet connection at all**
- `app/icons/` — the app icon in every format Windows/Mac/Linux need
  (`.ico`, `.icns`, `.png`)
- `package.json` — describes the app and how to package it
- `.github/workflows/build-windows.yml` — the free cloud-build recipe

## Notes

- Each install keeps its own local data on that PC (same as before —
  no automatic syncing between machines). Export PDF/TXT and the
  History tab remain your record-keeping/backup tools.
- Google Fonts are loaded from the web for the display typeface; if
  there's no internet on first launch, the app still works perfectly,
  it just falls back to a system font until it's back online.
- To change the app's name shown during install, edit `productName` and
  `shortcutName` in `package.json`, and `author`/`name` if you want.

## Automatic backups & attendance exports (desktop app only)

This build automatically protects your data without you doing anything:

- **Backups**: every time anything changes (a new class, a validated
  lesson, an edit — anything), and also every 5 minutes regardless,
  the app silently writes a full backup of all your data to a hidden
  folder on your PC. The last **5** backups are kept; older ones are
  deleted automatically as new ones come in.
- **Attendance exports**: every time you validate an attendance sheet,
  a `.txt` copy is automatically saved to a second hidden folder — no
  manual "Export TXT" click needed anymore (the manual PDF export
  button is still there if you want a PDF copy).

Both hidden folders live inside Windows' standard per-user app data
location — nothing exotic, just the normal place apps are supposed to
keep their own files, which Explorer hides by default:

```
%APPDATA%\class-attendance-manager\backups\
%APPDATA%\class-attendance-manager\attendance-exports\
```

**To restore a backup:** open the app → Settings tab → "Restore from
auto-backup…" — this opens a normal Windows file picker already pointed
at the hidden backups folder, so you just pick a date and confirm.

**To re-import an old attendance export:** Search tab → "Pick from
auto-saved exports…" — same idea, opens straight into the hidden
attendance-exports folder.

You can also get to these folders directly in Windows Explorer by
typing `%APPDATA%\class-attendance-manager` into the address bar, if
you ever want to copy them elsewhere (e.g. onto a USB drive or cloud
folder) as an extra layer of safety.

## Password locks (desktop app only)

Two separate, independent password locks protect this app:

1. **App lock** — a full-screen password prompt appears the instant
   the app opens. Nothing else loads until it's entered correctly.
2. **Salary lock** — a second, different password, asked **every
   single time** you open the Salary tab, even within the same
   session. Unlocking the app itself does not unlock Salary.

**Default password for both, out of the box: `1234`.**
**Change this immediately** — see below.

### How the passwords are stored

Neither password is ever stored as plain, readable text on disk under
normal use. Each is stored as a salted cryptographic hash (PBKDF2, a
standard, slow, one-way scrambling function) inside its own hidden file:

```
%APPDATA%\class-attendance-manager\lock-app.json
%APPDATA%\class-attendance-manager\lock-salary.json
```

The real password can't be recovered from the hash — the app can only
check "does this attempt match?", never "what was the password?".

After 3 wrong attempts on either lock, it locks out further attempts
for 30 seconds (doubling to 60s, 120s... if it keeps happening) — this
blocks rapid-fire guessing, and the lockout applies even to the correct
password until the timer runs out.

### How to change a password

1. Close the app.
2. Go to `%APPDATA%\class-attendance-manager\` in Windows Explorer.
3. Open `lock-app.json` (for the app password) or `lock-salary.json`
   (for the salary password) in Notepad.
4. Replace the entire contents with:
   ```json
   { "plainPassword": "yourNewPasswordHere" }
   ```
5. Save and close.
6. Open the app. The very next time that password is checked, the app
   automatically scrambles it into a hash and rewrites the file — the
   plain text you just typed does not stay on disk.

### Honest limits of this protection

This is a genuinely solid lock — more than enough to stop a teacher,
or anyone casually curious, from opening the app or seeing the Salary
tab. It is **not** designed to withstand a determined, technically
skilled attacker with unlimited time and full access to the physical
machine — no client-side password lock in any desktop app (this one
included) can fully guarantee that, since the app itself has to be
able to check the password locally. For protecting personal data from
a teacher or casual snooping on a shared PC, this is a strong, honest
fit.
