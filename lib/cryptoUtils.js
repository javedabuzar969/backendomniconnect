// backend/lib/cryptoUtils.js — AES-256-GCM token encryption/decryption utility
// NEVER log or expose these values. Used server-side only.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // GCM standard 12-byte IV
const TAG_LENGTH = 16;  // GCM authentication tag length in bytes

/**
 * Validate and return the 32-byte encryption key from environment.
 * Key must be a 64-character hex string (32 bytes).
 */
function getEncryptionKey() {
  const hexKey = process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error('[CryptoUtils] SALESFORCE_TOKEN_ENCRYPTION_KEY environment variable is not set.');
  }
  if (typeof hexKey !== 'string' || hexKey.trim().length !== 64) {
    throw new Error('[CryptoUtils] SALESFORCE_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  const keyBuffer = Buffer.from(hexKey.trim(), 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('[CryptoUtils] SALESFORCE_TOKEN_ENCRYPTION_KEY does not decode to exactly 32 bytes.');
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
