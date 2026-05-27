// ── Fastmail Notifier — Popup Script ────────────────────────

const loginBtn = document.getElementById("login-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const refreshBtn = document.getElementById("refresh-btn");
const unreadCount = document.getElementById("unread-count");
const unreadLabel = document.getElementById("unread-label");
const lastChecked = document.getElementById("last-checked");
const errorBanner = document.getElementById("error-banner");
const loginError = document.getElementById("login-error");
const badgeDot = document.getElementById("badge-dot");

// ── Helpers ───────────────────────────────────────────────────

function sendMessage(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (resp) => {
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

// ── Render state ──────────────────────────────────────────────

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

function renderUnauthenticated() {
  document.body.classList.remove("authenticated");
  loginError.classList.remove("visible");
}

// ── Load status on open ───────────────────────────────────────

async function init() {
  try {
    const status = await sendMessage("GET_STATUS");
    if (status.isAuthenticated) {
      renderAuthenticated(status);
    } else {
      renderUnauthenticated();
    }
  } catch (err) {
    console.error("Popup init error:", err);
  }
}

// ── Login button ──────────────────────────────────────────────

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  loginBtn.innerHTML = `<span class="loading-spinner"></span> Signing in…`;
  loginError.classList.remove("visible");

  try {
    const result = await sendMessage("START_AUTH");
    if (result.success) {
      const status = await sendMessage("GET_STATUS");
      renderAuthenticated(status);
    } else {
      loginError.textContent = result.error || "Authentication failed. Please try again.";
      loginError.classList.add("visible");
    }
  } catch (err) {
    loginError.textContent = err.message || "Something went wrong.";
    loginError.classList.add("visible");
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" fill="white" fill-opacity="0.2"/>
        <path d="M2 4l6 5 6-5" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="2" y="4" width="12" height="8" rx="1" stroke="white" stroke-width="1.4" fill="none"/>
      </svg>
      Sign in with Fastmail`;
  }
});

// ── Refresh button ────────────────────────────────────────────

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

// ── Sign out button ───────────────────────────────────────────

signOutBtn.addEventListener("click", async () => {
  signOutBtn.textContent = "Signing out…";
  signOutBtn.disabled = true;

  try {
    await sendMessage("SIGN_OUT");
    renderUnauthenticated();
  } catch (err) {
    console.error("Sign out error:", err);
  } finally {
    signOutBtn.disabled = false;
    signOutBtn.textContent = "Sign out of Fastmail";
  }
});

// ── Refresh last-checked time every 10s while popup is open ──

setInterval(async () => {
  if (document.body.classList.contains("authenticated")) {
    const status = await sendMessage("GET_STATUS").catch(() => null);
    if (status) lastChecked.textContent = "Checked " + formatLastChecked(status.lastChecked);
  }
}, 10_000);

init();
