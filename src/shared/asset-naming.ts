/**
 * 미디어 파일 이름 규칙 — 다른 프로그램(탐색기·편집기)에서도 알아보기 쉽게 장면 순서와 종류만으로 짓는다.
 *  - 장면 이미지:  S04_image.png   · 장면 동영상: S04_video.mp4
 *  - 배경음악:     BGM_01.mp3, BGM_02.mp3 …
 *  - 같은 이름이 이미 있으면(다시 생성) 덮어쓰지 않고 S04_image_v2.png, _v3 … 으로 새로 만든다.
 *    기존 파일과 project.json 참조는 그대로 남으므로 쓰던 파일이 사라지지 않는다.
 *  - 장면과 상관없이 가져온 파일은 원래 이름을 쓰고, 겹칠 때만 _v2 를 붙인다.
 * 이름은 Windows에서 안전한 ASCII(영문·숫자·_ -)만 쓴다(가져온 파일의 원래 이름은 예외).
 */
import type { AssetKind } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 화면에 보이는 장면 번호(S04)를 파일 이름용으로. 장면 ID가 안전한 ASCII면 그대로, 아니면 순서로 S01… */
export function sceneFileLabel(sceneId: string | undefined, index: number): string {
  const id = String(sceneId || '').trim();
  if (/^[A-Za-z0-9_-]{1,24}$/.test(id)) return id;
  return `S${pad2(Math.max(0, index) + 1)}`;
}

/** 장면 미디어 기본 이름(확장자 제외): S04_image / S04_video */
export function sceneAssetBase(sceneId: string | undefined, index: number, kind: AssetKind): string {
  return `${sceneFileLabel(sceneId, index)}_${kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image'}`;
}

/** 비교용 키: 대소문자 무시(Windows) + 확장자 무시(S04_image.png 가 있으면 S04_image.jpg 도 겹친 것으로 봄 — 헷갈리지 않게) */
const key = (name: string) => name.toLowerCase().replace(/\.[a-z0-9]{1,8}$/, '');

/** base.ext 가 비어 있으면 그 이름, 아니면 base_v2.ext, base_v3.ext … 중 처음 비는 이름 */
export function versionedFileName(base: string, ext: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, key));
  const dot = ext ? `.${ext.replace(/^\./, '')}` : '';
  if (!used.has(key(base))) return base + dot;
  for (let v = 2; v < 10000; v++) {
    const name = `${base}_v${v}`;
    if (!used.has(key(name))) return name + dot;
  }
  throw new Error('같은 이름의 파일이 너무 많습니다.');
}

/** 배경음악: BGM_01, BGM_02 … 중 처음 비는 번호 */
export function bgmFileName(ext: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, key));
  const dot = `.${ext.replace(/^\./, '')}`;
  for (let n = 1; n < 10000; n++) {
    const name = `BGM_${pad2(n)}`;
    if (!used.has(key(name))) return name + dot;
  }
  throw new Error('배경음악 파일이 너무 많습니다.');
}

/** 가져온 파일의 원래 이름에서 확장자 분리 (versionedFileName에 넘기기 위함) */
export function splitExt(name: string): { base: string; ext: string } {
  const m = /^(.*?)(?:\.([A-Za-z0-9]{1,8}))?$/.exec(name);
  const base = (m?.[1] || name) || 'untitled';
  return { base, ext: m?.[2] || '' };
}
