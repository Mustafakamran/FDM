// FDM Downloader — content script
//
// Runs on every page. Two jobs:
//   (a) Decorate DIRECT download links (anchors whose href ends in a known
//       downloadable extension) with a small, tasteful "⬇ FDM" button that
//       appears on hover and sends { url, kind:"file" } to the background.
//   (b) On YouTube, inject a "Download with FDM" control INTO the player's
//       right-controls cluster. On other media/social sites or any generic
//       <video>, anchor a "⬇ FDM" button to the TOP-RIGHT CORNER of that
//       specific video element. Both send { url: location.href, kind:"media" }.
//
// All UI is rendered inside a single closed-ish ShadowRoot host appended to
// <html>, so the page's CSS can't clobber our styling and ours can't leak.

(function () {
  "use strict";

  // Guard against double-injection (e.g. bfcache restores, manual re-inject).
  if (window.__fdmDownloaderInjected) return;
  window.__fdmDownloaderInjected = true;

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  const DOWNLOADABLE_EXTS = new Set([
    // archives
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz",
    // video
    "mp4", "mov", "mkv", "webm", "avi", "flv", "m4v", "wmv", "mpg", "mpeg",
    // audio
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff",
    // docs
    "pdf", "epub", "mobi",
    // disk images / installers
    "dmg", "exe", "iso", "msi", "pkg", "deb", "rpm", "appimage", "apk",
    // images / design
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg",
    "psd", "ai", "eps", "raw", "cr2", "nef", "arw", "dng",
    // data / misc
    "csv", "json", "xml", "sql", "bin", "img",
  ]);

  // Hostnames where a whole-page "media" download (yt-dlp) makes sense.
  const MEDIA_HOSTS = [
    "youtube.com", "youtu.be", "m.youtube.com",
    "instagram.com",
    "tiktok.com",
    "x.com", "twitter.com", "mobile.twitter.com",
    "facebook.com", "fb.watch", "m.facebook.com",
    "vimeo.com",
    "dailymotion.com",
    "twitch.tv",
    "reddit.com",
    "soundcloud.com",
    "bilibili.com",
    "pinterest.com",
    "linkedin.com",
  ];

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  function send(url, kind, onResult) {
    try {
      chrome.runtime.sendMessage(
        { type: "fdm:send", url, kind, referrer: location.href },
        (res) => {
          // chrome.runtime.lastError is read to avoid "Unchecked runtime.lastError".
          const err = chrome.runtime.lastError;
          if (typeof onResult === "function") onResult(err ? { ok: false } : res);
        }
      );
    } catch (_) {
      if (typeof onResult === "function") onResult({ ok: false });
    }
  }

  // --------------------------------------------------------------------------
  // Shadow host + styles
  // --------------------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "fdm-downloader-host";
  // Keep the host itself out of the page's layout/flow entirely.
  host.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .fdm-btn {
      position: absolute;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: linear-gradient(180deg, #3b82f6, #2563eb);
      border: 1px solid rgba(0,0,0,.15);
      border-radius: 6px;
      padding: 4px 7px;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.25);
      white-space: nowrap;
      user-select: none;
      pointer-events: auto;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity .12s ease, transform .12s ease, background .12s ease;
    }
    .fdm-btn.fdm-show { opacity: 1; transform: translateY(0); }
    .fdm-btn:hover { background: linear-gradient(180deg, #2563eb, #1d4ed8); }
    .fdm-btn:active { transform: translateY(1px); }
    .fdm-btn.fdm-ok   { background: linear-gradient(180deg, #22c55e, #16a34a); }
    .fdm-btn.fdm-fail { background: linear-gradient(180deg, #ef4444, #dc2626); }

    /* A compact button anchored to the TOP-RIGHT CORNER of a specific <video>. */
    .fdm-vbtn {
      position: absolute;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: linear-gradient(180deg, rgba(59,130,246,.96), rgba(37,99,235,.96));
      border: 1px solid rgba(0,0,0,.25);
      border-radius: 8px;
      padding: 7px 11px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.4);
      pointer-events: auto;
      user-select: none;
      white-space: nowrap;
      transition: background .15s ease, transform .12s ease, opacity .15s ease;
    }
    .fdm-vbtn:hover { transform: translateY(-1px); background: linear-gradient(180deg, #2563eb, #1d4ed8); }
    .fdm-vbtn:active { transform: translateY(0); }
    .fdm-vbtn.fdm-ok   { background: linear-gradient(180deg, #22c55e, #16a34a); }
    .fdm-vbtn.fdm-fail { background: linear-gradient(180deg, #ef4444, #dc2626); }
    .fdm-ico { font-size: 13px; line-height: 1; }
  `;
  shadow.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "fdm-layer";
  shadow.appendChild(layer);

  function mountHost() {
    if (!host.isConnected) {
      (document.documentElement || document.body).appendChild(host);
    }
  }

  // --------------------------------------------------------------------------
  // (a) Direct-link hover buttons
  // --------------------------------------------------------------------------

  // We use ONE shared button element that follows the hovered anchor. This is
  // far lighter than injecting a button per-link on large pages.
  const linkBtn = document.createElement("button");
  linkBtn.className = "fdm-btn";
  linkBtn.type = "button";
  linkBtn.innerHTML = `<span class="fdm-ico">⬇</span><span>FDM</span>`;
  layer.appendChild(linkBtn);

  let currentAnchor = null;
  let hideTimer = null;

  function isDownloadableHref(href) {
    if (!href) return false;
    let u;
    try {
      u = new URL(href, location.href);
    } catch (_) {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Strip query/hash, take the last path segment's extension.
    const path = u.pathname;
    const lastDot = path.lastIndexOf(".");
    if (lastDot < 0) return false;
    const ext = path.slice(lastDot + 1).toLowerCase();
    return DOWNLOADABLE_EXTS.has(ext);
  }

  function positionButton(anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    // Place at the top-right corner of the anchor, nudged slightly outward.
    const btnW = 56; // approx; exact width not critical
    let left = r.right - btnW;
    let top = r.top - 4;
    // Keep it on-screen. Coordinates are viewport-relative: the layer lives
    // inside a position:fixed host, so absolute offsets match
    // getBoundingClientRect() directly (no scroll offset needed).
    left = Math.max(2, Math.min(left, window.innerWidth - btnW - 2));
    top = Math.max(2, top);
    linkBtn.style.left = `${left}px`;
    linkBtn.style.top = `${top}px`;
    return true;
  }

  function showButtonFor(anchor) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    currentAnchor = anchor;
    mountHost();
    linkBtn.classList.remove("fdm-ok", "fdm-fail");
    linkBtn.innerHTML = `<span class="fdm-ico">⬇</span><span>FDM</span>`;
    if (positionButton(anchor)) {
      linkBtn.classList.add("fdm-show");
    }
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      linkBtn.classList.remove("fdm-show");
      currentAnchor = null;
    }, 220);
  }

  // Delegate hover detection on the document.
  document.addEventListener(
    "mouseover",
    (e) => {
      const anchor = e.target && e.target.closest && e.target.closest("a[href]");
      if (anchor && isDownloadableHref(anchor.href)) {
        showButtonFor(anchor);
      }
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      // Only hide if we're leaving the anchor and not entering the button.
      const to = e.relatedTarget;
      if (to && (to === linkBtn || (to.closest && to.closest("#fdm-downloader-host")))) return;
      const anchor = e.target && e.target.closest && e.target.closest("a[href]");
      if (anchor && anchor === currentAnchor) scheduleHide();
    },
    true
  );

  linkBtn.addEventListener("mouseenter", () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  linkBtn.addEventListener("mouseleave", scheduleHide);

  linkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentAnchor) return;
    const url = currentAnchor.href;
    linkBtn.innerHTML = `<span class="fdm-ico">…</span><span>FDM</span>`;
    send(url, "file", (res) => {
      if (res && res.ok) {
        linkBtn.classList.add("fdm-ok");
        linkBtn.innerHTML = `<span class="fdm-ico">✓</span><span>Sent</span>`;
      } else {
        linkBtn.classList.add("fdm-fail");
        linkBtn.innerHTML = `<span class="fdm-ico">✕</span><span>Failed</span>`;
      }
      setTimeout(() => {
        linkBtn.classList.remove("fdm-ok", "fdm-fail");
        linkBtn.classList.remove("fdm-show");
        currentAnchor = null;
      }, 1400);
    });
  });

  // Keep the button glued to its anchor while scrolling.
  window.addEventListener(
    "scroll",
    () => {
      if (currentAnchor && linkBtn.classList.contains("fdm-show")) {
        if (!positionButton(currentAnchor)) {
          linkBtn.classList.remove("fdm-show");
          currentAnchor = null;
        }
      }
    },
    true
  );

  // --------------------------------------------------------------------------
  // (b) Media "Download with FDM" button
  //
  // Two placements, IDM-style:
  //   - YouTube: a real player control injected INTO .ytp-right-controls, next
  //     to settings / fullscreen, so it lives with the native buttons.
  //   - Any other media/social site or a generic sized <video>: a button
  //     anchored to the TOP-RIGHT CORNER of that specific <video>, positioned
  //     over the video (tracked via the shadow-root overlay layer).
  // --------------------------------------------------------------------------

  function isMediaHost() {
    const h = location.hostname.replace(/^www\./, "");
    return MEDIA_HOSTS.some((m) => h === m || h.endsWith("." + m));
  }

  function isYouTube() {
    const h = location.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
  }

  // Click handler shared by both placements: send the page URL as media.
  function sendMediaFrom(btn, setLabel) {
    const url = location.href;
    if (setLabel) setLabel("Sending…");
    send(url, "media", (res) => {
      if (res && res.ok) {
        btn.classList.add("fdm-ok");
        if (setLabel) setLabel("Sent ✓");
      } else {
        btn.classList.add("fdm-fail");
        if (setLabel) setLabel("Failed");
      }
      setTimeout(() => {
        btn.classList.remove("fdm-ok", "fdm-fail");
        if (setLabel) setLabel(null);
      }, 2200);
    });
  }

  // ---- YouTube: inject a .ytp-button control into .ytp-right-controls -------

  const YT_BTN_ID = "fdm-yt-button";

  function buildYouTubeButton() {
    const right = document.querySelector(".ytp-right-controls");
    if (!right) return false;
    if (right.querySelector("#" + YT_BTN_ID)) return true; // de-duped

    const btn = document.createElement("button");
    btn.id = YT_BTN_ID;
    btn.className = "ytp-button";
    btn.title = "Download with FDM";
    btn.setAttribute("aria-label", "Download with FDM");
    // 36x36 viewBox to match native YouTube control icons; a download arrow.
    btn.innerHTML =
      '<svg height="100%" viewBox="0 0 36 36" width="100%" fill="#fff">' +
      '<path d="M18 21.5l-5-5h3.2V10h3.6v6.5H26z" />' +
      '<path d="M11 24.5h14v2H11z" />' +
      "</svg>";
    btn.style.verticalAlign = "top";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.style.opacity = "0.6";
      sendMediaFrom(btn, null);
      setTimeout(() => {
        btn.style.opacity = "";
      }, 2200);
    });

    // Insert as the first of the right-controls (before settings) so it sits
    // alongside the native settings / fullscreen cluster.
    right.insertBefore(btn, right.firstChild);
    return true;
  }

  function refreshYouTubeButton() {
    // YouTube re-renders the player chrome on navigation; (re)inject if needed.
    buildYouTubeButton();
  }

  // ---- Generic <video>: a corner button tracked over the element ----------
  //
  // We keep at most a handful of tracked videos. Each gets one overlay button
  // in our shadow layer, kept positioned at the video's top-right corner.

  const tracked = new Map(); // video element -> { btn }

  function isSizedVideo(v) {
    const r = v.getBoundingClientRect();
    return r.width >= 160 && r.height >= 90;
  }

  function makeVideoButton(video) {
    const btn = document.createElement("button");
    btn.className = "fdm-vbtn";
    btn.type = "button";
    btn.innerHTML = `<span class="fdm-ico">⬇</span><span class="fdm-vlabel">FDM</span>`;
    const label = btn.querySelector(".fdm-vlabel");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendMediaFrom(btn, (t) => {
        label.textContent = t == null ? "FDM" : t;
      });
    });
    layer.appendChild(btn);
    return btn;
  }

  function positionVideoButton(video, btn) {
    const r = video.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      btn.style.display = "none";
      return;
    }
    // Off-screen videos: hide the button.
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    // Top-right corner of the video, nudged inside by a small margin.
    const margin = 8;
    const btnW = btn.offsetWidth || 64;
    let left = r.right - btnW - margin;
    let top = r.top + margin;
    left = Math.max(2, Math.min(left, window.innerWidth - btnW - 2));
    top = Math.max(2, top);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
  }

  function refreshVideoButtons() {
    // On YouTube we use the player control instead of corner buttons.
    if (isYouTube()) {
      // Tear down any stray corner buttons (e.g. after navigating into YT).
      for (const [video, entry] of tracked) {
        if (entry.btn && entry.btn.parentNode) entry.btn.parentNode.removeChild(entry.btn);
        tracked.delete(video);
      }
      return;
    }

    const live = new Set();
    const vids = document.querySelectorAll("video");
    for (const v of vids) {
      if (!isSizedVideo(v)) continue;
      live.add(v);
      if (!tracked.has(v)) {
        mountHost();
        tracked.set(v, { btn: makeVideoButton(v) });
      }
    }
    // Remove buttons for videos that vanished or shrank away.
    for (const [video, entry] of tracked) {
      if (!live.has(video) || !video.isConnected) {
        if (entry.btn && entry.btn.parentNode) entry.btn.parentNode.removeChild(entry.btn);
        tracked.delete(video);
      }
    }
    repositionAll();
  }

  function repositionAll() {
    for (const [video, entry] of tracked) {
      positionVideoButton(video, entry.btn);
    }
  }

  function refreshMedia() {
    if (isYouTube()) {
      refreshYouTubeButton();
      refreshVideoButtons(); // clears corner buttons on YT
    } else if (isMediaHost() || document.querySelector("video")) {
      refreshVideoButtons();
    }
  }

  // Keep corner buttons glued to their videos while scrolling / resizing.
  window.addEventListener("scroll", repositionAll, true);
  window.addEventListener("resize", repositionAll, true);

  // --------------------------------------------------------------------------
  // SPA awareness: observe DOM mutations + URL changes (debounced).
  // --------------------------------------------------------------------------

  let lastUrl = location.href;
  let debounceTimer = null;

  function onMaybeChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // New "page" in an SPA — drop the old YouTube button so it re-injects
        // into the fresh player chrome.
        const stale = document.getElementById(YT_BTN_ID);
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      }
      refreshMedia();
    }, 400);
  }

  const observer = new MutationObserver(onMaybeChanged);
  function startObserving() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      // body not ready yet
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  // Patch history methods so SPA navigations trigger a re-check.
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const ret = orig.apply(this, arguments);
      window.dispatchEvent(new Event("fdm:locationchange"));
      return ret;
    };
  });
  window.addEventListener("popstate", onMaybeChanged);
  window.addEventListener("fdm:locationchange", onMaybeChanged);

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------

  function boot() {
    mountHost();
    startObserving();
    refreshMedia();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
