// Crypto Module - AES-GCM encryption for credentials storage
// Uses Web Crypto API for secure encryption/decryption

const CryptoModule = (() => {
  // Encryption key derived from extension ID (unique per installation)
  const SALT = 'page-translator-v1';
  const ITERATIONS = 100000;
  const KEY_LENGTH = 256;

  /**
   * Get or generate a unique device key based on extension context
   */
  async function getDeviceKey() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ _deviceKey: null }, async (result) => {
        if (result._deviceKey) {
          resolve(result._deviceKey);
        } else {
          // Generate a random key for this installation
          const array = new Uint8Array(32);
          crypto.getRandomValues(array);
          const key = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
          await chrome.storage.local.set({ _deviceKey: key });
          resolve(key);
        }
      });
    });
  }

  /**
   * Derive an encryption key from the device key
   */
  async function deriveKey(deviceKey) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(deviceKey),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(SALT),
        iterations: ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt a string value
   * @param {string} plaintext - The text to encrypt
   * @returns {Promise<string>} - Base64 encoded encrypted data with IV
   */
  async function encrypt(plaintext) {
    if (!plaintext) return '';
    
    try {
      const deviceKey = await getDeviceKey();
      const key = await deriveKey(deviceKey);
      const encoder = new TextEncoder();
      const data = encoder.encode(plaintext);
      
      // Generate random IV for each encryption
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );

      // Combine IV + encrypted data and encode as base64
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      
      return btoa(String.fromCharCode(...combined));
    } catch (error) {
      console.error('[Crypto] Encryption failed:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt an encrypted string
   * @param {string} encryptedBase64 - Base64 encoded encrypted data
   * @returns {Promise<string>} - Decrypted plaintext
   */
  async function decrypt(encryptedBase64) {
    if (!encryptedBase64) return '';
    
    try {
      const deviceKey = await getDeviceKey();
      const key = await deriveKey(deviceKey);
      
      // Decode base64 and extract IV + encrypted data
      const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('[Crypto] Decryption failed:', error);
      // Return empty string if decryption fails (corrupted or old data)
      return '';
    }
  }

  /**
   * Check if a string appears to be encrypted (base64 with minimum length)
   */
  function isEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    // Encrypted data is base64 and has at least IV (12 bytes) + some data
    if (value.length < 20) return false;
    try {
      const decoded = atob(value);
      return decoded.length >= 13; // 12 bytes IV + at least 1 byte data
    } catch {
      return false;
    }
  }

  return {
    encrypt,
    decrypt,
    isEncrypted
  };
})();

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.CryptoModule = CryptoModule;
}
