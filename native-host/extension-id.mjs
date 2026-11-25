/**
 * Chrome unpacked extension ID from the manifest "key" (base64 DER SPKI).
 * ID = first 32 hex chars of SHA-256(DER), remapped 0-f → a-p.
 *
 * Usage: node native-host/extension-id.mjs
 */
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_PATH = join(import.meta.dirname, '..', 'extension', 'manifest.json');

export function extensionIdFromPublicKey(keyB64) {
  if (typeof keyB64 !== 'string' || !keyB64.trim()) {
    throw new Error('확장 공개키(key)가 비어 있습니다.');
  }
  const der = Buffer.from(keyB64.replace(/\s+/g, ''), 'base64');
  if (der.length < 50) throw new Error('확장 공개키(key)가 올바르지 않습니다.');
  // SPKI인지 확인 (잘못된 키를 조용히 받아 잘못된 ID를 만들지 않음)
  createPublicKey({ key: der, format: 'der', type: 'spki' });
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return hex.replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

export function readFixedExtensionId(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.key) {
    throw new Error(`${manifestPath} 에 key 가 없습니다.`);
  }
  return extensionIdFromPublicKey(manifest.key);
}

export const FIXED_EXTENSION_ID = readFixedExtensionId();

const invoked = process.argv[1]
  ? process.argv[1].replace(/\\/g, '/').endsWith('native-host/extension-id.mjs')
  : false;
if (invoked) {
  process.stdout.write(`${FIXED_EXTENSION_ID}\n`);
}
