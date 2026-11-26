/**
 * 기준 이미지를 Chrome Native Messaging 한도(Host → 확장 1MB) 안으로 줄인다.
 * 디스크의 원본 이미지 파일은 절대 덮어쓰지 않고, 전송용 사본만 만든다.
 */
import type { ReferenceImagePayload } from '../../shared/types';

/** dataUrl이 이 크기 이하면 추가 압축하지 않음 */
export const REFERENCE_IMAGE_SAFE_BYTES = 650 * 1024;
/** dataUrl 하드 상한. 이보다 크면 전송하지 않음 (1MB 메시지 한도 방어) */
export const REFERENCE_IMAGE_MAX_BYTES = 700 * 1024;

export type ResizeReferenceImage = (
  buffer: Buffer,
  opts: { maxEdge: number; quality: number }
) => Promise<{ buffer: Buffer; mimeType: string }> | { buffer: Buffer; mimeType: string };

export interface EncodeReferenceImageInput {
  buffer: Buffer;
  mimeType?: string;
  name?: string;
}

export interface EncodedReferenceImage extends ReferenceImagePayload {
  bytes: number;
  resized: boolean;
}

const SHRINK_STEPS: Array<{ maxEdge: number; quality: number }> = [
  { maxEdge: 1280, quality: 85 },
  { maxEdge: 1280, quality: 82 },
  { maxEdge: 1100, quality: 80 },
  { maxEdge: 1024, quality: 78 },
  { maxEdge: 960, quality: 75 },
  { maxEdge: 800, quality: 72 },
  { maxEdge: 720, quality: 70 },
  { maxEdge: 640, quality: 68 },
  { maxEdge: 512, quality: 65 },
  { maxEdge: 480, quality: 60 },
  { maxEdge: 400, quality: 55 }
];

export function dataUrlByteLength(dataUrl: string): number {
  return Buffer.byteLength(dataUrl, 'utf8');
}

export function toImageDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export function mimeFromFileName(name?: string, fallback = 'image/png'): string {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'png') return 'image/png';
  return fallback;
}

function jpegName(name?: string): string {
  const raw = String(name || 'reference').trim() || 'reference';
  return raw.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.jpg';
}

/**
 * 전송용 dataUrl을 650KB 목표(최대 700KB)로 만든다.
 * resize가 없으면 한도를 넘는 이미지는 거부한다.
 */
export async function encodeReferenceImageForNativeMessaging(
  input: EncodeReferenceImageInput,
  opts?: { resize?: ResizeReferenceImage; safeBytes?: number; maxBytes?: number }
): Promise<EncodedReferenceImage> {
  const safe = opts?.safeBytes ?? REFERENCE_IMAGE_SAFE_BYTES;
  const max = opts?.maxBytes ?? REFERENCE_IMAGE_MAX_BYTES;
  const source = Buffer.from(input.buffer);
  if (!source.byteLength) throw new Error('기준 이미지 파일이 비어 있습니다.');
  const mime = input.mimeType || mimeFromFileName(input.name);
  const name = input.name || `reference.${mime.includes('jpeg') ? 'jpg' : 'png'}`;

  let dataUrl = toImageDataUrl(source, mime);
  let bytes = dataUrlByteLength(dataUrl);
  if (bytes <= safe) {
    return { name, mimeType: mime, dataUrl, bytes, resized: false };
  }

  if (!opts?.resize) {
    throw new Error(`기준 이미지가 너무 큽니다(${Math.ceil(bytes / 1024)}KB). Gemini로 보내려면 이미지를 줄여 주세요.`);
  }

  let last = source;
  let lastMime = mime;
  let lastName = name;
  let resized = false;
  for (const step of SHRINK_STEPS) {
    const out = await opts.resize(last, step);
    if (!out?.buffer?.byteLength) continue;
    last = Buffer.from(out.buffer);
    lastMime = out.mimeType || 'image/jpeg';
    lastName = lastMime.includes('jpeg') || lastMime.includes('jpg') ? jpegName(name) : name;
    dataUrl = toImageDataUrl(last, lastMime);
    bytes = dataUrlByteLength(dataUrl);
    resized = true;
    if (bytes <= safe) {
      return { name: lastName, mimeType: lastMime, dataUrl, bytes, resized };
    }
  }

  if (resized && bytes <= max) {
    return { name: lastName, mimeType: lastMime, dataUrl, bytes, resized };
  }
  throw new Error(`기준 이미지가 너무 커서 Gemini로 보내지 못했습니다(${Math.ceil(bytes / 1024)}KB). 이미지를 직접 줄인 뒤 다시 시도해 주세요.`);
}

/** Electron main 전용: nativeImage로 긴 변 제한 + JPEG 압축. 원본 버퍼/파일은 변경하지 않음. */
export function resizeWithElectronNativeImage(
  buffer: Buffer,
  opts: { maxEdge: number; quality: number }
): { buffer: Buffer; mimeType: string } {
  // electron은 메인 프로세스에서만 사용. 테스트는 mock resize를 주입한다.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nativeImage } = require('electron') as typeof import('electron');
  let img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) throw new Error('기준 이미지를 읽지 못했습니다.');
  const size = img.getSize();
  const long = Math.max(size.width || 0, size.height || 0);
  if (long > opts.maxEdge && long > 0) {
    const scale = opts.maxEdge / long;
    img = img.resize({
      width: Math.max(1, Math.round((size.width || opts.maxEdge) * scale)),
      height: Math.max(1, Math.round((size.height || opts.maxEdge) * scale)),
      quality: 'best'
    });
  }
  const quality = Math.max(1, Math.min(100, Math.round(opts.quality)));
  return { buffer: Buffer.from(img.toJPEG(quality)), mimeType: 'image/jpeg' };
}
