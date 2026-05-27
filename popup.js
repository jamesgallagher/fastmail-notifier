// ── Fastmail Notifier — Popup Script ────────────────────────

const tokenInput      = document.getElementById("token-input");
const toggleVis       = document.getElementById("toggle-visibility");
const saveBtn         = document.getElementById("save-btn");
const signOutBtn      = document.getElementById("sign-out-btn");
const refreshBtn      = document.getElementById("refresh-btn");
const unreadCount     = document.getElementById("unread-count");
const unreadLabel     = document.getElementById("unread-label");
const lastChecked     = document.getElementById("last-checked");
const errorBanner     = document.getElementById("error-banner");
const setupError      = document.getElementById("setup-error");
const badgeDot        = document.getElementById("badge-dot");

// ── Helpers ───────────────────────────────────────────────────

function sendMessage(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function formatLastChecked(ts) {
  if (!ts) return "Never checked";
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Render ────────────────────────────────────────────────────

function renderAuthenticated(status) {
  document.body.classList.add("authenticated");

  const count = status.unreadCount ?? 0;
  unreadCount.textContent = count;
  unreadLabel.textContent = count === 1 ? "unread message" : "unread messages";

  if (count > 0) {
    badgeDot.textContent = count > 99 ? "99+" : String(count);
    badgeDot.classList.remove("hidden");
  } else {
    badgeDot.classList.add("hidden");
  }

  lastChecked.textContent = "Checked " + formatLastChecked(status.lastChecked);

  if (status.lastError) {
    errorBanner.textContent = "⚠ " + status.lastError;
    errorBanner.classList.add("visible");
  } else {
    errorBanner.classList.remove("visible");
  }
}

function renderSetup() {
  document.body.classList.remove("authenticated");
  tokenInput.value = "";
  setupError.classList.remove("visible");
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const status = await sendMessage("GET_STATUS");
    if (status.isAuthenticated) {
      renderAuthenticated(status);
    } else {
      renderSetup();
    }
  } catch (err) {
    console.error("Popup init error:", err);
  }
}

// ── Show/hide token ───────────────────────────────────────────

toggleVis.addEventListener("click", () => {
  const isPassword = tokenInput.type === "password";
  tokenInput.type = isPassword ? "text" : "password";
  // Swap eye icon
  document.getElementById("eye-icon").innerHTML = isPassword
    ? `<path d="M1 1l13 13M6.5 5.5A2.5 2.5 0 0110 9M4 4C2 5.5 1 7.5 1 7.5s3 4.5 6.5 4.5c1.2 0 2.3-.3 3.3-.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10.5 10.5C9.5 11.8 8.5 12 7.5 12 4 12 1 7.5 1 7.5s.8-1.5 2.5-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`
    : `<path d="M7.5 3C4 3 1 7.5 1 7.5s3 4.5 6.5 4.5S14 7.5 14 7.5 11 3 7.5 3z" stroke="currentColor" stroke-width="1.2"/><circle cx="7.5" cy="7.5" r="1.8" stroke="currentColor" stroke-width="1.2"/>`;
});

// ── Save token ────────────────────────────────────────────────

saveBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setupError.textContent = "Please paste your API token first.";
    setupError.classList.add("visible");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="loading-spinner"></span> Verifying…`;
  setupError.classList.remove("visible");

  try {
    const result = await sendMessage("SAVE_TOKEN", { token });
    if (result.success) {
      const status = await sendMessage("GET_STATUS");
      renderAuthenticated(status);
    } else {
      setupError.textContent = result.error || "Could not connect. Please check your token.";
      setupError.classList.add("visible");
    }
  } catch (err) {
    setupError.textContent = err.message || "Something went wrong.";
    setupError.classList.add("visible");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Connect to Fastmail";
  }
});

// ── Refresh ───────────────────────────────────────────────────

refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("spinning");
  lastChecked.textContent = "Checking…";
  try {
    await sendMessage("POLL_NOW");
    const status = await sendMessage("GET_STATUS");
    renderAuthenticated(status);
  } catch (err) {
    errorBanner.textContent = "⚠ " + err.message;
    errorBanner.classList.add("visible");
  } finally {
    setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
  }
});

// ── Remove token ──────────────────────────────────────────────

signOutBtn.addEventListener("click", async () => {
  signOutBtn.textContent = "Removing…";
  signOutBtn.disabled = true;
  try {
    await sendMessage("SIGN_OUT");
    renderSetup();
  } catch (err) {
    console.error("Remove token error:", err);
  } finally {
    signOutBtn.disabled = false;
    signOutBtn.textContent = "Remove API token";
  }
});

// ── Keep last-checked fresh ───────────────────────────────────

setInterval(async () => {
  if (document.body.classList.contains("authenticated")) {
    const status = await sendMessage("GET_STATUS").catch(() => null);
    if (status) lastChecked.textContent = "Checked " + formatLastChecked(status.lastChecked);
  }
}, 10_000);

init();
