// Electron main process for Swarmie desktop app
// Replaces SwarmieApp.swift (WKWebView) with Chromium-based window

const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');

const SERVER_PORT = 3200;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// ---------------------------------------------------------------------------
// Resolve project root (where package.json lives)
// ---------------------------------------------------------------------------

function projectRoot() {
  // 1. Bundled inside app Resources (packaged mode)
  const resourcesPath = process.resourcesPath;
  const bundledProject = path.join(resourcesPath, 'project');
  try {
    require('fs').accessSync(path.join(bundledProject, 'package.json'));
    console.log('[swarmie] Using bundled project at:', bundledProject);
    return bundledProject;
  } catch {}

  // 2. Directory containing the .app / executable
  const appDir = path.dirname(app.getAppPath());
  try {
    require('fs').accessSync(path.join(appDir, 'package.json'));
    console.log('[swarmie] Using project next to app:', appDir);
    return appDir;
  } catch {}

  // 3. Walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    dir = path.dirname(dir);
    try {
      require('fs').accessSync(path.join(dir, 'package.json'));
      console.log('[swarmie] Using project at:', dir);
      return dir;
    } catch {}
  }

  console.log('[swarmie] Fallback to cwd:', process.cwd());
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Get login shell PATH (macOS apps launch with minimal PATH)
// ---------------------------------------------------------------------------

function getLoginShellPath() {
  const userShell = process.env.SHELL || '/bin/zsh';
  const shellsToTry = userShell.endsWith('/fish')
    ? ['/bin/zsh', userShell]
    : [userShell, '/bin/zsh'];

  for (const sh of shellsToTry) {
    try {
      const cmd = sh.endsWith('/fish')
        ? 'string join : $PATH'
        : 'echo $PATH';
      const result = execSync(`${sh} -lic '${cmd}'`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (result && result.includes('/')) {
        return result;
      }
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Find node binary
// ---------------------------------------------------------------------------

function findNode(root) {
  const fs = require('fs');

  // 1. Bundled node
  const bundledNode = path.join(root, 'node', 'bin', 'node');
  try {
    fs.accessSync(bundledNode, fs.constants.X_OK);
    return bundledNode;
  } catch {}

  // 2. nvm
  const nvmBase = path.join(require('os').homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const nodePath = path.join(nvmBase, v, 'bin', 'node');
      try {
        fs.accessSync(nodePath, fs.constants.X_OK);
        return nodePath;
      } catch {}
    }
  } catch {}

  // 3. Common paths
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }

  // 4. From login shell
  try {
    const result = execSync('which node', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) return result;
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// Check if port is open
// ---------------------------------------------------------------------------

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(300);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(SERVER_PORT)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

let serverProcess = null;
let ownsServer = false;

function startServer(root) {
  const nodePath = findNode(root);
  if (!nodePath) {
    console.error('[swarmie-server] Cannot find node binary');
    return false;
  }
  console.log('[swarmie-server] Using node at:', nodePath);

  const shellPath = getLoginShellPath() || process.env.PATH || '/usr/bin:/bin';
  const nodeBinDir = path.dirname(nodePath);
  const env = {
    ...process.env,
    PATH: `${shellPath}:${nodeBinDir}`,
  };
  console.log('[swarmie-server] PATH:', env.PATH);

  serverProcess = spawn(nodePath, ['dist/bin/swarmie.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => console.log('[swarmie-server]', d.toString().trimEnd()));
  serverProcess.stderr.on('data', (d) => console.log('[swarmie-server]', d.toString().trimEnd()));
  serverProcess.on('exit', (code) => console.log('[swarmie-server] exited with code', code));

  return true;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;

function createWindow() {
  const { screen } = require('electron');
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, Math.round(screenW * 0.85)),
    height: Math.min(900, Math.round(screenH * 0.85)),
    minWidth: 600,
    minHeight: 400,
    title: 'Swarmie',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

function loadingHTML() {
  return `data:text/html,<html><body style="background:#fdf6e3;color:#93a1a1;font-family:-apple-system,monospace;
    display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
    <div><div style="font-size:32px;margin-bottom:16px">&#x1F41D;</div>
    <div style="font-size:14px">Starting swarmie...</div></div></body></html>`;
}

function errorHTML(message) {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return `data:text/html,<html><body style="background:#0d1117;color:#f85149;font-family:-apple-system,monospace;
    display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;
    font-size:14px;padding:40px">${escaped}</body></html>`;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  setupMenu();

  const root = projectRoot();
  const win = createWindow();

  win.loadURL(loadingHTML());

  const alreadyRunning = await isPortOpen(SERVER_PORT);

  if (!alreadyRunning) {
    ownsServer = true;
    if (!startServer(root)) {
      win.loadURL(errorHTML(`Cannot find node binary.\nMake sure Node.js is installed.`));
      return;
    }
  }

  const ready = alreadyRunning || await waitForReady();
  if (ready) {
    win.loadURL(SERVER_URL);
  } else {
    win.loadURL(errorHTML(
      `Failed to start swarmie server.\nMake sure 'npm run build' has been run in:\n${root}`
    ));
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (ownsServer) stopServer();
});
