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

type HashtagResult = {
  name?: string;
  id?: string;
  view_count?: number;
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
  const mediaPublisherAdapterDir = path.join(opencliRoot, "clis", "media-publisher");
  const douyinAdapterDir = path.join(opencliRoot, "clis", "douyin");
  await fs.mkdir(mediaPublisherAdapterDir, { recursive: true });
  await fs.mkdir(douyinAdapterDir, { recursive: true });

  await fs.writeFile(
    path.join(opencliRoot, "apps.yaml"),
    [
      "apps:",
      "  media-publisher:",
      `    port: ${CDP_PORT}`,
      "    processName: Media Publisher",
      "    displayName: Media Publisher",
      "  douyin:",
      `    port: ${CDP_PORT}`,
      "    processName: Media Publisher",
      "    displayName: Media Publisher",
      ""
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(mediaPublisherAdapterDir, "open.js"),
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

  await fs.writeFile(
    path.join(douyinAdapterDir, "hashtag.js"),
    `import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';

function normalizeLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return Math.max(1, Math.min(20, Math.round(numeric)));
}

function parseCount(text) {
  const raw = String(text || '').replace(/,/g, '').trim();
  const match = raw.match(/([\\d.]+)\\s*(亿|万|w|W)?/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2];
  if (unit === '亿') return Math.round(value * 100000000);
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(value * 10000);
  return Math.round(value);
}

async function searchHashtags(page, keyword, limit) {
  const normalizedKeyword = String(keyword || '').trim().replace(/^#/, '');
  if (!normalizedKeyword) {
    throw new ArgumentError('keyword is required for hashtag search');
  }

  await page.goto('https://www.douyin.com/search/' + encodeURIComponent(normalizedKeyword) + '?type=video', {
    waitUntil: 'load',
    settleMs: 3000
  });
  await page.wait(3);

  const items = await page.evaluate('(' + ((keyword, limit) => {
    const normalized = String(keyword || '').trim().replace(/^#/, '');
    const candidates = [];
    const seen = new Set();

    const add = (name, id = '', viewText = '') => {
      const cleanName = String(name || '').trim().replace(/^#/, '');
      if (!cleanName || seen.has(cleanName)) return;
      seen.add(cleanName);
      candidates.push({ name: cleanName, id, viewText: String(viewText || '') });
    };

    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = anchor.href || '';
      const text = (anchor.textContent || '').replace(/\\s+/g, ' ').trim();
      const hashtagMatch = href.match(/\\/(?:hashtag|search)\\/([^/?#]+)/);
      if (href.includes('/hashtag/') && hashtagMatch?.[1]) {
        add(decodeURIComponent(hashtagMatch[1]), hashtagMatch[1], text);
      }
      for (const match of text.matchAll(/#([^#\\s]{1,40})/g)) {
        add(match[1], '', text);
      }
    }

    for (const node of Array.from(document.querySelectorAll('[class*="tag"], [class*="challenge"], [class*="topic"]'))) {
      const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      for (const match of text.matchAll(/#?([^#\\s]{1,40})/g)) {
        if (match[1] && text.includes(normalized)) add(match[1], '', text);
      }
    }

    if (!candidates.length) add(normalized);
    return candidates.slice(0, limit);
  }).toString() + ')(' + JSON.stringify(normalizedKeyword) + ', ' + JSON.stringify(limit) + ')');

  return (Array.isArray(items) ? items : []).map((item) => ({
    name: item.name || normalizedKeyword,
    id: item.id || '',
    view_count: parseCount(item.viewText)
  }));
}

cli({
  site: 'douyin',
  name: 'hashtag',
  description: '通过内嵌 Electron 浏览器进行话题搜索，不依赖 Browser Bridge',
  domain: 'www.douyin.com',
  strategy: Strategy.UI,
  navigateBefore: false,
  args: [
    { name: 'action', required: true, positional: true, choices: ['search', 'suggest', 'hot'], help: 'search=关键词搜索 suggest/hot=返回空列表' },
    { name: 'keyword', default: '', help: '搜索关键词' },
    { name: 'cover', default: '', help: '保留参数；内嵌浏览器模式暂不使用' },
    { name: 'limit', type: 'int', default: 10 }
  ],
  columns: ['name', 'id', 'view_count'],
  func: async (page, kwargs) => {
    const action = String(kwargs.action || '').trim();
    const limit = normalizeLimit(kwargs.limit);
    if (action === 'search') {
      return searchHashtags(page, kwargs.keyword, limit);
    }
    return [];
  }
});
`,
    "utf8"
  );

  await fs.writeFile(
    path.join(douyinAdapterDir, "comments.js"),
    `import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const MAX_LIMIT = 50;

function normalizeLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(numeric)));
}

function extractAwemeId(input) {
  const text = String(input || '').trim();
  if (/^\\d{8,30}$/.test(text)) return text;

  const patterns = [
    /\\/video\\/(\\d{8,30})/,
    /[?&]modal_id=(\\d{8,30})/,
    /[?&]aweme_id=(\\d{8,30})/,
    /aweme_id["']?\\s*[:=]\\s*["']?(\\d{8,30})/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

async function currentUrl(page) {
  return (await page.getCurrentUrl?.()) || (await page.evaluate('location.href'));
}

async function pageTitle(page) {
  try {
    return await page.evaluate('document.title');
  } catch {
    return '';
  }
}

async function findAwemeIdInPage(page) {
  const result = await page.evaluate('(' + (() => {
    const candidates = [window.location.href];
    for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, 300)) {
      candidates.push(anchor.href);
    }
    const scriptText = Array.from(document.scripts)
      .slice(0, 30)
      .map((script) => script.textContent || '')
      .join('\\n')
      .slice(0, 300000);
    candidates.push(scriptText);
    return candidates;
  }).toString() + ')()');

  for (const candidate of Array.isArray(result) ? result : []) {
    const awemeId = extractAwemeId(candidate);
    if (awemeId) return awemeId;
  }
  return '';
}

async function clickRandomVideo(page) {
  await page.goto('https://www.douyin.com/jingxuan', { waitUntil: 'load', settleMs: 3000 });
  await page.wait(5);
  await page.autoScroll?.({ times: 2, delayMs: 500 });

  const picked = await page.evaluate('(' + (() => {
    const nodes = Array.from(document.querySelectorAll([
      'a[href*="/video/"]',
      'a[href*="modal_id="]',
      '[data-aweme-id]',
      '.discover-video-card-item',
      '.jingxuanVideoCard',
      '.waterfall-videoCardContainer'
    ].join(',')));

    const candidates = nodes.filter((node) => {
      const awemeId = node.getAttribute('data-aweme-id') || node.closest('[data-aweme-id]')?.getAttribute('data-aweme-id') || '';
      const href = node.href || node.getAttribute('href') || node.querySelector?.('[href]')?.getAttribute('href') || '';
      if (!awemeId && !(/\\/video\\/\\d{8,30}/.test(href) || /modal_id=\\d{8,30}/.test(href))) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20;
    });

    if (!candidates.length) {
      return {
        ok: false,
        links: Array.from(document.querySelectorAll('a[href], [data-aweme-id], [href]')).slice(0, 20).map((node) => ({
          href: node.href || node.getAttribute('href') || '',
          aweme_id: node.getAttribute('data-aweme-id') || node.closest('[data-aweme-id]')?.getAttribute('data-aweme-id') || '',
          text: (node.textContent || '').trim().slice(0, 120)
        }))
      };
    }

    const visiblePool = candidates.slice(0, Math.min(candidates.length, 20));
    const selected = visiblePool[Math.floor(Math.random() * visiblePool.length)];
    const rawHref = selected.href || selected.getAttribute('href') || selected.querySelector?.('[href]')?.getAttribute('href') || '';
    const href = rawHref.startsWith('//') ? window.location.protocol + rawHref : rawHref;
    const awemeId =
      selected.getAttribute('data-aweme-id') ||
      selected.closest('[data-aweme-id]')?.getAttribute('data-aweme-id') ||
      (href.match(/\\/video\\/(\\d{8,30})/) || href.match(/[?&]modal_id=(\\d{8,30})/) || [])[1] ||
      '';
    selected.scrollIntoView({ block: 'center', inline: 'center' });
    const info = {
      ok: true,
      href,
      aweme_id: awemeId,
      text: (selected.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
    };
    selected.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    selected.click();
    return info;
  }).toString() + ')()');

  if (!picked?.ok) {
    throw new CommandExecutionError(
      'Could not find a clickable Douyin video on the current page',
      JSON.stringify(picked?.links || [], null, 2)
    );
  }

  await page.wait(5);
  if (picked.aweme_id) {
    await page.goto('https://www.douyin.com/video/' + picked.aweme_id, { waitUntil: 'load', settleMs: 3000 });
    await page.wait(3);
  } else if (picked.href) {
    await page.goto(picked.href, { waitUntil: 'load', settleMs: 3000 });
    await page.wait(3);
  }
  return picked;
}

async function findVideoOnCurrentPage(page, mode, query = '') {
  const picked = await page.evaluate('(' + ((mode, query) => {
    const normalizedQuery = String(query || '').replace(/^#/, '').toLowerCase();
    const nodes = Array.from(document.querySelectorAll([
      'a[href*="/video/"]',
      'a[href*="modal_id="]',
      '[data-aweme-id]',
      '.discover-video-card-item',
      '.search-result-card',
      '.jingxuanVideoCard',
      '.waterfall-videoCardContainer'
    ].join(',')));

    const candidates = nodes.filter((node) => {
      const awemeId = node.getAttribute('data-aweme-id') || node.closest('[data-aweme-id]')?.getAttribute('data-aweme-id') || '';
      const href = node.href || node.getAttribute('href') || node.querySelector?.('[href]')?.getAttribute('href') || '';
      if (!awemeId && !(/\\/video\\/\\d{8,30}/.test(href) || /modal_id=\\d{8,30}/.test(href))) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20;
    });

    if (!candidates.length) return { ok: false, count: nodes.length };

    const matching = normalizedQuery
      ? candidates.filter((node) => (node.textContent || '').toLowerCase().includes(normalizedQuery))
      : [];
    const pool = matching.length ? matching : candidates;
    const selected = mode === 'random'
      ? pool[Math.floor(Math.random() * Math.min(pool.length, 20))]
      : pool[0];
    const rawHref = selected.href || selected.getAttribute('href') || selected.querySelector?.('[href]')?.getAttribute('href') || '';
    const href = rawHref.startsWith('//') ? window.location.protocol + rawHref : rawHref;
    const awemeId =
      selected.getAttribute('data-aweme-id') ||
      selected.closest('[data-aweme-id]')?.getAttribute('data-aweme-id') ||
      (href.match(/\\/video\\/(\\d{8,30})/) || href.match(/[?&]modal_id=(\\d{8,30})/) || [])[1] ||
      '';

    selected.scrollIntoView({ block: 'center', inline: 'center' });
    return {
      ok: true,
      href,
      aweme_id: awemeId,
      matched: matching.length > 0,
      text: (selected.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
    };
  }).toString() + ')(' + JSON.stringify(mode) + ', ' + JSON.stringify(query) + ')');

  if (!picked?.ok) return null;
  return picked;
}

async function openFirstVideoForSearch(page, query) {
  const encoded = encodeURIComponent(String(query || '').trim());
  const urls = [
    'https://www.douyin.com/search/' + encoded + '?type=video',
    'https://www.douyin.com/search/' + encoded,
    'https://www.douyin.com/hashtag/' + encoded,
    'https://www.douyin.com/jingxuan'
  ];

  for (const url of urls) {
    await page.goto(url, { waitUntil: 'load', settleMs: 3000 });
    await page.wait(5);
    await page.autoScroll?.({ times: 2, delayMs: 500 });
    const picked = await findVideoOnCurrentPage(page, 'first', query);
    if (!picked) continue;

    if (picked.aweme_id) {
      await page.goto('https://www.douyin.com/video/' + picked.aweme_id, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(3);
    } else if (picked.href) {
      await page.goto(picked.href, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(3);
    }
    return picked;
  }

  throw new CommandExecutionError(
    'Could not find a Douyin video for hashtag/search keyword: ' + query,
    'Open the embedded browser and verify Douyin search results are visible for this keyword.'
  );
}

async function browserFetch(page, method, url, options = {}) {
  const payload = {
    url,
    method,
    headers: options.headers || {},
    body: options.body
  };

  const result = await page.evaluate('(' + (async (payload) => {
    const init = {
      method: payload.method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...payload.headers
      }
    };
    if (payload.body !== undefined) {
      init.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    }

    const response = await fetch(payload.url, init);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return {
        __opencli_fetch_error: true,
        status: response.status,
        statusText: response.statusText,
        body: text.slice(0, 800)
      };
    }

    if (!response.ok) {
      return {
        __opencli_fetch_error: true,
        status: response.status,
        statusText: response.statusText,
        data
      };
    }
    return data;
  }).toString() + ')(' + JSON.stringify(payload) + ')');

  if (result?.__opencli_fetch_error) {
    throw new CommandExecutionError(
      'Douyin comment fetch failed: HTTP ' + result.status,
      result.statusText || JSON.stringify(result.data || result.body || '')
    );
  }
  return result;
}

async function fetchDouyinComments(page, awemeId, limit) {
  const params = new URLSearchParams({
    aweme_id: awemeId,
    count: String(limit),
    cursor: '0',
    aid: '6383'
  });
  const data = await browserFetch(page, 'GET', 'https://www.douyin.com/aweme/v1/web/comment/list/?' + params.toString(), {
    headers: { referer: 'https://www.douyin.com/video/' + awemeId }
  });

  if (data && typeof data === 'object' && 'status_code' in data && data.status_code !== 0) {
    throw new CommandExecutionError(
      'Douyin API error ' + data.status_code + ': ' + (data.status_msg || 'unknown error'),
      'Open https://www.douyin.com/ in the embedded browser and log in or pass a visible video URL.'
    );
  }

  const comments = Array.isArray(data?.comments) ? data.comments : [];
  return comments.slice(0, limit).map((comment, index) => ({
    index: index + 1,
    cid: comment.cid || '',
    text: comment.text || '',
    nickname: comment.user?.nickname || '',
    sec_uid: comment.user?.sec_uid || '',
    digg_count: comment.digg_count ?? 0,
    reply_count: comment.reply_comment_total ?? 0,
    ip_label: comment.ip_label || '',
    create_time: comment.create_time ? new Date(Number(comment.create_time) * 1000).toISOString() : ''
  }));
}

cli({
  site: 'douyin',
  name: 'comments',
  description: '获取抖音作品评论；可传作品 URL/aweme_id/搜索关键词，或用 --random 随机打开精选页作品',
  domain: 'www.douyin.com',
  strategy: Strategy.UI,
  navigateBefore: false,
  timeoutSeconds: 90,
  args: [
    { name: 'target', type: 'string', required: false, positional: true, help: '作品 URL、aweme_id、搜索关键词，或 random' },
    { name: 'limit', type: 'int', default: 20, help: '评论数量，最大 50' },
    { name: 'random', type: 'bool', default: false, help: '从抖音精选页随机点开一个作品' }
  ],
  columns: ['aweme_id', 'video_url', 'title', 'picked_text', 'comment_count', 'comments'],
  func: async (page, kwargs) => {
    const target = String(kwargs.target || '').trim();
    const limit = normalizeLimit(kwargs.limit);
    const useRandom = kwargs.random === true || target.toLowerCase() === 'random' || !target;
    let picked = null;
    let awemeId = useRandom ? '' : extractAwemeId(target);

    if (useRandom) {
      picked = await clickRandomVideo(page);
      awemeId = picked.aweme_id || extractAwemeId(picked.href);
    } else if (/^https?:\\/\\//.test(target)) {
      await page.goto(target, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(3);
    } else if (awemeId) {
      await page.goto('https://www.douyin.com/video/' + awemeId, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(3);
    } else {
      picked = await openFirstVideoForSearch(page, target);
      awemeId = picked.aweme_id || extractAwemeId(picked.href);
    }

    awemeId = awemeId || extractAwemeId(await currentUrl(page)) || await findAwemeIdInPage(page);
    if (!awemeId) {
      throw new CommandExecutionError('Could not extract aweme_id from the current Douyin page');
    }

    const comments = await fetchDouyinComments(page, awemeId, limit);
    return [{
      aweme_id: awemeId,
      video_url: await currentUrl(page),
      title: await pageTitle(page),
      picked_text: picked?.text || '',
      comment_count: comments.length,
      comments
    }];
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
  const opencliHome = getOpenCliHome();
  const opencliEntry = pathToFileURL(getOpenCliEntry()).href;
  const bootstrap = [
    "process.argv = ['electron', ...process.argv.slice(1)];",
    `await import(${JSON.stringify(opencliEntry)});`
  ].join("\n");

  const childEnv = {
    ...process.env,
    HOME: opencliHome,
    USERPROFILE: opencliHome,
    OPENCLI_CACHE_DIR: path.join(opencliHome, ".opencli", "cache"),
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function runHashtagComments(keyword: string, cdpEndpoint: string): Promise<OpenUrlResult> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "Keyword is required."
    };
  }

  const hashtagSearch = await runOpenCli(
    ["douyin", "hashtag", "search", "--keyword", normalizedKeyword, "--limit", "1", "-f", "json"],
    cdpEndpoint
  );

  const hashtags = hashtagSearch.ok ? (asArray(hashtagSearch.data) as HashtagResult[]) : [];
  const hashtag = hashtags[0] ?? { name: normalizedKeyword, id: "", view_count: 0 };
  const searchWarning = hashtagSearch.ok
    ? hashtags.length
      ? ""
      : `No Douyin hashtag found for keyword: ${normalizedKeyword}; falling back to keyword video search.`
    : `douyin hashtag search failed; falling back to keyword video search.\n${hashtagSearch.stderr.trim() || hashtagSearch.stdout.trim()}`;

  const comments = await runOpenCli(["douyin", "comments", hashtag.name || normalizedKeyword, "--limit", "10", "-f", "json"], cdpEndpoint);
  const video = asArray(comments.data)[0] ?? null;
  const data = {
    keyword: normalizedKeyword,
    hashtag,
    hashtagSearch: hashtags,
    hashtagSearchOk: hashtagSearch.ok,
    video
  };

  return {
    ok: comments.ok,
    exitCode: comments.exitCode,
    stdout: comments.ok ? JSON.stringify(data, null, 2) : comments.stdout,
    stderr: [searchWarning.trim(), hashtagSearch.ok ? hashtagSearch.stderr.trim() : "", comments.stderr.trim()].filter(Boolean).join("\n\n"),
    data: comments.ok ? data : undefined
  };
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

ipcMain.handle("opencli:hashtag-comments", async (_event, keyword: string): Promise<OpenUrlResult> => {
  try {
    const cdpEndpoint = await resolveEmbeddedTargetWsUrl();
    return runHashtagComments(String(keyword), cdpEndpoint);
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
