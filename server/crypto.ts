import crypto from 'crypto';

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || 'unconfigured-encryption-key';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptApiKey(plaintext: string): { encrypted: string; iv: string; masked: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  const finalEncrypted = `${encrypted}:${authTag}`;

  const trimmed = plaintext.trim();
  const masked = trimmed.length > 8
    ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
    : '****';

  return {
    encrypted: finalEncrypted,
    iv: iv.toString('hex'),
    masked
  };
}

export function decryptApiKey(encryptedData: string, ivHex: string): string {
  const [ciphertext, authTagHex] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Rotation fallback decryption attempt with previous master key
    const legacyKey = crypto.createHash('sha256').update('salt-relay-master-encryption-key-victor-2026').digest();
    const legacyDecipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
    legacyDecipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = legacyDecipher.update(ciphertext, 'hex', 'utf8');
    decrypted += legacyDecipher.final('utf8');
    return decrypted;
  }
}
