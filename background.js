// ============================================================
// Fastmail Notifier — Background Service Worker
// Handles: API token storage, JMAP polling, badge updates,
//          context menu, and left-click tab navigation.
// ============================================================

import { secureSet, secureGet, secureRemove } from "./crypto.js";

const POLL_ALARM_NAME = "fastmail-poll";
const POLL_INTERVAL_MINUTES = 1;

// Context menu item IDs
const MENU_UNREAD       = "fm-unread";
const MENU_LAST_CHECKED = "fm-last-checked";
const MENU_REFRESH      = "fm-refresh";
const MENU_SEPARATOR    = "fm-separator";
const MENU_TOKEN_ACTION = "fm-token-action"; // "Add API token" or "Remove API token"

// ── Icon generation ───────────────────────────────────────────
// Draws an envelope icon via OffscreenCanvas so we can swap
// between grey (unauthenticated) and Fastmail blue+yellow
// (authenticated) without shipping extra PNG files.

function createEnvelopeIcon(size, authenticated) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx    = canvas.getContext("2d");

  // Use almost all the canvas — tiny pad so corners aren't clipped
  const pad = Math.max(1, Math.round(size * 0.04));
  const x   = pad, y = pad;
  const w   = size - pad * 2, h = size - pad * 2;
  const r   = Math.max(2, Math.round(size * 0.13)); // corner radius

  const bodyColor = authenticated ? "#0067B8" : "#8896A5";
  const flapColor = authenticated ? "#FFB600" : "#A8B5C0";

  // ── Envelope body ──
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = bodyColor;
  ctx.fill();

  // ── Envelope flap (triangle at top, clipped to body shape) ──
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();

  const flapDepth = Math.round(h * 0.44); // how far down the V-point reaches
  ctx.beginPath();
  ctx.moveTo(x,         y);
  ctx.lineTo(x + w,     y);
  ctx.lineTo(x + w / 2, y + flapDepth);
  ctx.closePath();
  ctx.fillStyle = flapColor;
  ctx.fill();

  // Subtle divider line between flap and body
  ctx.beginPath();
  ctx.moveTo(x,         y);
  ctx.lineTo(x + w / 2, y + flapDepth);
  ctx.lineTo(x + w,     y);
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth   = Math.max(0.5, size * 0.025);
  ctx.stroke();

  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

async function setActionIcon(authenticated) {
  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    imageData[size] = createEnvelopeIcon(size, authenticated);
  }
  return new Promise((r) => chrome.action.setIcon({ imageData }, r));
}

// ── Helpers ───────────────────────────────────────────────────

function formatLastChecked(ts) {
  if (!ts) return "never checked";
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Open / focus Fastmail tab ─────────────────────────────────

async function openFastmailTab() {
  const tabs = await chrome.tabs.query({
    url: ["*://app.fastmail.com/*", "*://www.fastmail.com/*"],
  });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: "https://app.fastmail.com" });
  }
}

// ── Token Management (encrypted at rest via crypto.js) ───────

async function getStoredAuth() {
  return secureGet(["accessToken", "accountId", "apiUrl"]);
}

async function storeAuth(data) {
  return secureSet(data);
}

async function clearAuth() {
  return secureRemove(["accessToken", "accountId", "apiUrl"]);
}

// ── Save API token (called from popup) ───────────────────────

async function saveApiToken(token) {
  const resp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 401) throw new Error("Invalid token — please check and try again.");
  if (!resp.ok) throw new Error(`Fastmail returned ${resp.status} — please try again.`);

  const session = await resp.json();
  const accountId = Object.keys(session.accounts)[0];
  const apiUrl = session.apiUrl || "https://api.fastmail.com/jmap/api";

  await storeAuth({ accessToken: token, accountId, apiUrl });
}

// ── JMAP Mail Query ───────────────────────────────────────────

async function fetchUnreadCount() {
  const { accessToken, accountId, apiUrl } = await getStoredAuth();
  if (!accessToken) return null;

  let resolvedAccountId = accountId;
  let resolvedApiUrl = apiUrl;

  if (!resolvedAccountId || !resolvedApiUrl) {
    const resp = await fetch("https://api.fastmail.com/jmap/session", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        await clearAuth();
        await updateAuthUIState();
      }
      throw new Error(`Session error: ${resp.status}`);
    }
    const session = await resp.json();
    resolvedAccountId = Object.keys(session.accounts)[0];
    resolvedApiUrl = session.apiUrl || "https://api.fastmail.com/jmap/api";
    await storeAuth({ accountId: resolvedAccountId, apiUrl: resolvedApiUrl });
  }

  const body = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      ["Mailbox/query", { accountId: resolvedAccountId, filter: { role: "inbox" } }, "0"],
      [
        "Mailbox/get",
        {
          accountId: resolvedAccountId,
          "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" },
          properties: ["unreadEmails", "name"],
        },
        "1",
      ],
    ],
  };

  const resp = await fetch(resolvedApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    await clearAuth();
    await updateAuthUIState();
    throw new Error("API token was revoked. Please add a new one.");
  }

  if (!resp.ok) throw new Error(`JMAP request failed: ${resp.status}`);

  const data = await resp.json();
  const mailboxGetResult = data.methodResponses?.find(([name]) => name === "Mailbox/get");
  if (!mailboxGetResult) return 0;

  const mailboxes = mailboxGetResult[1]?.list || [];
  const inbox = mailboxes.find((m) => m.name?.toLowerCase() === "inbox");
  return inbox?.unreadEmails ?? 0;
}

