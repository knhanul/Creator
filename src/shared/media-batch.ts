/**
 * 「미디어 한 번에 만들기」 순서 계획.
 *
 * 1) 이미지 먼저: 이미지 장면 + 동영상 장면의 기준 이미지를 같은 Gemini 채팅에서 연달아 만든다(화풍·느낌 유지).
 * 2) 동영상은 맨 뒤: Gemini 동영상 도구는 새 채팅을 열므로, 이미지를 다 만든 뒤 각 장면의 기준 이미지를 첨부해 만든다.
 * 3) 배경음악은 마지막(선택).
 *
 * 이미 만든 것은 건너뛰므로, 멈췄다가 「이어서 만들기」를 누르면 남은 것만 다시 계획된다.
 */
import type { StudioProject } from './types';
import { findSceneReferenceImage } from './reference-image';
import { getProjectBgmPrompt } from './gemini-analysis';

export type MediaBatchKind = 'image' | 'reference' | 'video' | 'music';
export interface MediaBatchStep { kind: MediaBatchKind; sceneId?: string; label: string }

export const BATCH_KIND_LABEL: Record<MediaBatchKind, string> = { image: '이미지', reference: '기준 이미지', video: '동영상', music: '배경음악' };

function linkedAsset(p: StudioProject, assetId: string | null | undefined) {
  return assetId ? p.assets.find(a => a.id === assetId) : undefined;
}

/** 아직 만들지 않은 미디어를 「이미지 → 동영상 → 배경음악」 순서로 */
export function planMediaBatch(p: StudioProject, opts: { music?: boolean } = {}): MediaBatchStep[] {
  const images: MediaBatchStep[] = [];
  const videos: MediaBatchStep[] = [];
  for (const s of p.scenes) {
    const cur = linkedAsset(p, s.assetId);
    if (s.kind === 'image') {
      if (!cur || cur.kind !== 'image') if (s.imagePrompt.trim()) images.push({ kind: 'image', sceneId: s.id, label: `${s.id} 이미지` });
      continue;
    }
    if (cur?.kind === 'video') continue;
    // 동영상 장면: 기준 이미지가 없으면 먼저 이미지 단계에서 만든다(이미지 프롬프트가 있을 때)
    if (!findSceneReferenceImage(p, s.id) && s.imagePrompt.trim()) images.push({ kind: 'reference', sceneId: s.id, label: `${s.id} 기준 이미지` });
    if (s.videoPrompt.trim()) videos.push({ kind: 'video', sceneId: s.id, label: `${s.id} 동영상` });
  }
  const steps = [...images, ...videos];
  if (opts.music !== false && getProjectBgmPrompt(p) && !p.assets.some(a => a.kind === 'audio')) steps.push({ kind: 'music', label: '배경음악' });
  return steps;
}

/** 계획 요약 (예: 「이미지 4 · 기준 이미지 2 → 동영상 2 → 배경음악」) */
export function describeBatch(steps: MediaBatchStep[]): string {
  const n = (k: MediaBatchKind) => steps.filter(s => s.kind === k).length;
  const first = [n('image') ? `이미지 ${n('image')}` : '', n('reference') ? `기준 이미지 ${n('reference')}` : ''].filter(Boolean).join(' · ');
  return [first, n('video') ? `동영상 ${n('video')}` : '', n('music') ? '배경음악' : ''].filter(Boolean).join(' → ');
}
