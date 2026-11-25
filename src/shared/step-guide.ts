import type { Stage, StudioProject } from './types';
import { STAGE_NAMES, STAGE_ORDER, readyForHandoff, scenePrimaryPrompt, stageComplete } from './workflow';

/** 각 단계 화면 아래 고정 줄에 보여 줄 '지금 할 일'과 다음 단계 버튼 상태 */
export interface StepGuide {
  stage: Stage;
  /** 다음 단계로 갈 준비가 되었나 */
  ready: boolean;
  /** 지금 할 일 한 줄 안내 (준비되면 '준비 완료 ✓ …') */
  hint: string;
  /** 비어 있는 필수 항목 (버튼 툴팁) */
  missing: string[];
  /** 다음 단계 (마지막 단계면 null) */
  next: Stage | null;
  nextLabel: string;
}

const nextOf = (stage: Stage): Stage | null => {
  const i = STAGE_ORDER.indexOf(stage);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null;
};

/** 화면 이름: 사이드바와 같은 이름을 쓴다 (미디어 단계는 '미디어 보관함') */
export const STEP_TITLES: Record<Stage, string> = {
  brief: '작품 정보', analysis: '기획 분석', storyboard: '스토리보드', prompt: '생성 프롬프트',
  media: '미디어 보관함', assembly: '최종 편집안', handoff: '더빙 전달'
};

/** 받침에 맞춘 '(으)로' */
export function withRo(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return `${word}(으)로`;
  const jong = c % 28;
  return word + (jong === 0 || jong === 8 ? '로' : '으로');
}

export function stepGuide(p: StudioProject, stage: Stage): StepGuide {
  const next = nextOf(stage);
  const nextLabel = next ? `다음: ${STEP_TITLES[next]}` : '제작 패키지 내보내기';
  const done = stageComplete(p, stage);
  const missing: string[] = [];
  let todo = '';
  switch (stage) {
    case 'brief':
      if (!p.brief.title.trim()) missing.push(p.brief.genre === 'bible' ? '성경 본문 범위(제목)' : '작품 제목');
      if (!p.brief.originalText.trim()) missing.push('낭독할 원문');
      todo = p.brief.genre === 'bible'
        ? '성경 범위를 고르고 「성경 본문 가져오기」를 누르면 기획 분석으로 넘어갈 수 있어요'
        : '제목과 원문을 채우면 기획 분석으로 넘어갈 수 있어요 (「원문 찾아 채우기」로 자동 입력 가능)';
      break;
    case 'analysis':
      if (!p.analysis) { missing.push('AI 기획 분석 결과'); todo = '「AI 기획 분석 시작」을 누르면 화풍과 연출안 후보가 나와요'; }
      else {
        if (!p.selection.styleId) missing.push('화풍 선택');
        if (!p.selection.directionId) missing.push('연출 방향 선택');
        todo = '화풍과 연출 방향을 하나씩 고르면 스토리보드로 넘어갈 수 있어요';
      }
      break;
    case 'storyboard':
      if (!p.scenes.length) missing.push('장면 1개 이상');
      todo = '「AI 장면 구성 시작」을 누르거나 「장면 추가」로 장면을 만들어 주세요';
      break;
    case 'prompt': {
      const emptyImage = p.scenes.filter(s => s.kind !== 'video' && !scenePrimaryPrompt(s)).length;
      const emptyVideo = p.scenes.filter(s => s.kind === 'video' && !scenePrimaryPrompt(s)).length;
      if (!p.scenes.length) missing.push('스토리보드 장면');
      else {
        if (emptyImage) missing.push(`이미지 프롬프트 ${emptyImage}개`);
        if (emptyVideo) missing.push(`동영상 프롬프트 ${emptyVideo}개`);
      }
      todo = p.scenes.length ? '장면마다 종류(이미지·영상)에 맞는 프롬프트를 채우면 미디어 단계로 넘어갈 수 있어요' : '스토리보드에서 장면을 먼저 만들어 주세요';
      break;
    }
    case 'media': {
      const unlinked = p.scenes.filter(s => !s.assetId || !p.assets.some(a => a.id === s.assetId)).length;
      if (!p.scenes.length) missing.push('스토리보드 장면');
      else if (unlinked) missing.push(`미디어가 없는 장면 ${unlinked}개`);
      todo = '장면마다 이미지나 영상을 하나씩 만들거나 가져와 연결해 주세요';
      break;
    }
    case 'assembly':
      if (!p.assembly.clips.length) missing.push('편집 클립');
      todo = '「장면 순서로 구성」이나 「AI 편집 구성」으로 편집안을 만들어 주세요';
      break;
    case 'handoff': {
      const r = readyForHandoff(p);
      missing.push(...r.warnings);
      todo = r.warnings[0] || '';
      break;
    }
  }
  const ready = stage === 'handoff' ? missing.length === 0 : done;
  const hint = ready
    ? (next ? `준비 완료 ✓ ${withRo(STEP_TITLES[next])} 넘어가세요` : '준비 완료 ✓ 제작 패키지를 내보내세요')
    : todo;
  return { stage, ready, hint, missing: ready ? [] : missing, next, nextLabel };
}

/** 상태 표시줄용: 완료한 단계 수 */
export function completedSteps(p: StudioProject): number {
  return STAGE_ORDER.filter(s => stageComplete(p, s)).length;
}
export const TOTAL_STEPS = STAGE_ORDER.length;
export { STAGE_NAMES };
