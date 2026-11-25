/**
 * 기준 원문 승인·SHA-256 해시·버전 이력 보존·변경 영향(재검토 필요) 관리.
 *
 * 핵심 원칙:
 * 1. 원문 승인 시 확정 원문, 제목, 저자·번역자, 판본, 출처 URL, 가져온 날짜, 저작권 상태, 확인 근거, 승인 날짜, SHA-256, 버전을 저장한다.
 * 2. 기획 분석 이후 원문을 수정할 때:
 *    - 기존 원문을 originalHistory로 보존
 *    - 새 원문 버전 생성
 *    - 기존 기획·스토리보드·프롬프트·편집안·자막을 '재검토 필요' 상태로 표시
 *    - 이미 제작된 미디어 파일(assets)은 절대 임의로 삭제하지 않는다!
 */
import type { OriginalSourceMeta, OriginalVersionEntry, StageReviewFlags } from './source-types';
import type { AIStage, Brief, StudioProject } from './types';
import { toLegacyRightsStatus } from './copyright';

/**
 * 순수 TypeScript SHA-256 (Node/Browser 모두 동일 결과 보장 — 외부 의존성 없음).
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  return Array.from(H)
    .map(n => n.toString(16).padStart(8, '0'))
    .join('');
}

export interface OriginalChangeImpact {
  textChanged: boolean;
  hasDownstreamWork: boolean;
  affectedStages: ('analysis' | 'storyboard' | 'prompt' | 'editplan' | 'subtitles')[];
  assetCountPreserved: number;
  warningMessage: string | null;
}

/** 기준 원문 변경 시 영향 범위 분석 (기획 분석 이후 변경 경고 문구 포함) */
export function assessOriginalChangeImpact(project: StudioProject, nextOriginalText: string): OriginalChangeImpact {
  const textChanged = project.brief.originalText !== nextOriginalText;
  const affectedStages: ('analysis' | 'storyboard' | 'prompt' | 'editplan' | 'subtitles')[] = [];
  if (project.analysis) affectedStages.push('analysis');
  if (project.scenes.length > 0) {
    affectedStages.push('storyboard');
    if (project.scenes.some(s => !!s.imagePrompt)) affectedStages.push('prompt');
  }
  if (project.assembly.clips.length > 0) {
    affectedStages.push('editplan');
    if (project.assembly.subtitleMode === 'original') affectedStages.push('subtitles');
  }
  const hasDownstreamWork = affectedStages.length > 0;
  const warningMessage =
    textChanged && hasDownstreamWork
      ? '원문을 수정하면 기존 기획 분석, 스토리보드, 자막의 내용이 새 원문과 일치하지 않을 수 있습니다. 기존 원문은 이력으로 보존되고, 이미 확보한 미디어 파일은 삭제되지 않습니다. 변경 사항을 적용하시겠습니까?'
      : null;

  return {
    textChanged,
    hasDownstreamWork,
    affectedStages,
    assetCountPreserved: project.assets.length,
    warningMessage
  };
}

export interface ApproveOriginalInput {
  briefPatch: Partial<Brief> & { title: string; originalText: string };
  meta: Omit<OriginalSourceMeta, 'approvedAt' | 'sha256' | 'version'>;
  reason?: string;
  timestamp?: string;
}

/**
 * 사용자가 「이 원문을 기준 원문으로 확정」을 눌렀을 때 프로젝트에 안전하게 반영한다.
 * - 기존 원문이 있었고 내용이 바뀌면 originalHistory에 보존하고 버전을 1 증가시킨다.
 * - 기획 분석·스토리보드·자막 결과가 이미 있으면 삭제하지 않고 reviewNeeded로 표시한다.
 * - 미디어 파일(assets)은 절대 삭제하지 않는다.
 */
export function approveOriginalInProject(project: StudioProject, input: ApproveOriginalInput): StudioProject {
  const now = input.timestamp ?? new Date().toISOString();
  const next: StudioProject = structuredClone(project);
  const prevBrief = project.brief;
  const prevMeta = prevBrief.originalMeta;
  const textChanged = prevBrief.originalText !== input.briefPatch.originalText;
  const hadOriginal = prevBrief.originalText.trim().length > 0;

  const prevVersion = prevMeta?.version ?? (hadOriginal ? 1 : 0);
  const nextVersion = hadOriginal && textChanged ? prevVersion + 1 : Math.max(1, prevVersion);

  const history: OriginalVersionEntry[] = Array.isArray(next.originalHistory) ? [...next.originalHistory] : [];
  if (hadOriginal && textChanged) {
    history.push({
      version: prevVersion || 1,
      title: prevBrief.title,
      author: prevBrief.author,
      source: prevBrief.source,
      sourceUrl: prevBrief.sourceUrl,
      originalText: prevBrief.originalText,
      sha256: prevMeta?.sha256 || sha256Hex(prevBrief.originalText),
      approvedAt: prevMeta?.approvedAt || project.updatedAt,
      archivedAt: now,
      reason: input.reason || '기준 원문 변경',
      meta: prevMeta
    });
  }

  const nextHash = sha256Hex(input.briefPatch.originalText);
  const nextMeta: OriginalSourceMeta = {
    ...input.meta,
    approvedAt: now,
    sha256: nextHash,
    version: nextVersion
  };

  next.brief = {
    ...next.brief,
    ...input.briefPatch,
    rightsStatus: toLegacyRightsStatus(input.meta.rights.status),
    originalMeta: nextMeta
  };
  next.originalHistory = history;

  // 후속 단계 영향 처리: 이미 만들어진 결과는 재검토 필요 상태로 표시, 미디어(assets)는 그대로 보존!
  const impact = assessOriginalChangeImpact(project, input.briefPatch.originalText);
  if (impact.textChanged && impact.hasDownstreamWork) {
    const flags: StageReviewFlags = {
      ...(next.reviewNeeded || {}),
      analysis: impact.affectedStages.includes('analysis') || undefined,
      storyboard: impact.affectedStages.includes('storyboard') || undefined,
      prompt: impact.affectedStages.includes('prompt') || undefined,
      editplan: impact.affectedStages.includes('editplan') || undefined,
      subtitles: impact.affectedStages.includes('subtitles') || undefined,
      reason: `기준 원문이 v${prevVersion || 1}에서 v${nextVersion}으로 변경되어 재검토가 필요합니다.`,
      changedAt: now,
      fromVersion: prevVersion || 1,
      toVersion: nextVersion
    };
    next.reviewNeeded = flags;
  }

  return next;
}

/** 특정 AI 단계가 새로 생성·적용되면 해당 단계의 재검토 필요 표시를 해제한다. */
export function clearStageReviewFlag(project: StudioProject, stage: AIStage): StageReviewFlags | undefined {
  if (!project.reviewNeeded) return undefined;
  const next: StageReviewFlags = { ...project.reviewNeeded };
  delete next[stage];
  if (stage === 'editplan') delete next.subtitles;
  const remaining = Boolean(next.analysis || next.storyboard || next.prompt || next.editplan || next.subtitles);
  return remaining ? next : undefined;
}

/** 구버전 project.json을 읽었을 때 누락 필드를 안전하게 보완(하위 호환성 보장) */
export function migrateProjectDocument(raw: StudioProject): StudioProject {
  return {
    ...raw,
    brief: {
      ...raw.brief,
      sourceUrl: raw.brief.sourceUrl ?? '',
      source: raw.brief.source ?? '',
      author: raw.brief.author ?? ''
    },
    originalHistory: Array.isArray(raw.originalHistory) ? raw.originalHistory : [],
    reviewNeeded: raw.reviewNeeded
  };
}
