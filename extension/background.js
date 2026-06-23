// FDM Downloader — background service worker (MV3)
//
// Responsibilities:
//   - Hold the shared config (pairing token + loopback port).
//   - Receive { url, kind, ... } messages from content.js and the popup.
//   - POST them to FDM's loopback ingest server with the X-FDM-Token header.
//   - Provide the right-click "Download with FDM" context menu.
//   - INTERCEPT browser-initiated downloads (IDM-style): when interception is
//     enabled and FDM is reachable, cancel + erase the Chrome download and hand
//     it to FDM instead — with the URL's cookies, referrer and User-Agent so
//     cookie/referer-gated direct downloads still succeed.
//   - Surface success / failure / not-paired state via the toolbar badge
//     and (where available) desktop notifications.
//
// The shared contract with the FDM desktop app:
//   GET  http://127.0.0.1:<port>/fdm/ping    -> 200 { ok:true, version }
//   POST http://127.0.0.1:<port>/fdm/ingest  -> 200 { ok:true } | 401
//        body:    { url, kind:"file"|"media", filename?, referrer?, cookie?,
//                   ua?, prompt? }
//        header:  X-FDM-Token: <token>

const DEFAULT_PORT = 53713;
const DEFAULT_HOST = "127.0.0.1";

// ----------------------------------------------------------------------------
// Config helpers
// ----------------------------------------------------------------------------

async function getConfig() {
  const {
    fdmToken = "",
    fdmPort = DEFAULT_PORT,
    fdmIntercept = true,
  } = await chrome.storage.local.get(["fdmToken", "fdmPort", "fdmIntercept"]);
  const port = Number(fdmPort) || DEFAULT_PORT;
  return { token: fdmToken, port, intercept: fdmIntercept !== false };
}

function baseUrl(port) {
  return `http://${DEFAULT_HOST}:${port || DEFAULT_PORT}`;
}

// ----------------------------------------------------------------------------
// Badge helpers (transient toast-like feedback on the toolbar icon)
// ----------------------------------------------------------------------------

let badgeTimer = null;

function flashBadge(text, color, ttlMs = 2500) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, ttlMs);
  } catch (_) {
    /* setBadge* can throw if the action is gone; ignore. */
  }
}

const badgeOk = () => flashBadge("✓", "#16a34a");
const badgeFail = () => flashBadge("!", "#dc2626", 4000);
const badgeSending = () => flashBadge("…", "#2563eb", 8000);

