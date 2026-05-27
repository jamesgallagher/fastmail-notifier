// ============================================================
// Fastmail Notifier — Background Service Worker
// Handles: OAuth token management, JMAP polling, badge updates
// ============================================================

import { secureSet, secureGet, secureRemove } from "./crypto.js";

const FASTMAIL_AUTH_URL = "https://www.fastmail.com/jmap/auth";
const FASTMAIL_JMAP_URL = "https://api.fastmail.com/jmap/api";
const POLL_ALARM_NAME = "fastmail-poll";
const POLL_INTERVAL_MINUTES = 1;

// ── Token Management (all sensitive fields encrypted at rest) ─

async function getStoredAuth() {
  // secureGet transparently decrypts accessToken + refreshToken
  return secureGet(["accessToken", "refreshToken", "apiUrl", "accountId", "tokenExpiry"]);
}

async function storeAuth(data) {
  // secureSet transparently encrypts accessToken + refreshToken
  return secureSet(data);
}

async function clearAuth() {
  return secureRemove(["accessToken", "refreshToken", "apiUrl", "accountId", "tokenExpiry"]);
}

// ── OAuth 2.0 via chrome.identity ────────────────────────────
// Uses chrome.identity.launchWebAuthFlow which opens a browser
// window to Fastmail's own login page — 2FA is handled natively.

export async function startOAuthFlow() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2.client_id;
  const redirectUrl = chrome.identity.getRedirectURL("fastmail");

  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store verifier temporarily
  await new Promise((r) =>
    chrome.storage.session.set({ oauthState: state, codeVerifier }, r)
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUrl,
    scope: manifest.oauth2.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `https://www.fastmail.com/oauth/auth?${params}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || "Auth cancelled"));
          return;
        }

        try {
          const url = new URL(responseUrl);
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");

          const session = await new Promise((r) =>
            chrome.storage.session.get(["oauthState", "codeVerifier"], r)
          );

          if (returnedState !== session.oauthState) {
            reject(new Error("OAuth state mismatch — possible CSRF"));
            return;
          }

          const tokens = await exchangeCodeForTokens(
            code,
            session.codeVerifier,
            redirectUrl,
            clientId
          );

          await storeAuth({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiry: Date.now() + tokens.expires_in * 1000,
          });

          // Discover JMAP session
          await discoverJmapSession(tokens.access_token);

          resolve(true);
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

async function exchangeCodeForTokens(code, verifier, redirectUri, clientId) {
  const resp = await fetch("https://www.fastmail.com/oauth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function refreshAccessToken() {
  const { refreshToken } = await getStoredAuth();

  if (!refreshToken) throw new Error("No refresh token");

  const manifest = chrome.runtime.getManifest();
  const redirectUrl = chrome.identity.getRedirectURL("fastmail");

  const resp = await fetch("https://www.fastmail.com/oauth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: manifest.oauth2.client_id,
      redirect_uri: redirectUrl,
    }),
  });

  if (!resp.ok) {
    // Refresh token expired — need re-login
    await clearAuth();
    throw new Error("Session expired. Please sign in again.");
  }

  const tokens = await resp.json();
  await storeAuth({
    accessToken: tokens.access_token,
    tokenExpiry: Date.now() + tokens.expires_in * 1000,
    ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
  });

  return tokens.access_token;
}

async function getValidToken() {
  const { accessToken, tokenExpiry } = await getStoredAuth();

  if (!accessToken) return null;

  // Refresh 2 minutes before expiry
  if (tokenExpiry && Date.now() > tokenExpiry - 120_000) {
    return refreshAccessToken();
  }

  return accessToken;
}

// ── JMAP Session Discovery ────────────────────────────────────

async function discoverJmapSession(token) {
  const resp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`JMAP session discovery failed: ${resp.status}`);

  const session = await resp.json();
  const accountId = Object.keys(session.accounts)[0];
  const apiUrl =
    session.apiUrl || "https://api.fastmail.com/jmap/api";

  await storeAuth({ accountId, apiUrl });
  return { accountId, apiUrl };
}

// ── JMAP Mail Query ───────────────────────────────────────────

async function fetchUnreadCount() {
  const token = await getValidToken();
  if (!token) return null;

  let { accountId, apiUrl } = await getStoredAuth();

  // Discover session if we don't have it yet
  if (!accountId || !apiUrl) {
    const session = await discoverJmapSession(token);
    accountId = session.accountId;
    apiUrl = session.apiUrl;
  }

  const body = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Mailbox/query",
        {
          accountId,
          filter: { role: "inbox" },
        },
        "0",
      ],
      [
        "Mailbox/get",
        {
          accountId,
          "#ids": {
            resultOf: "0",
            name: "Mailbox/query",
            path: "/ids",
          },
          properties: ["unreadEmails", "totalEmails", "name"],
        },
        "1",
      ],
    ],
  };

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    // Token rejected — try refresh once
    const newToken = await refreshAccessToken();
    return fetchUnreadCount(); // retry
  }

  if (!resp.ok) throw new Error(`JMAP request failed: ${resp.status}`);

  const data = await resp.json();
  const mailboxGetResult = data.methodResponses?.find(
    ([name]) => name === "Mailbox/get"
  );

  if (!mailboxGetResult) return 0;

  const mailboxes = mailboxGetResult[1]?.list || [];
  const inbox = mailboxes.find(
    (m) => m.name?.toLowerCase() === "inbox"
  );

  return inbox?.unreadEmails ?? 0;
}

// ── Badge Update ──────────────────────────────────────────────

async function updateBadge() {
  try {
    const count = await fetchUnreadCount();
    if (count === null) {
      // Not authenticated
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setBadgeBackgroundColor({ color: "#666666" });
      return;
    }

    const text = count > 99 ? "99+" : count > 0 ? String(count) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({
      color: count > 0 ? "#E8334A" : "#666666",
    });

    // Store for popup display
    await new Promise((r) =>
      chrome.storage.local.set(
        { unreadCount: count, lastChecked: Date.now(), lastError: null },
        r
      )
    );
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
  if (msg.type === "START_AUTH") {
    startOAuthFlow()
      .then(() => updateBadge())
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (msg.type === "SIGN_OUT") {
    clearAuth()
      .then(() => {
        chrome.action.setBadgeText({ text: "" });
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
    secureGet(["accessToken", "unreadCount", "lastChecked", "lastError"])
      .then((data) => {
        sendResponse({
          isAuthenticated: !!data.accessToken,
          unreadCount: data.unreadCount ?? 0,
          lastChecked: data.lastChecked ?? null,
          lastError: data.lastError ?? null,
        });
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

// Ensure alarm is running (service workers can be killed)
chrome.alarms.get(POLL_ALARM_NAME, (alarm) => {
  if (!alarm) startPolling();
});

// ── PKCE Helpers ──────────────────────────────────────────────

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
