// FDM Downloader — popup logic
//
// Everyday view is just the connection status + the intercept toggle; the
// pairing fields live in a collapsible "Connection" section that only opens
// itself when there's no token yet. The status auto-checks on open.

const DEFAULT_PORT = 53713;

const $token = document.getElementById("token");
const $port = document.getElementById("port");
const $save = document.getElementById("save");
const $test = document.getElementById("test");
const $reveal = document.getElementById("reveal");
const $intercept = document.getElementById("intercept");
const $status = document.getElementById("status");
const $setup = document.getElementById("setup");
const $summary = $setup.querySelector("summary");
const $msg = $status.querySelector(".msg");
const $update = document.getElementById("update");

// Compare dotted versions; returns >0 if a is newer than b.
function cmpVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function setStatus(state, text) {
  $status.classList.remove("ok", "fail");
  if (state === "ok" || state === "fail") $status.classList.add(state);
  $msg.textContent = text;
}

// Reflect "paired" in the collapsed summary so the closed section still tells
// you the connection is set up.
function markPaired(paired) {
  let badge = $summary.querySelector(".paired");
  if (paired) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "paired";
      badge.textContent = "Paired";
      $summary.insertBefore(badge, $summary.querySelector(".chev"));
    }
  } else if (badge) {
    badge.remove();
  }
}

// ---- Persisted config -------------------------------------------------------

async function load() {
  const { fdmToken = "", fdmPort = DEFAULT_PORT, fdmIntercept = true } =
    await chrome.storage.local.get(["fdmToken", "fdmPort", "fdmIntercept"]);
  $token.value = fdmToken;
  $port.value = fdmPort || DEFAULT_PORT;
  $intercept.checked = fdmIntercept !== false;
  const paired = !!fdmToken.trim();
  markPaired(paired);
  // Open the setup section only when there's nothing paired yet.
  $setup.open = !paired;
  // Auto-check the connection so the status is live without a click.
  test();
}

async function save() {
  const fdmToken = $token.value.trim();
  let fdmPort = parseInt($port.value, 10);
  if (!Number.isFinite(fdmPort) || fdmPort < 1 || fdmPort > 65535) {
    fdmPort = DEFAULT_PORT;
    $port.value = DEFAULT_PORT;
  }
  await chrome.storage.local.set({ fdmToken, fdmPort, fdmIntercept: !!$intercept.checked });
  markPaired(!!fdmToken);
}

// ---- Test connection --------------------------------------------------------

function test() {
  const port = parseInt($port.value, 10) || DEFAULT_PORT;
  setStatus("", "Checking…");
  chrome.runtime.sendMessage({ type: "fdm:ping", port }, (res) => {
    const err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      setStatus("fail", "FDM isn’t running (or wrong port).");
      return;
    }
    const v = res.version ? ` · v${res.version}` : "";
    if (!$token.value.trim()) {
      setStatus("ok", `FDM found${v} — paste a token below.`);
      $setup.open = true;
    } else {
      setStatus("ok", `Connected to FDM${v}.`);
    }
    // Nudge to re-setup when the app bundles a newer extension than the loaded one.
    const loaded = chrome.runtime.getManifest().version;
    const outdated = res.extVersion && cmpVersions(res.extVersion, loaded) > 0;
    $update.hidden = !outdated;
    if (outdated) {
      document.getElementById("update-msg").innerHTML =
        `FDM bundles <b>v${res.extVersion}</b> — you have <b>v${loaded}</b>. In FDM: ` +
        `<b>Settings → Browser extension → Set up</b>, then reload this extension in chrome://extensions.`;
    }
  });
}

// ---- Wire up ----------------------------------------------------------------

$save.addEventListener("click", async () => { await save(); test(); });
$test.addEventListener("click", async () => { await save(); test(); });

$reveal.addEventListener("click", () => {
  $token.type = $token.type === "password" ? "text" : "password";
});

$intercept.addEventListener("change", () => {
  chrome.storage.local.set({ fdmIntercept: !!$intercept.checked });
});

// Save automatically when the popup closes, so a pasted token isn't lost.
window.addEventListener("blur", save);

load();
