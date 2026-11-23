// backend/lib/cryptoUtils.js — AES-256-GCM token encryption/decryption utility
// NEVER log or expose these values. Used server-side only.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // GCM standard 12-byte IV
const TAG_LENGTH = 16;  // GCM authentication tag length in bytes

/**
 * Validate and return the 32-byte encryption key from environment.
 * Accepts TOKEN_ENCRYPTION_KEY or SALESFORCE_TOKEN_ENCRYPTION_KEY.
 * Key must be a 64-character hex string (32 bytes).
 */
export function getEncryptionKey() {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY || process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error('[CryptoUtils] TOKEN_ENCRYPTION_KEY (or SALESFORCE_TOKEN_ENCRYPTION_KEY) environment variable is not set.');
  }
  if (typeof hexKey !== 'string' || hexKey.trim().length !== 64) {
    throw new Error('[CryptoUtils] TOKEN_ENCRYPTION_KEY (or SALESFORCE_TOKEN_ENCRYPTION_KEY) must be a 64-character hex string (32 bytes).');
  }
  const keyBuffer = Buffer.from(hexKey.trim(), 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('[CryptoUtils] Encryption key does not decode to exactly 32 bytes.');
  }
  return keyBuffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns { ciphertext, iv, tag } — all as hex strings.
 * A fresh random IV is generated on every call.
 */
export function encryptToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('[CryptoUtils] encryptToken: plaintext must be a non-empty string.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt a token using AES-256-GCM.
 * Verifies authentication tag — throws if tampered.
 * @param {{ ciphertext: string, iv: string, tag: string }} encrypted
 */
export function decryptToken({ ciphertext, iv, tag }) {
  if (!ciphertext || !iv || !tag) {
    throw new Error('[CryptoUtils] decryptToken: ciphertext, iv, and tag are all required.');
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
    { authTagLength: TAG_LENGTH }
  );

  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  try {
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('[CryptoUtils] decryptToken: Authentication tag verification failed. Token may be corrupted or tampered.');
  }
}

/**
 * Encrypt a token to compact string "enc:<ciphertext>:<iv>:<tag>"
 */
export function safeEncryptToken(token) {
  if (!token || typeof token !== 'string') return token;
  const { ciphertext, iv, tag } = encryptToken(token);
  return `enc:${ciphertext}:${iv}:${tag}`;
}

/**
 * Decrypt a token if prefixed with "enc:", otherwise return plaintext fallback.
 */
export function safeDecryptToken(token) {
  if (!token || typeof token !== 'string') return token;
  if (!token.startsWith('enc:')) return token; // graceful fallback for unencrypted tokens
  const parts = token.slice(4).split(':');
  if (parts.length !== 3) return token;
  const [ciphertext, iv, tag] = parts;
  try {
    return decryptToken({ ciphertext, iv, tag });
  } catch (err) {
    console.error('[CryptoUtils] safeDecryptToken failed:', err.message);
    return token;
  }
}

/**
 * Validate that the encryption key env variable is properly configured.
 * Call this at startup to fail fast if misconfigured.
 */
export function validateEncryptionKey() {
  try {
    getEncryptionKey();
    return true;
  } catch (err) {
    console.error('[CryptoUtils] Encryption key validation failed:', err.message);
    return false;
  }
}
