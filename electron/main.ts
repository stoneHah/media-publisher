import { app, BrowserWindow, WebContentsView, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { request } from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const CDP_PORT = Number(process.env.MEDIA_PUBLISHER_CDP_PORT ?? 9240);
const CONTROL_WIDTH = 420;
const OPENCLI_COMMAND_TIMEOUT_MS = 90_000;
const TARGET_TITLE = "OpenCLI Embedded Target";
const TARGET_BOOTSTRAP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><html><head><title>${TARGET_TITLE}</title><style>html,body{height:100%;margin:0;background:#f7f8fa;color:#1f2937;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{height:100%;display:grid;place-items:center}section{width:min(520px,80%);line-height:1.5}h1{font-size:18px;margin:0 0 8px}</style></head><body><main><section><h1>${TARGET_TITLE}</h1><p>Ready</p></section></main></body></html>`
)}`;

app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");

type OpenUrlResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  data?: unknown;
};

type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

let mainWindow: BrowserWindow | null = null;
let targetView: WebContentsView | null = null;
let cachedTargetWsUrl: string | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 620,
    title: "Media Publisher",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  targetView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:publisher-target"
    }
  });

  mainWindow.contentView.addChildView(targetView);
  updateTargetBounds();

  mainWindow.on("resize", updateTargetBounds);
  mainWindow.on("closed", () => {
    mainWindow = null;
    targetView = null;
    cachedTargetWsUrl = null;
  });

  targetView.webContents.setWindowOpenHandler(({ url }) => {
    targetView?.webContents.loadURL(url);
    return { action: "deny" };
  });
  await targetView.webContents.loadURL(TARGET_BOOTSTRAP_URL);

  if (app.isPackaged) {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  }
}

function updateTargetBounds() {
  if (!mainWindow || !targetView) return;
  const [width, height] = mainWindow.getContentSize();
  targetView.setBounds({
    x: CONTROL_WIDTH,
    y: 0,
    width: Math.max(0, width - CONTROL_WIDTH),
    height
  });
}

function getOpenCliHome() {
  return path.join(app.getPath("userData"), "opencli-home");
}

function getOpenCliRoot() {
  return path.join(getOpenCliHome(), ".opencli");
}

function getOpenCliEntry() {
  const candidates = [
    path.join(app.getAppPath(), "node_modules", "@jackwener", "opencli", "dist", "src", "main.js"),
    path.join(__dirname, "..", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js"),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js")
  ];
  const entry = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!entry) {
    throw new Error("Unable to locate @jackwener/opencli. Run npm install before starting the app.");
  }
  return entry;
}

async function ensureOpenCliRuntime() {
  const opencliRoot = getOpenCliRoot();
  const adapterDir = path.join(opencliRoot, "clis", "media-publisher");
  await fs.mkdir(adapterDir, { recursive: true });

  await fs.writeFile(
    path.join(opencliRoot, "apps.yaml"),
    [
      "apps:",
      "  media-publisher:",
      `    port: ${CDP_PORT}`,
      "    processName: Media Publisher",
      "    displayName: Media Publisher",
      ""
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(adapterDir, "open.js"),
    `import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';

cli({
  site: 'media-publisher',
  name: 'open',
  description: 'Open a URL in the embedded Electron browser target',
  domain: 'localhost',
  strategy: Strategy.UI,
  navigateBefore: false,
  args: [
    { name: 'url', required: true, positional: true, help: 'URL to open' }
  ],
  columns: ['url', 'title'],
  func: async (page, kwargs) => {
    const rawUrl = String(kwargs.url || '').trim();
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ArgumentError('Invalid URL: ' + rawUrl);
    }
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      throw new ArgumentError('Unsupported URL protocol: ' + parsed.protocol);
    }

    await page.goto(parsed.toString());
    const currentUrl = await page.getCurrentUrl?.() ?? await page.evaluate('location.href');
    const title = await page.evaluate('document.title');
    return [{ url: currentUrl, title: title || '' }];
  }
});
`,
    "utf8"
  );
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: 3_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`CDP target list returned HTTP ${res.statusCode ?? "unknown"}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timed out reading CDP target list")));
    req.end();
  });
}

