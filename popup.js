// ── Fastmail Notifier — Popup Script ────────────────────────
// Shown only when the user is not yet authenticated.
// After a successful token save the popup closes automatically.
// All post-auth actions (refresh, remove token) live in the
// right-click context menu managed by background.js.

const tokenInput  = document.getElementById("token-input");
const toggleVis   = document.getElementById("toggle-visibility");
const saveBtn     = document.getElementById("save-btn");
const setupError  = document.getElementById("setup-error");

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

// ── Init ──────────────────────────────────────────────────────
// If the user somehow opens this popup while already authenticated
// (e.g., a stale reference), close it immediately.

async function init() {
  try {
    const status = await sendMessage("GET_STATUS");
    if (status.isAuthenticated) {
      window.close();
    }
  } catch (err) {
    // Ignore — service worker may still be waking up; just show the form.
    console.warn("Popup init check:", err.message);
  }
}

// ── Show / hide token ─────────────────────────────────────────

toggleVis.addEventListener("click", () => {
  const isPassword = tokenInput.type === "password";
  tokenInput.type = isPassword ? "text" : "password";
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
      // Background has updated state; close the popup — left-click will
      // now open Fastmail directly and the context menu shows unread info.
      window.close();
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

// Allow submitting with Enter key
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

init();
