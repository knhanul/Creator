/**
 * 영상 장면의 기준 이미지(이미지→동영상) 탐색·장면 연결 규칙.
 * 동영상이 장면에 연결되더라도 기준 이미지는 지우지 않고 유지한다.
 */
import { sceneFileLabel } from './asset-naming';
import type { MediaAsset, Scene, StudioProject } from './types';

const IMAGE_NAME_RE = /^(image|gemini)(?:[_-].*)?$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

function fileNameOf(asset: MediaAsset): string {
  const parts = String(asset.relativePath || '').split(/[\\/]/);
  return (parts[parts.length - 1] || asset.name || '').trim();
}

/** S01_image.png, S01_image_v2.png, S01_gemini_xxx.png 처럼 장면 ID가 이름에 들어 있는 이미지인가 */
export function isSceneImageAsset(asset: MediaAsset, sceneId: string, index: number): boolean {
  if (asset.kind !== 'image') return false;
  const label = sceneFileLabel(sceneId, index).toLowerCase();
  const names = [asset.name, fileNameOf(asset)].filter(Boolean);
  for (const raw of names) {
    const base = raw.toLowerCase().replace(IMAGE_EXT_RE, '');
    if (!IMAGE_EXT_RE.test(raw) && !IMAGE_EXT_RE.test(asset.name || '')) continue;
    if (base === `${label}_image` || base === `${label}_gemini`) return true;
    if (base.startsWith(`${label}_image_`) || base.startsWith(`${label}_gemini_`)) return true;
    const m = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_([a-z0-9]+)`, 'i').exec(base);
    if (m && IMAGE_NAME_RE.test(m[1])) return true;
  }
  return false;
}

function imageById(assets: MediaAsset[], id?: string | null): MediaAsset | null {
  if (!id) return null;
  return assets.find(a => a.id === id && a.kind === 'image') || null;
}

/**
 * 영상 장면의 기준 이미지를 찾는다.
 * 1) scene.referenceImageAssetId
 * 2) scene.assetId 가 이미지인 경우
 * 3) 프로젝트 자산 중 해당 장면 이름(S01_image / S01_gemini) 이미지
 */
export function findSceneReferenceImage(project: Pick<StudioProject, 'scenes' | 'assets'>, sceneId: string): MediaAsset | null {
  const idx = project.scenes.findIndex(s => s.id === sceneId);
  if (idx < 0) return null;
  const scene = project.scenes[idx];
  const explicit = imageById(project.assets, scene.referenceImageAssetId);
  if (explicit) return explicit;
  const linked = imageById(project.assets, scene.assetId);
  if (linked) return linked;
  const matches = project.assets.filter(a => isSceneImageAsset(a, sceneId, idx));
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const score = (x: MediaAsset) => (/_image/i.test(x.name) ? 1 : 0);
    const d = score(b) - score(a);
    if (d) return d;
    return String(b.importedAt || '').localeCompare(String(a.importedAt || ''));
  });
  return matches[0];
}

/**
 * 새 미디어를 장면에 연결한다.
 * - 이미지: 기준 이미지로 기록. 이미 동영상이 assetId에 있으면 assetId는 유지.
 * - 동영상: assetId를 동영상으로 바꾸고, 기존 이미지 assetId/기준 이미지는 referenceImageAssetId로 남긴다.
 */
export function linkSceneMediaAsset(scene: Scene, asset: MediaAsset, assets: MediaAsset[]): Scene {
  if (asset.kind === 'image') {
    const current = scene.assetId ? assets.find(a => a.id === scene.assetId) : undefined;
    if (scene.kind === 'video' && current?.kind === 'video') {
      return { ...scene, referenceImageAssetId: asset.id };
    }
    return { ...scene, referenceImageAssetId: asset.id, assetId: asset.id, status: 'complete' };
  }
  if (asset.kind === 'video') {
    const current = scene.assetId ? assets.find(a => a.id === scene.assetId) : undefined;
    const found = findSceneReferenceImage({ scenes: [scene], assets }, scene.id);
    const refId = found?.id || (current?.kind === 'image' ? current.id : null) || scene.referenceImageAssetId || null;
    return { ...scene, assetId: asset.id, referenceImageAssetId: refId, status: 'complete' };
  }
  return scene;
}
