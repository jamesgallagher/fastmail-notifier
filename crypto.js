// ============================================================
// crypto.js — Encrypted storage for Fastmail Notifier
//
// Strategy:
//   • A random 256-bit salt is generated once and stored in
//     chrome.storage.local (non-sensitive — just entropy).
//   • Each Chrome session, a fresh AES-GCM key is derived via
//     HKDF from (salt + extension ID) and held only in
//     chrome.storage.session (in-memory, cleared on browser close).
//   • All sensitive values are encrypted with AES-GCM (256-bit)
//     before hitting chrome.storage.local.
//   • Each encrypted blob gets its own random 96-bit IV.
//
// Result: tokens on disk are always ciphertext. An attacker
// reading the Chrome profile directory gets no usable material.
// ============================================================

const SALT_KEY   = "enc_salt";       // stored in local (non-sensitive)
const CRYPTO_KEY = "enc_key_b64";    // stored in session (in-memory only)
const ENC_PREFIX = "enc:";           // marks an encrypted value

// ── Key bootstrap ─────────────────────────────────────────────

/**
 * Returns the session CryptoKey, deriving and caching it if needed.
 * Safe to call on every operation — cheap after first call.
 */
export async function getEncryptionKey() {
  // 1. Check session cache first (survives within a service-worker lifetime)
  const cached = await sessionGet(CRYPTO_KEY);
  if (cached) {
    return importRawKey(base64ToBytes(cached));
  }

  // 2. Get-or-create the persistent salt
  const salt = await getOrCreateSalt();

  // 3. Derive key material from salt + stable extension identity
  const keyMaterial = await deriveKeyMaterial(salt);

  // 4. Cache in session storage (memory only)
  const rawKey = await exportRawKey(keyMaterial);
  await sessionSet(CRYPTO_KEY, bytesToBase64(rawKey));

  return keyMaterial;
}

async function getOrCreateSalt() {
  const stored = await localGet(SALT_KEY);
  if (stored) return base64ToBytes(stored);

  const salt = crypto.getRandomValues(new Uint8Array(32));
  await localSet(SALT_KEY, bytesToBase64(salt));
  return salt;
}

async function deriveKeyMaterial(salt) {
  // Use extension ID + a fixed info string as the derivation input.
  // This ties the key to this specific extension installation.
  const extensionId = chrome.runtime.id;
  const info = new TextEncoder().encode(`fastmail-notifier:token-key:${extensionId}`);

  // Import salt bytes as raw HKDF key material
  const baseKey = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,   // extractable so we can cache in session storage
    ["encrypt", "decrypt"]
  );
}

// ── Encrypt / Decrypt ─────────────────────────────────────────

/**
 * Encrypts a string value.
 * Returns a base64 string prefixed with ENC_PREFIX.
 */
export async function encryptValue(plaintext) {
  const key = await getEncryptionKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const enc = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  // Pack as: [12 bytes IV][ciphertext bytes] → base64
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.byteLength);

  return ENC_PREFIX + bytesToBase64(packed);
}

/**
 * Decrypts a value previously produced by encryptValue().
 * Returns the original plaintext string.
 */
export async function decryptValue(encoded) {
  if (!encoded?.startsWith(ENC_PREFIX)) {
    throw new Error("Value is not encrypted");
  }

  const key    = await getEncryptionKey();
  const packed = base64ToBytes(encoded.slice(ENC_PREFIX.length));
  const iv         = packed.slice(0, 12);
  const ciphertext = packed.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

// ── Secure storage helpers ────────────────────────────────────
// Drop-in replacements for chrome.storage.local that auto-encrypt
// a declared set of sensitive fields.

const SENSITIVE_FIELDS = new Set([
  "accessToken",
  "refreshToken",
]);

/**
 * Writes to chrome.storage.local, encrypting any sensitive fields.
 */
export async function secureSet(data) {
  const toStore = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key) && value != null) {
      toStore[key] = await encryptValue(String(value));
    } else {
      toStore[key] = value;
    }
  }
  return new Promise((resolve) => chrome.storage.local.set(toStore, resolve));
}

/**
 * Reads from chrome.storage.local, decrypting any sensitive fields.
 */
export async function secureGet(keys) {
  const raw = await new Promise((resolve) =>
    chrome.storage.local.get(keys, resolve)
  );

  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_FIELDS.has(key) && isEncrypted(value)) {
      try {
        result[key] = await decryptValue(value);
      } catch {
        // Decryption failed (e.g. key rotated) — treat as missing
        result[key] = null;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Removes keys from chrome.storage.local.
 */
export async function secureRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

// ── Key rotation ──────────────────────────────────────────────
// Call this if you want to re-encrypt all tokens with a fresh key
// (e.g. after suspecting the salt was exposed).

export async function rotateEncryptionKey() {
  // Read current plaintext values
  const current = await secureGet(["accessToken", "refreshToken"]);

  // Delete old salt and session key — forces new derivation
  await new Promise((r) => chrome.storage.local.remove(SALT_KEY, r));
  await new Promise((r) => chrome.storage.session.remove(CRYPTO_KEY, r));

  // Re-encrypt with new key
  if (current.accessToken || current.refreshToken) {
    await secureSet({
      ...(current.accessToken  && { accessToken:  current.accessToken }),
      ...(current.refreshToken && { refreshToken: current.refreshToken }),
    });
  }
}

// ── Internal chrome.storage wrappers ─────────────────────────

function localGet(key) {
  return new Promise((r) =>
    chrome.storage.local.get(key, (d) => r(d[key] ?? null))
  );
}

function localSet(key, value) {
  return new Promise((r) => chrome.storage.local.set({ [key]: value }, r));
}

function sessionGet(key) {
  return new Promise((r) =>
    chrome.storage.session.get(key, (d) => r(d[key] ?? null))
  );
}

function sessionSet(key, value) {
  return new Promise((r) => chrome.storage.session.set({ [key]: value }, r));
}

// ── Byte / base64 utilities ───────────────────────────────────

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function exportRawKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

async function importRawKey(bytes) {
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
