// ============================================================
// Fastmail Notifier — Background Service Worker
// Handles: API token storage, JMAP polling, badge updates
// ============================================================

import { secureSet, secureGet, secureRemove } from "./crypto.js";

const POLL_ALARM_NAME = "fastmail-poll";
const POLL_INTERVAL_MINUTES = 1;

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
  // Validate the token works before storing by hitting the session endpoint
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

  // If we somehow lost accountId/apiUrl, re-discover
  let resolvedAccountId = accountId;
  let resolvedApiUrl = apiUrl;

  if (!resolvedAccountId || !resolvedApiUrl) {
    const resp = await fetch("https://api.fastmail.com/jmap/session", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      if (resp.status === 401) await clearAuth();
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
      [
        "Mailbox/query",
        { accountId: resolvedAccountId, filter: { role: "inbox" } },
        "0",
      ],
      [
        "Mailbox/get",
        {
          accountId: resolvedAccountId,
          "#ids": {
            resultOf: "0",
            name: "Mailbox/query",
            path: "/ids",
          },
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
    // Token has been revoked — clear and prompt re-entry
    await clearAuth();
    throw new Error("API token was revoked. Please add a new one.");
  }

  if (!resp.ok) throw new Error(`JMAP request failed: ${resp.status}`);

  const data = await resp.json();
  const mailboxGetResult = data.methodResponses?.find(
    ([name]) => name === "Mailbox/get"
  );

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
      // Not set up yet
      chrome.action.setBadgeText({ text: "" });
      return;
    }

    const text = count > 99 ? "99+" : count > 0 ? String(count) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({
      color: count > 0 ? "#E8334A" : "#666666",
    });

    chrome.storage.local.set({
      unreadCount: count,
      lastChecked: Date.now(),
      lastError: null,
    });
  } catch (err) {
    console.error("Fastmail Notifier poll error:", err.message);
    chrome.storage.local.set({ lastError: err.message });
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#FFA500" });
  }
}

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
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === "SIGN_OUT") {
    clearAuth()
      .then(() => {
        chrome.action.setBadgeText({ text: "" });
        chrome.storage.local.set({ unreadCount: 0, lastError: null });
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
    secureGet(["accessToken"])
      .then((auth) => {
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

chrome.runtime.onInstalled.addListener(() => {
  startPolling();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  startPolling();
  updateBadge();
});

// Ensure alarm is running (service workers can be killed and restarted)
chrome.alarms.get(POLL_ALARM_NAME, (alarm) => {
  if (!alarm) startPolling();
});
