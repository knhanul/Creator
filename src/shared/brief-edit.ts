import type { AutoFillField, Brief, StudioProject } from './types';
import { approveOriginalInProject, sha256Hex } from './original-versioning';
import { evaluateRightsEvidence, fromLegacyRightsStatus } from './copyright';

export const AUTO_FILL_FIELDS: AutoFillField[] = ['title', 'author', 'source', 'sourceUrl', 'originalText'];
export const AUTO_FILL_LABELS: Record<AutoFillField, string> = {
  title: '작품 제목', author: '저자', source: '출처·역본', sourceUrl: '원문 URL', originalText: '원문'
};

/**
 * 작품 정보 자동 저장.
 * - 원문이 바뀌지 않으면 그대로 저장한다.
 * - 원문이 바뀌면, 이번 편집에서 처음 바뀐 때만 새 버전으로 확정(이전 원문은 이력에 보존)하고,
 *   같은 편집 중에 이어서 고친 내용은 그 버전을 덮어써서 키를 누를 때마다 버전이 쌓이지 않게 한다.
 */
export function applyBriefAutosave(
  p: StudioProject,
  brief: Brief,
  opts: { continueSession: boolean; timestamp?: string }
): { project: StudioProject; startedSession: boolean } {
  const now = opts.timestamp ?? new Date().toISOString();
  const textChanged = p.brief.originalText !== brief.originalText;
  if (!textChanged) return { project: { ...p, brief: { ...brief, originalMeta: p.brief.originalMeta } }, startedSession: false };

  // 원문이 아직 없던 작품에 처음 타이핑 중이고 확정 정보도 없으면 → 내용이 생길 때 1판으로 확정
  if (opts.continueSession && p.brief.originalMeta) {
    const meta = { ...p.brief.originalMeta, sha256: sha256Hex(brief.originalText), approvedAt: now, title: brief.title, author: brief.author, edition: brief.source || p.brief.originalMeta.edition, sourceUrl: brief.sourceUrl };
    return { project: { ...p, brief: { ...brief, originalMeta: meta } }, startedSession: false };
  }
  if (!brief.originalText.trim() && !p.brief.originalText.trim()) {
    return { project: { ...p, brief: { ...brief, originalMeta: p.brief.originalMeta } }, startedSession: false };
  }
  const prevRights = p.brief.originalMeta?.rights || evaluateRightsEvidence({
    providerEvidenceStatus: fromLegacyRightsStatus(brief.rightsStatus),
    providerEvidenceItems: ['사용자가 작품 정보에서 원문을 직접 입력·수정했습니다.']
  });
  const next = approveOriginalInProject(p, {
    briefPatch: brief,
    meta: {
      inputMethod: 'manual',
      providerId: 'manual',
      providerName: '직접 입력',
      workId: p.brief.originalMeta?.workId || 'manual',
      title: brief.title,
      author: brief.author,
      edition: brief.source || '직접 입력',
      sourceUrl: brief.sourceUrl,
      fetchedAt: now,
      rights: prevRights
    },
    reason: '사용자가 작품 정보 화면에서 원문을 직접 수정',
    timestamp: now
  });
  return { project: next, startedSession: true };
}

/** 사용자가 고친 칸은 '자동 입력됨' 표시를 지운다 */
export function clearAutoFilled(brief: Brief, field: AutoFillField): Brief {
  if (!brief.autoFilled || !(field in brief.autoFilled)) return brief;
  const rest = { ...brief.autoFilled };
  delete rest[field];
  return { ...brief, autoFilled: Object.keys(rest).length ? rest : undefined };
}

/** 자동 채우기로 덮어쓰게 될, 사용자가 직접 쓴 칸 목록 */
export function userFieldsToOverwrite(brief: Brief, incoming: Partial<Record<AutoFillField, string>>): AutoFillField[] {
  return AUTO_FILL_FIELDS.filter(f => {
    const cur = (brief[f] || '').trim();
    const nextVal = (incoming[f] ?? '').trim();
    return !!cur && !brief.autoFilled?.[f] && incoming[f] !== undefined && cur !== nextVal;
  });
}