async function listCdpTargets() {
  return getJson<CdpTarget[]>(`http://127.0.0.1:${CDP_PORT}/json`);
}

async function resolveEmbeddedTargetWsUrl() {
  if (cachedTargetWsUrl) return cachedTargetWsUrl;
  if (!targetView) throw new Error("Embedded browser view is not ready.");

  const targets = await listCdpTargets();
  const targetUrl = targetView.webContents.getURL();
  const targetTitle = targetView.webContents.getTitle();
  const uiUrl = mainWindow?.webContents.getURL();

  const candidates = targets.filter((target) => target.webSocketDebuggerUrl && target.url !== uiUrl);
  const target =
    candidates.find((candidate) => candidate.url === targetUrl) ??
    candidates.find((candidate) => candidate.title === targetTitle && candidate.title === TARGET_TITLE) ??
    candidates.find((candidate) => candidate.title === TARGET_TITLE) ??
    candidates.find((candidate) => candidate.type === "page" || candidate.type === "webview");

  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`Could not resolve embedded browser CDP target on port ${CDP_PORT}.`);
  }

  cachedTargetWsUrl = target.webSocketDebuggerUrl;
  return cachedTargetWsUrl;
}

function parseJsonOutput(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    return undefined;
  }
}

function assertElectronNodeCanRunOpenCli() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 21) {
    throw new Error(
      `The embedded Electron Node runtime is ${process.versions.node}; OpenCLI requires Node >=21. Use an Electron build with Node >=21.`
    );
  }
}

async function runOpenCli(args: string[], cdpEndpoint: string): Promise<OpenUrlResult> {
  assertElectronNodeCanRunOpenCli();
  await ensureOpenCliRuntime();
  const opencliEntry = pathToFileURL(getOpenCliEntry()).href;
  const bootstrap = [
    "process.argv = ['electron', ...process.argv.slice(1)];",
    `await import(${JSON.stringify(opencliEntry)});`
  ].join("\n");

  const childEnv = {
    ...process.env,
    HOME: getOpenCliHome(),
    OPENCLI_CDP_ENDPOINT: cdpEndpoint,
    ELECTRON_RUN_AS_NODE: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1"
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", bootstrap, ...args], {
      cwd: app.getAppPath(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\nOpenCLI command timed out after ${OPENCLI_COMMAND_TIMEOUT_MS / 1000}s.`;
      child.kill("SIGTERM");
    }, OPENCLI_COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        data: code === 0 ? parseJsonOutput(stdout) : undefined
      });
    });
  });
}

ipcMain.handle("opencli:open-url", async (_event, url: string): Promise<OpenUrlResult> => {
  try {
    const cdpEndpoint = await resolveEmbeddedTargetWsUrl();
    return runOpenCli(["media-publisher", "open", String(url), "-f", "json"], cdpEndpoint);
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("opencli:status", async () => {
  try {
    await ensureOpenCliRuntime();
    const targets = await listCdpTargets();
    const target = targets.find((candidate) => candidate.webSocketDebuggerUrl === cachedTargetWsUrl) ?? null;
    return {
      ok: true,
      cdpPort: CDP_PORT,
      cdpEndpoint: cachedTargetWsUrl,
      opencliHome: getOpenCliHome(),
      opencliEntry: getOpenCliEntry(),
      electronNode: process.versions.node,
      target: target
        ? { id: target.id, type: target.type, title: target.title, url: target.url }
        : {
            title: targetView?.webContents.getTitle() ?? "",
            url: targetView?.webContents.getURL() ?? ""
          }
    };
  } catch (error) {
    return {
      ok: false,
      cdpPort: CDP_PORT,
      cdpEndpoint: cachedTargetWsUrl,
      opencliHome: getOpenCliHome(),
      electronNode: process.versions.node,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
