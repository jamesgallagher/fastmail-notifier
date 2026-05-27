# Fastmail Notifier

> A Chrome extension that displays your Fastmail unread message count as a live badge on the toolbar.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)

---

## Features

- **Live unread badge** — shows your Fastmail inbox unread count directly on the toolbar icon, updated every minute
- **OAuth 2.0 + PKCE** — authenticates through Fastmail's own login page; 2FA is fully supported with no special setup
- **Stays logged in** — access tokens are refreshed automatically in the background; re-login is only required if your session fully expires
- **Encrypted token storage** — tokens are never stored in plaintext; AES-GCM-256 encryption is applied before anything touches disk
- **Refresh on demand** — click the popup to check instantly without waiting for the next poll
- **One-click inbox access** — the popup links directly to Fastmail

---

## Security

This extension was designed with security as the primary concern.

| Concern | How it's handled |
|---------|-----------------|
| Password exposure | Never asks for your password — authentication goes through Fastmail's own OAuth login page |
| 2FA | Fully supported natively via the OAuth flow |
| Token storage | All tokens encrypted with AES-GCM-256 before being written to disk |
| Encryption key | Derived via HKDF each session and held in memory only (`chrome.storage.session`) — never written to disk |
| Token scope | OAuth scopes are limited to JMAP core + mail read access only |
| Network | All requests made over HTTPS to Fastmail's official API endpoints |

### How token encryption works

```
OAuth tokens (plaintext)
        │
        ▼
  AES-GCM-256 encrypt  ◄── unique 96-bit IV per value
        │              ◄── key held in chrome.storage.session (RAM only)
        ▼
  enc:base64ciphertext  ──► chrome.storage.local (disk)
```

The encryption key is derived via HKDF from a random salt (stored on disk) and your extension's unique ID. The key itself is never written to disk — it lives only in browser memory for the duration of your Chrome session. If Chrome is closed, the key is gone and re-derived transparently on next launch.

---

## Installation

### From the Chrome Web Store *(coming soon)*

Once published, you'll be able to install directly from the Chrome Web Store.

### Manual install (Developer mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle, top right)
4. Click **Load unpacked** and select this folder
5. Follow the **Setup** steps below to connect your Fastmail account

---

## Setup

You need to register a free OAuth application with Fastmail to get a `client_id`. This is a one-time step.

### 1. Get your extension's redirect URI

After loading the extension in developer mode, open DevTools on any page and run:

```js
chrome.identity.getRedirectURL("fastmail")
// e.g. → https://abcdefghijklmnop.chromiumapp.org/fastmail
```

Copy this URL — you'll need it in the next step.

### 2. Register an OAuth app with Fastmail

1. Sign in to Fastmail and go to **Settings → Security → OAuth Applications**
2. Click **Add new application** and fill in:
   - **Name**: `Fastmail Notifier`
   - **Redirect URI**: paste the URL from step 1
   - **Scopes**: `https://www.fastmail.com/dev/protocol-core` and `https://www.fastmail.com/dev/protocol-mail`
3. Copy the **Client ID** you receive

### 3. Add your Client ID

Open `manifest.json` and replace `YOUR_CLIENT_ID`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID_HERE",
  "scopes": [...]
}
```

Reload the extension in `chrome://extensions` and click the toolbar icon to sign in.

---

## Project Structure

```
fastmail-notifier/
├── manifest.json      # Extension config, permissions, OAuth scopes
├── background.js      # Service worker: OAuth, token refresh, JMAP polling, badge
├── crypto.js          # AES-GCM-256 encryption layer for token storage
├── popup.html         # Popup markup
├── popup.js           # Popup logic: auth state, unread display, refresh
├── icons/             # Extension icons (16, 32, 48, 128px)
├── .gitignore
├── LICENSE
└── README.md
```

---

## How It Works

### Authentication flow

```
Click "Sign in"
  → Chrome opens Fastmail's OAuth login page
  → User authenticates (password + 2FA if enabled)
  → Fastmail returns an authorisation code
  → Extension exchanges code for access + refresh tokens (PKCE)
  → Tokens encrypted and stored
  → JMAP session endpoint queried to get account ID
  → Polling starts
```

### Polling

The background service worker polls Fastmail's JMAP API every 60 seconds using a `chrome.alarms` timer. The call uses `Mailbox/query` + `Mailbox/get` to fetch the inbox unread count with minimal data transfer.

### Token refresh

Access tokens are silently refreshed 2 minutes before they expire using the stored refresh token. If the refresh token itself expires, the extension clears stored data and prompts the user to sign in again.

---

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store encrypted tokens and unread count |
| `alarms` | Schedule polling every 60 seconds |
| `identity` | Run the OAuth web authentication flow |
| `notifications` | *(Reserved)* Future desktop notifications for new mail |
| `https://api.fastmail.com/*` | JMAP API requests |
| `https://www.fastmail.com/*` | OAuth token exchange |

---

## Contributing

Contributions are welcome. Please open an issue before starting significant work so we can discuss the approach.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a pull request

---

## Roadmap

- [ ] Desktop notifications for new messages
- [ ] Configurable poll interval
- [ ] Multi-account support
- [ ] Firefox extension support (WebExtensions API compatible)
- [ ] Chrome Web Store listing

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

*Not affiliated with or endorsed by Fastmail Pty Ltd.*
