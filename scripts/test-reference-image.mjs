/**
 * 기준 이미지 탐색·장면 연결 규칙 + Native Messaging 크기 한도 방어 테스트.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const { DEFAULT_BRIEF, makeProject } = loadTS(join(root, 'src/shared/workflow.ts'));
const { findSceneReferenceImage, isSceneImageAsset, linkSceneMediaAsset } = loadTS(join(root, 'src/shared/reference-image.ts'));
const {
  encodeReferenceImageForNativeMessaging,
  REFERENCE_IMAGE_SAFE_BYTES,
  REFERENCE_IMAGE_MAX_BYTES,
  dataUrlByteLength,
  toImageDataUrl
} = loadTS(join(root, 'src/main/gemini/encode-reference-image.ts'));
const { ERROR_GUIDE, makeVideoGenerationPrompt } = loadTS(join(root, 'src/shared/gemini-analysis.ts'));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let checks = 0;
async function test(label, fn) {
  try { await fn(); checks++; console.log('PASS', label); }
  catch (e) { console.error('FAIL', label, e); process.exitCode = 1; }
}

function projectWithScene(extra = {}) {
  const p = makeProject('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { ...DEFAULT_BRIEF, title: '고요한 아침', originalText: '아침', aspectRatio: '16:9' });
  p.scenes = [{
    id: 'S01', title: '아침', narration: '아침', visual: '창가', durationSec: 8, kind: 'video',
    imagePrompt: 'window light', videoPrompt: 'slow pan', negativePrompt: '', assetId: null, status: 'ready',
    ...extra
  }];
  p.assets = [];
  return p;
}

await test('파일 이름 S01_image / S01_gemini 이미지를 장면 기준으로 인식', () => {
  const p = projectWithScene();
  const img = { id: 'img1', kind: 'image', name: 'S01_image.png', relativePath: 'assets/image/S01_image.png', bytes: 12, importedAt: '2026-11-26T00:00:00.000Z' };
  const gem = { id: 'img2', kind: 'image', name: 'S01_gemini_ab12.png', relativePath: 'assets/image/S01_gemini_ab12.png', bytes: 12, importedAt: '2026-11-26T01:00:00.000Z' };
  const other = { id: 'img3', kind: 'image', name: 'S02_image.png', relativePath: 'assets/image/S02_image.png', bytes: 12, importedAt: '2026-11-26T02:00:00.000Z' };
  assert.equal(isSceneImageAsset(img, 'S01', 0), true);
  assert.equal(isSceneImageAsset(gem, 'S01', 0), true);
  assert.equal(isSceneImageAsset(other, 'S01', 0), false);
  p.assets = [other, gem, img];
  const found = findSceneReferenceImage(p, 'S01');
  assert.equal(found.id, 'img1', '공식 _image 이름을 우선');
});

await test('referenceImageAssetId와 장면 assetId(이미지)를 기준으로 인식하고, 동영상 연결 후에도 유지', () => {
  const p = projectWithScene();
  const img = { id: 'img1', kind: 'image', name: 'S01_image.png', relativePath: 'assets/image/S01_image.png', bytes: 12, importedAt: '2026-11-26T00:00:00.000Z' };
  const vid = { id: 'vid1', kind: 'video', name: 'S01_video.mp4', relativePath: 'assets/video/S01_video.mp4', bytes: 40, importedAt: '2026-11-26T01:00:00.000Z' };
  p.assets = [img];
  p.scenes[0].assetId = img.id;
  assert.equal(findSceneReferenceImage(p, 'S01').id, 'img1');

  const afterVideo = linkSceneMediaAsset(p.scenes[0], vid, [...p.assets, vid]);
  p.scenes[0] = afterVideo;
  p.assets.push(vid);
  assert.equal(afterVideo.assetId, 'vid1');
  assert.equal(afterVideo.referenceImageAssetId, 'img1');
  assert.equal(findSceneReferenceImage(p, 'S01').id, 'img1');

  const img2 = { id: 'img2', kind: 'image', name: 'S01_image_v2.png', relativePath: 'assets/image/S01_image_v2.png', bytes: 12, importedAt: '2026-11-26T02:00:00.000Z' };
  const afterNewImg = linkSceneMediaAsset(p.scenes[0], img2, [...p.assets, img2]);
  assert.equal(afterNewImg.assetId, 'vid1', '이미 연결된 동영상은 유지');
  assert.equal(afterNewImg.referenceImageAssetId, 'img2');
});

await test('makeVideoGenerationPrompt: hasReferenceImage면 첨부 이미지 애니메이션 지시를 포함', () => {
  const p = projectWithScene();
  const plain = makeVideoGenerationPrompt(p, 'S01');
  assert.ok(plain.includes('Generate a short cinematic video'));
  assert.equal(plain.includes('Animate the attached reference image'), false);
  const withRef = makeVideoGenerationPrompt(p, 'S01', { hasReferenceImage: true });
  assert.ok(withRef.includes('Animate the attached reference image into a short cinematic video'));
  assert.ok(withRef.includes('Keep the exact characters, art style, composition, and colors from the attached reference image.'));
  assert.ok(withRef.includes('slow pan'));
  assert.ok(ERROR_GUIDE.IMAGE_ATTACH_FAILED.fix.includes('텍스트만으로 동영상 생성'));
});

await test('작은 이미지는 원본 그대로 인코딩하고 원본 파일은 덮어쓰지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gomo-ref-'));
  const file = join(dir, 'S01_image.png');
  writeFileSync(file, TINY_PNG);
  const before = readFileSync(file);
  const encoded = await encodeReferenceImageForNativeMessaging({ buffer: TINY_PNG, mimeType: 'image/png', name: 'S01_image.png' });
  assert.equal(encoded.resized, false);
  assert.equal(encoded.mimeType, 'image/png');
  assert.equal(encoded.name, 'S01_image.png');
  assert.ok(dataUrlByteLength(encoded.dataUrl) <= REFERENCE_IMAGE_SAFE_BYTES);
  assert.equal(encoded.dataUrl, toImageDataUrl(TINY_PNG, 'image/png'));
  assert.ok(readFileSync(file).equals(before));
  rmSync(dir, { recursive: true, force: true });
});

await test('큰 이미지는 resize로 단계적 축소되어 700KB 이하가 됨', async () => {
  const huge = Buffer.alloc(900 * 1024, 7);
  let calls = 0;
  const encoded = await encodeReferenceImageForNativeMessaging(
    { buffer: huge, mimeType: 'image/png', name: 'S01_image.png' },
    {
      resize: async (_buf, opts) => {
        calls += 1;
        if (calls < 3) return { buffer: Buffer.alloc(800 * 1024, 8), mimeType: 'image/jpeg' };
        return { buffer: Buffer.alloc(80 * 1024, 9), mimeType: 'image/jpeg' };
      }
    }
  );
  assert.equal(encoded.resized, true);
  assert.equal(encoded.mimeType, 'image/jpeg');
  assert.equal(encoded.name, 'S01_image.jpg');
  assert.ok(encoded.bytes <= REFERENCE_IMAGE_SAFE_BYTES);
  assert.ok(encoded.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.ok(calls >= 3);
  assert.equal(huge[0], 7, '입력 버퍼를 덮어쓰지 않음');
});

await test('줄여도 700KB를 넘으면 전송을 거부하고 원본은 그대로', async () => {
  const huge = Buffer.alloc(900 * 1024, 3);
  await assert.rejects(
    () => encodeReferenceImageForNativeMessaging(
      { buffer: huge, mimeType: 'image/jpeg', name: 'big.jpg' },
      { resize: async () => ({ buffer: Buffer.alloc(800 * 1024, 4), mimeType: 'image/jpeg' }) }
    ),
    /너무 커서/
  );
  assert.equal(huge[0], 3);
});

await test('resize 없이 안전 상한을 넘으면 거부', async () => {
  const huge = Buffer.alloc(900 * 1024, 1);
  const dataUrl = toImageDataUrl(huge, 'image/jpeg');
  assert.ok(dataUrlByteLength(dataUrl) > REFERENCE_IMAGE_MAX_BYTES);
  await assert.rejects(
    () => encodeReferenceImageForNativeMessaging({ buffer: huge, mimeType: 'image/jpeg', name: 'big.jpg' }),
    /너무 큽니다/
  );
});

console.log(`reference-image tests: ${checks} passed`);