// ── Badge Update ──────────────────────────────────────────────

async function updateBadge() {
  try {
    const count = await fetchUnreadCount();

    if (count === null) {
      // Not authenticated — badge stays blank, menus already set by updateAuthUIState
      chrome.action.setBadgeText({ text: "" });
      return;
    }

    const text = count > 99 ? "99+" : count > 0 ? String(count) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: count > 0 ? "#E8334A" : "#666666" });

    const lastChecked = Date.now();
    await new Promise((r) =>
      chrome.storage.local.set({ unreadCount: count, lastChecked, lastError: null }, r)
    );

    await setupContextMenus();
  } catch (err) {
    console.error("Fastmail Notifier poll error:", err.message);
    await new Promise((r) => chrome.storage.local.set({ lastError: err.message }, r));
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#FFA500" });
    await setupContextMenus();
  }
}

// ── Context Menus ─────────────────────────────────────────────

async function setupContextMenus() {
  await new Promise((r) => chrome.contextMenus.removeAll(r));

  const { accessToken } = await secureGet(["accessToken"]);
  const isAuthenticated = !!accessToken;

  if (isAuthenticated) {
    const data = await new Promise((r) =>
      chrome.storage.local.get(["unreadCount", "lastChecked", "lastError"], r)
    );
    const count     = data.unreadCount ?? 0;
    const lastError = data.lastError ?? null;

    const unreadTitle = lastError
      ? `⚠ Error — ${lastError}`
      : `📬 ${count} unread ${count === 1 ? "message" : "messages"}`;

    chrome.contextMenus.create({
      id: MENU_UNREAD,
      title: unreadTitle,
      contexts: ["action"],
      enabled: !lastError,
    });

    chrome.contextMenus.create({
      id: MENU_LAST_CHECKED,
      title: `Checked ${formatLastChecked(data.lastChecked ?? null)}`,
      contexts: ["action"],
      enabled: false,
    });

    chrome.contextMenus.create({
      id: MENU_REFRESH,
      title: "Refresh",
      contexts: ["action"],
    });

    chrome.contextMenus.create({
      id: MENU_SEPARATOR,
      type: "separator",
      contexts: ["action"],
    });

    chrome.contextMenus.create({
      id: MENU_TOKEN_ACTION,
      title: "Remove API token",
      contexts: ["action"],
    });
  } else {
    chrome.contextMenus.create({
      id: MENU_TOKEN_ACTION,
      title: "Add API token",
      contexts: ["action"],
    });
  }
}

// ── Auth UI State ─────────────────────────────────────────────
// Call this whenever auth state changes so the popup and context
// menus reflect the current state.

async function updateAuthUIState() {
  const { accessToken } = await secureGet(["accessToken"]);
  const isAuthenticated = !!accessToken;

  // Left-click: show popup when not authenticated, open Fastmail when authenticated.
  // onClicked only fires when popup is "" (empty).
  chrome.action.setPopup({ popup: isAuthenticated ? "" : "popup.html" });

  await setActionIcon(isAuthenticated);
  await setupContextMenus();
}

// ── Left-click: open Fastmail (authenticated only) ────────────

chrome.action.onClicked.addListener(async () => {
  await openFastmailTab();
});

// ── Context menu clicks ───────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU_UNREAD) {
    // Clicking the unread count also opens Fastmail
    await openFastmailTab();
    return;
  }

  if (info.menuItemId === MENU_REFRESH) {
    await updateBadge();
    return;
  }

  if (info.menuItemId === MENU_TOKEN_ACTION) {
    const { accessToken } = await secureGet(["accessToken"]);
    if (accessToken) {
      // Remove token
      await clearAuth();
      chrome.action.setBadgeText({ text: "" });
      await new Promise((r) =>
        chrome.storage.local.set({ unreadCount: 0, lastError: null }, r)
      );
      await updateAuthUIState();
    } else {
      // Open the popup so the user can enter a token
      if (typeof chrome.action.openPopup === "function") {
        chrome.action.openPopup();
      }
    }
    return;
  }
});

// ── Polling Alarm ─────────────────────────────────────────────

function startPolling() {
  chrome.alarms.create(POLL_ALARM_NAME, {
    delayInMinutes: 0,
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) updateBadge();
});

// ── Message Handling (from popup) ────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SAVE_TOKEN") {
    saveApiToken(msg.token)
      .then(() => updateBadge())
      .then(() => updateAuthUIState())
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === "SIGN_OUT") {
    clearAuth()
      .then(async () => {
        chrome.action.setBadgeText({ text: "" });
        await new Promise((r) =>
          chrome.storage.local.set({ unreadCount: 0, lastError: null }, r)
        );
        await updateAuthUIState();
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === "POLL_NOW") {
    updateBadge()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === "GET_STATUS") {
    secureGet(["accessToken"]).then((auth) => {
      chrome.storage.local.get(
        ["unreadCount", "lastChecked", "lastError"],
        (data) => {
          sendResponse({
            isAuthenticated: !!auth.accessToken,
            unreadCount: data.unreadCount ?? 0,
            lastChecked: data.lastChecked ?? null,
            lastError: data.lastError ?? null,
          });
        }
      );
    });
    return true;
  }
});

// ── Startup ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  startPolling();
  await updateAuthUIState();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  startPolling();
  await updateAuthUIState();
  await updateBadge();
});

// Re-initialize on service worker boot (service workers can be killed and restarted)
chrome.alarms.get(POLL_ALARM_NAME, (alarm) => {
  if (!alarm) startPolling();
});
updateAuthUIState();