function notify(title, message) {
  // Notifications are best-effort; the permission may be denied by the user.
  if (!chrome.notifications || !chrome.notifications.create) return;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (_) {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// FDM ingest
// ----------------------------------------------------------------------------

async function pingFdm(portOverride) {
  const { port } = await getConfig();
  const usePort = portOverride || port;
  const res = await fetch(`${baseUrl(usePort)}/fdm/ping`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ping HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data; // { ok, version }
}

// ---- Reachability cache (used by download interception) ---------------------
//
// We can't afford to await a network round-trip inside onCreated for every
// download — and if FDM is down we must let the browser download normally
// without delay. So we keep a short-lived cached ping result and refresh it
// opportunistically in the background.

let reachable = false;
let lastPingAt = 0;
const PING_TTL_MS = 8000;

async function refreshReachable() {
  try {
    const data = await pingFdm();
    reachable = !!(data && data.ok !== false);
  } catch (_) {
    reachable = false;
  }
  lastPingAt = Date.now();
  return reachable;
}

// Returns the cached reachability synchronously, and kicks off a refresh if the
// cache is stale (fire-and-forget — the next download benefits from it).
function reachableCached() {
  if (Date.now() - lastPingAt > PING_TTL_MS) {
    refreshReachable();
  }
  return reachable;
}

// Sends a download to FDM. Returns { ok, status, error? }.
// Accepts the extended payload: { url, kind, filename?, referrer?, cookie?,
// ua?, prompt? }.
async function sendToFdm(payload) {
  const { url, kind } = payload || {};
  if (!url) return { ok: false, status: 0, error: "no-url" };

  const { token, port } = await getConfig();
  if (!token) {
    badgeFail();
    notify("FDM not paired", "Open the FDM Downloader popup and paste the pairing token from FDM Settings → Browser extension.");
    return { ok: false, status: 0, error: "no-token" };
  }

  const normalizedKind = kind === "media" ? "media" : "file";
  badgeSending();

  // Build the body with only the fields we actually have (keep it lean).
  const body = { url, kind: normalizedKind };
  if (payload.filename) body.filename = payload.filename;
  if (payload.referrer) body.referrer = payload.referrer;
  if (payload.cookie) body.cookie = payload.cookie;
  if (payload.ua) body.ua = payload.ua;
  if (payload.prompt) body.prompt = true;

  try {
    const res = await fetch(`${baseUrl(port)}/fdm/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FDM-Token": token,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      badgeFail();
      notify("FDM rejected the token", "The pairing token is wrong. Re-copy it from FDM Settings → Browser extension.");
      return { ok: false, status: 401, error: "bad-token" };
    }

    if (!res.ok) {
      badgeFail();
      notify("FDM ingest failed", `The FDM app returned HTTP ${res.status}.`);
      return { ok: false, status: res.status, error: `http-${res.status}` };
    }

    badgeOk();
    // A successful POST is also proof of reachability — keep the cache warm.
    reachable = true;
    lastPingAt = Date.now();
    return { ok: true, status: res.status };
  } catch (err) {
    // Almost always: FDM isn't running, or the port is wrong.
    badgeFail();
    reachable = false;
    lastPingAt = Date.now();
    notify("FDM isn't running", "Couldn't reach the FDM app on the loopback port. Start FDM and try again.");
    return { ok: false, status: 0, error: "unreachable" };
  }
}

// ----------------------------------------------------------------------------
// Cookie gathering for a URL → a single Cookie-header string
// ----------------------------------------------------------------------------

async function cookieHeaderForUrl(url) {
  if (!chrome.cookies || !chrome.cookies.getAll) return "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    // Render as a standard "k=v; k=v" Cookie header value.
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_) {
    return "";
  }
}

// ----------------------------------------------------------------------------
// Download interception (the headline IDM behaviour)
// ----------------------------------------------------------------------------

function isInterceptableUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Never touch in-memory / inline URLs — those aren't real network downloads
  // and FDM can't fetch them.
  if (lower.startsWith("blob:") || lower.startsWith("data:")) return false;
  if (lower.startsWith("filesystem:")) return false;
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
  return true;
}

// Pull the best filename Chrome knows about for a started download.
function filenameFromItem(item) {
  if (!item) return undefined;
  if (item.filename) {
    // item.filename may be a full path on disk; take the basename.
    const parts = item.filename.split(/[\\/]/);
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  return undefined;
}

async function handleInterception(item) {
  // Choose the URL FDM should fetch: the post-redirect final URL if known.
  const url = item.finalUrl || item.url;
  if (!isInterceptableUrl(url)) return;

  const { intercept } = await getConfig();
  if (!intercept) return;

  // Only intercept if FDM is currently reachable. If it's NOT, do nothing and
  // let the browser download normally — we must never break downloads.
  if (!reachableCached()) {
    // Cache may be cold on first run; do one synchronous-ish refresh attempt,
    // but bounded so we don't stall the download if FDM is down.
    const ok = await Promise.race([
      refreshReachable(),
      new Promise((resolve) => setTimeout(() => resolve(false), 600)),
    ]);
    if (!ok) return;
  }

  // Gather cookies + referrer + UA so cookie/referer-gated downloads succeed.
  const cookie = await cookieHeaderForUrl(url);

  // Cancel and erase the Chrome download so it doesn't also land on disk.
  try {
    await chrome.downloads.cancel(item.id);
  } catch (_) {
    /* may already be complete/canceled; ignore */
  }
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch (_) {
    /* ignore */
  }

  const res = await sendToFdm({
    url,
    kind: "file",
    filename: filenameFromItem(item),
    referrer: item.referrer || undefined,
    cookie: cookie || undefined,
    ua: navigator.userAgent,
  });

  if (res && res.ok) {
    notify("Handed to FDM", `${filenameFromItem(item) || url} is downloading in FDM.`);
  }
}

if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    // Fire-and-forget; never block the event loop on the download path.
    handleInterception(item).catch(() => {});
  });
}

// ----------------------------------------------------------------------------
// Message routing (content.js + popup.js)
// ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "fdm:send": {
      // content.js may pass referrer; gather cookies for the URL here so the
      // background (which holds the "cookies" permission) does the lookup.
      (async () => {
        const cookie = await cookieHeaderForUrl(msg.url);
        return sendToFdm({
          url: msg.url,
          kind: msg.kind,
          filename: msg.filename,
          referrer: msg.referrer,
          cookie: cookie || undefined,
          ua: navigator.userAgent,
          prompt: msg.prompt,
        });
      })().then(sendResponse);
      return true; // async
    }
    case "fdm:ping": {
      pingFdm(msg.port)
        .then((data) => {
          reachable = !!(data && data.ok !== false);
          lastPingAt = Date.now();
          sendResponse({ ok: true, ...data });
        })
        .catch((err) => {
          reachable = false;
          lastPingAt = Date.now();
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        });
      return true; // async
    }
    default:
      return; // not ours
  }
});

// ----------------------------------------------------------------------------
// Context menus
// ----------------------------------------------------------------------------

function rebuildContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "fdm-link",
      title: "Download with FDM",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: "fdm-image",
      title: "Save image with FDM",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "fdm-media",
      title: "Download video/audio with FDM",
      contexts: ["video", "audio"],
    });
    chrome.contextMenus.create({
      id: "fdm-page",
      title: "Download this page's video with FDM",
      contexts: ["page", "selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  rebuildContextMenus();
  refreshReachable();
});
chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
  refreshReachable();
});

// Helper: gather cookies for a URL then hand to FDM (used by context menus).
async function sendUrlWithCookies({ url, kind, referrer, filename }) {
  if (!url) return;
  const cookie = await cookieHeaderForUrl(url);
  return sendToFdm({
    url,
    kind,
    filename,
    referrer,
    cookie: cookie || undefined,
    ua: navigator.userAgent,
  });
}

chrome.contextMenus &&
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const pageUrl = info.pageUrl || (tab && tab.url) || undefined;
    if (info.menuItemId === "fdm-link") {
      // A direct file link.
      sendUrlWithCookies({ url: info.linkUrl, kind: "file", referrer: pageUrl });
    } else if (info.menuItemId === "fdm-image") {
      // "Save image as…" — cookie/referer-gated images succeed via headers.
      sendUrlWithCookies({ url: info.srcUrl, kind: "file", referrer: pageUrl });
    } else if (info.menuItemId === "fdm-media") {
      // A <video>/<audio> element: prefer its src, fall back to the page URL.
      const url = info.srcUrl || info.pageUrl || (tab && tab.url);
      sendUrlWithCookies({ url, kind: "media", referrer: pageUrl });
    } else if (info.menuItemId === "fdm-page") {
      // Whole-page social/video download via yt-dlp.
      const url = info.pageUrl || (tab && tab.url);
      sendUrlWithCookies({ url, kind: "media", referrer: pageUrl });
    }
  });
