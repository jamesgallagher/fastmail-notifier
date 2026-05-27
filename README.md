# Fastmail Notifier

> A Chrome extension that displays your Fastmail unread message count as a live badge on the toolbar.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)

---

## Features

- **Live unread badge** — shows your Fastmail inbox unread count on the toolbar icon, updated every minute
- **API token auth** — uses a Fastmail API token; no password ever touched by the extension
- **Encrypted token storage** — the token is encrypted with AES-GCM-256 before anything is written to disk
- **Stays connected** — API tokens don't expire; the extension works indefinitely until you revoke it
- **Refresh on demand** — click the popup to check instantly
- **One-click inbox access** — the popup links directly to Fastmail

---

## Security

| Concern | How it's handled |
|---------|-----------------|
| Password exposure | Never asks for your password — uses a scoped API token only |
| Token storage | Encrypted with AES-GCM-256 before being written to disk |
| Encryption key | Derived via HKDF each session, held in memory only — never written to disk |
| Token scope | API tokens can be scoped to read-only mail access |
| Network | All requests over HTTPS to Fastmail's official JMAP API |
| Revocation | Revoke the token in Fastmail settings at any time — takes effect immediately |

### How token encryption works

```
API token (plaintext)
        │
        ▼
  AES-GCM-256 encrypt  ◄── unique 96-bit IV
        │              ◄── key held in chrome.storage.session (RAM only, never on disk)
        ▼
  enc:base64ciphertext  ──► chrome.storage.local (disk)
```

---

## Installation

### From the Chrome Web Store *(coming soon)*

### Manual install (Developer mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle, top right)
4. Click **Load unpacked** and select this folder
5. Follow the **Setup** steps below

---

## Setup

### 1. Generate an API token in Fastmail

1. Sign in to Fastmail
2. Go to [**Settings → Privacy & Security → API tokens**](https://app.fastmail.com/settings/security/tokens/new)
3. Click **New token**, give it a name (e.g. `Chrome Notifier`), and select at minimum:
   - `Mail - Read` access
4. Copy the token — you only see it once

### 2. Add the token to the extension

1. Click the Fastmail Notifier icon in your Chrome toolbar
2. Paste the token into the input field
3. Click **Connect to Fastmail**

The token is verified against Fastmail's API immediately, then encrypted and stored. The unread count will appear on the icon within seconds.

---

## Project Structure

```
fastmail-notifier/
├── manifest.json      # Extension config and permissions
├── background.js      # Service worker: token storage, JMAP polling, badge
├── crypto.js          # AES-GCM-256 encryption for token storage
├── popup.html         # Popup markup
├── popup.js           # Popup logic: setup, unread display, refresh
├── icons/             # Extension icons (16, 32, 48, 128px)
├── .gitignore
├── LICENSE
└── README.md
```

---

## How It Works

### First-time setup

```
User pastes API token → background.js validates against JMAP session endpoint
  → accountId and apiUrl stored
  → token encrypted and stored
  → polling starts
```

### Polling

The background service worker polls Fastmail's JMAP API every 60 seconds. Uses `Mailbox/query` + `Mailbox/get` to fetch the inbox unread count efficiently.

### Token security at rest

The API token is encrypted with AES-GCM-256 before storage. The encryption key is derived via HKDF from a random salt and your extension ID, held only in `chrome.storage.session` (browser memory). On disk, the token is always ciphertext.

---

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store encrypted token and unread count |
| `alarms` | Schedule polling every 60 seconds |
| `notifications` | *(Reserved)* Future desktop notifications for new mail |
| `https://api.fastmail.com/*` | JMAP API requests |
| `https://www.fastmail.com/*` | Token validation |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a pull request

---

## Roadmap

- [ ] Desktop notifications for new messages
- [ ] Configurable poll interval
- [ ] Multi-account support
- [ ] Firefox support
- [ ] Chrome Web Store listing

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

*Not affiliated with or endorsed by Fastmail Pty Ltd.*
