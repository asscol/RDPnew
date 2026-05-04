// RemoteDesk desktop client (Electron).
//
// Behaviour:
//   * On first run, show a tiny "setup" window asking for the signaling
//     server URL (e.g. https://remote.example.com/). This is persisted to
//     userData/config.json.
//   * On every subsequent run, load that URL directly.
//   * From the menu the user can change the server URL or sign out (clears
//     all cookies and session storage, then returns to the setup screen).

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const CONFIG_FILENAME = "config.json";

function configPath() {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

function normaliseServerUrl(input) {
  if (!input) return null;
  let v = input.trim();
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    return u.origin + (u.pathname.replace(/\/+$/, "") || "");
  } catch {
    return null;
  }
}

let mainWindow = null;

function createMainWindow(targetUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "RemoteDesk",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(targetUrl).catch((err) => {
    dialog.showErrorBox(
      "Cannot reach RemoteDesk server",
      `Failed to load ${targetUrl}\n\n${err.message}\n\nUse File → Change server… to point at a different URL.`,
    );
  });
  // External links open in the OS browser instead of replacing the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}

function createSetupWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "RemoteDesk — Setup",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.setMenu(null);
  win.loadFile("setup.html");
  return win;
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Change server…",
          click: () => promptChangeServer(),
        },
        {
          label: "Sign out (clear cookies)",
          click: async () => {
            const ok = await dialog.showMessageBox(mainWindow, {
              type: "question",
              buttons: ["Sign out", "Cancel"],
              defaultId: 1,
              cancelId: 1,
              message: "Sign out from this server?",
              detail: "All saved cookies and session data for this server will be cleared.",
            });
            if (ok.response !== 0) return;
            await session.defaultSession.clearStorageData();
            mainWindow.reload();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function promptChangeServer() {
  const cfg = loadConfig();
  const setupWin = createSetupWindow();
  setupWin.webContents.once("did-finish-load", () => {
    setupWin.webContents.send("config:current", cfg.serverUrl || "");
  });
  setupWin.on("closed", () => {
    const next = loadConfig();
    if (next.serverUrl && mainWindow) {
      mainWindow.loadURL(next.serverUrl);
    }
  });
}

ipcMain.handle("config:save", (_event, raw) => {
  const url = normaliseServerUrl(raw);
  if (!url) return { error: "bad-url" };
  const cfg = loadConfig();
  cfg.serverUrl = url;
  saveConfig(cfg);
  return { ok: true, serverUrl: url };
});

ipcMain.handle("config:load", () => loadConfig());

app.whenReady().then(() => {
  buildMenu();
  const cfg = loadConfig();
  if (cfg.serverUrl) {
    mainWindow = createMainWindow(cfg.serverUrl);
  } else {
    const setup = createSetupWindow();
    setup.on("closed", () => {
      const fresh = loadConfig();
      if (fresh.serverUrl) {
        mainWindow = createMainWindow(fresh.serverUrl);
      } else {
        app.quit();
      }
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const cfg = loadConfig();
    if (cfg.serverUrl) mainWindow = createMainWindow(cfg.serverUrl);
  }
});
