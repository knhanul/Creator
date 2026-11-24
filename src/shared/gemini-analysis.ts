/**
 * 「AI 기획 분석 시작」 자동화의 순수 로직 (Electron main·renderer·테스트에서 공용).
 * - 응답에서 JSON 후보 고르기 → 기존 applyAIResponse(creator.analysis.v1 검사기)로 검증
 * - 다른 작품/바뀐 작품 정보/더 새로운 결과를 덮어쓰지 않도록 적용 전 검사
 * - UI 단계 표시와 오류별 원인·해결 안내
 */
import type { GeminiJobPhase, GeminiJobRecord, StudioProject } from './types';
import { applyAIResponse } from './workflow';
import { makeAIPrompt } from './prompts';

/** 응답 텍스트와 코드 블록에서 JSON 후보를 우선순위대로 (중복 제거) */
export function answerCandidates(text: string | undefined, codeBlocks: string[] | undefined): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => { const t = (s || '').trim(); if (t && !out.includes(t)) out.push(t); };
  const blocks = (codeBlocks || []).filter(b => b.includes('{'));
  // creator.analysis.v1 표기가 있는 코드 블록을 가장 먼저, 그다음 나머지 코드 블록(뒤에서부터), 마지막으로 전체 텍스트
  for (const b of blocks.filter(b => b.includes('creator.analysis.v1')).reverse()) push(b);
  for (const b of blocks.slice().reverse()) push(b);
  push(text);
  return out;
}

export type ApplyDecision =
  | { action: 'apply'; project: StudioProject; raw: string; candidateIndex: number }
  | { action: 'reject'; outcome: 'invalid' | 'stale'; code: string; message: string };

/**
 * 완료된 작업의 응답을 작품에 적용할지 결정.
 * force=true(사용자가 확인 후 적용)여도 다른 작품·다른 단계에는 절대 적용하지 않습니다.
 */
export function decideAnalysisApply(job: Pick<GeminiJobRecord, 'jobId' | 'projectId' | 'kind' | 'prompt' | 'createdAt' | 'resultText' | 'codeBlocks'>, project: StudioProject, opts: { force?: boolean } = {}): ApplyDecision {
  if (job.kind !== 'analysis') return { action: 'reject', outcome: 'stale', code: 'WRONG_KIND', message: '기획 분석 작업이 아닙니다.' };
  if (project.id !== job.projectId) return { action: 'reject', outcome: 'stale', code: 'OTHER_PROJECT', message: '다른 작품의 응답이므로 적용하지 않았습니다.' };
  if (!opts.force) {
    if (makeAIPrompt(project, 'analysis') !== job.prompt) {
      return { action: 'reject', outcome: 'stale', code: 'BRIEF_CHANGED', message: '요청을 보낸 뒤 작품 정보(원문·장르·대상 등)가 바뀌어 자동으로 적용하지 않았습니다.' };
    }
    const prev = project.ai.analysis.updatedAt ? Date.parse(project.ai.analysis.updatedAt) : 0;
    if (prev && prev > Date.parse(job.createdAt)) {
      return { action: 'reject', outcome: 'stale', code: 'NEWER_ANALYSIS', message: '이 요청 이후에 다른 기획 분석 결과가 이미 적용되어 덮어쓰지 않았습니다.' };
    }
  }
  const candidates = answerCandidates(job.resultText, job.codeBlocks);
  if (!candidates.length) return { action: 'reject', outcome: 'invalid', code: 'EMPTY_RESPONSE', message: 'Gemini 응답이 비어 있습니다.' };
  let firstError = '';
  for (let i = 0; i < candidates.length; i++) {
    try {
      const next = applyAIResponse(project, 'analysis', candidates[i]);
      return { action: 'apply', project: next, raw: candidates[i], candidateIndex: i };
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e.message : String(e);
    }
  }
  return { action: 'reject', outcome: 'invalid', code: 'INVALID_JSON', message: firstError || 'JSON을 찾지 못했습니다.' };
}

/** UI 진행 단계 (요구된 8개 상태 표기) */
export const PHASE_LABEL: Record<GeminiJobPhase, string> = {
  queued: '연결 확인', checking: '연결 확인', sending: '프롬프트 전송 중', waiting: 'Gemini 응답 대기',
  collecting: '응답 수집 중', validating: 'JSON 검증 중', done: '분석 완료', needs_user: '사용자 확인 필요', error: '오류', cancelled: '취소됨'
};
export const PROGRESS_STEPS: { key: GeminiJobPhase; label: string }[] = [
  { key: 'checking', label: '연결 확인' },
  { key: 'sending', label: '프롬프트 전송' },
  { key: 'waiting', label: '응답 대기' },
  { key: 'collecting', label: '응답 수집' },
  { key: 'validating', label: 'JSON 검증' },
  { key: 'done', label: '분석 완료' }
];

export interface PhaseView { phase: GeminiJobPhase; label: string; tone: 'accent' | 'success' | 'warning' | 'danger' | 'muted'; step: number; active: boolean; }

/** 작업 레코드 → 화면 표시 단계. 상태(state)와 phase가 어긋나도 안전하게 해석 */
export function phaseView(job: GeminiJobRecord | null | undefined): PhaseView | null {
  if (!job) return null;
  let phase: GeminiJobPhase = job.phase || 'queued';
  if (job.state === 'cancelled') phase = 'cancelled';
  else if (job.state === 'needs_confirmation') phase = 'needs_user';
  else if (job.state === 'failed') phase = job.needsUser ? 'needs_user' : 'error';
  else if (job.state === 'completed') {
    phase = job.outcome === 'applied' || job.outcome === 'received' ? 'done' : job.outcome === 'stale' ? 'needs_user' : job.outcome === 'invalid' ? 'error' : 'validating';
  }
  const order = PROGRESS_STEPS.map(s => s.key);
  let step = order.indexOf(phase === 'queued' ? 'checking' : phase);
  if (step < 0) {
    // 오류/확인 필요일 때 어디서 멈췄는지: 기록된 단계 → 없으면 상태로 추정
    const stopped = job.stoppedPhase === 'queued' ? 'checking' : job.stoppedPhase;
    step = job.state === 'completed' ? order.indexOf('validating')
      : stopped && order.includes(stopped) ? order.indexOf(stopped)
      : job.sendConfirmed ? order.indexOf('waiting') : 0;
  }
  const tone: PhaseView['tone'] = phase === 'done' ? 'success' : phase === 'needs_user' ? 'warning' : phase === 'error' ? 'danger' : phase === 'cancelled' ? 'muted' : 'accent';
  const active = !['done', 'needs_user', 'error', 'cancelled'].includes(phase);
  return { phase, label: PHASE_LABEL[phase], tone, step, active };
}

/** 오류 코드별 원인·해결 방법 */
export const ERROR_GUIDE: Record<string, { cause: string; fix: string }> = {
  HOST_NOT_CONNECTED: { cause: 'Native Host가 앱에 연결되지 않았습니다.', fix: 'Chrome을 실행하고 확장 프로그램이 켜져 있는지 확인한 뒤, 환경 설정 → AI 연결 → 연결 상태 확인을 눌러 주세요. 필요하면 npm run native:register 로 다시 등록합니다.' },
  EXTENSION_NOT_CONNECTED: { cause: 'Chrome 확장 프로그램이 응답하지 않습니다.', fix: 'chrome://extensions 에서 GOMO Gemini Connector를 새로고침하고 Chrome을 재시작해 주세요.' },
  NO_TAB: { cause: '열려 있는 Gemini 탭이 없습니다.', fix: 'Chrome에서 https://gemini.google.com 을 열고 로그인한 뒤 다시 시작해 주세요.' },
  NO_GEMINI_TAB: { cause: '열려 있는 Gemini 탭이 없습니다.', fix: 'Chrome에서 https://gemini.google.com 을 열고 로그인한 뒤 다시 시작해 주세요.' },
  NO_CONTENT_SCRIPT: { cause: 'Gemini 탭에 확장 스크립트가 아직 로드되지 않았습니다.', fix: 'Gemini 탭을 새로고침(F5)한 뒤 다시 시작해 주세요.' },
  LOGIN_REQUIRED: { cause: 'Gemini에 로그인되어 있지 않습니다.', fix: 'Chrome의 Gemini 탭에서 직접 Google 계정으로 로그인한 뒤 다시 시작해 주세요. 앱은 로그인을 대신하지 않습니다.' },
  BLOCKED: { cause: 'Google 보안 확인(로봇 확인 등) 또는 이용 제한 화면이 표시되었습니다.', fix: 'Gemini 탭에서 직접 확인을 마친 뒤 다시 시작해 주세요. 앱은 이 화면을 자동으로 우회하지 않습니다.' },
  NO_INPUT: { cause: 'Gemini 입력창을 찾지 못했습니다. Gemini 화면 구조가 바뀌었을 수 있습니다.', fix: '환경 설정 → AI 연결 → 선택자 진단 결과를 확인해 주세요. 아래 수동 연결(복사·붙여넣기)로도 진행할 수 있습니다.' },
  NO_SEND_BUTTON: { cause: '전송 버튼을 찾지 못했거나 비활성 상태입니다. 전송하지 않았습니다.', fix: '선택자 진단 결과를 확인하고, 수동 연결로 진행하거나 다시 시작해 주세요.' },
  INSERT_FAILED: { cause: '입력창에 프롬프트를 넣지 못했습니다. 전송하지 않았습니다.', fix: 'Gemini 탭을 새로고침한 뒤 다시 시작하거나 수동 연결을 사용해 주세요.' },
  COMPOSER_NOT_EMPTY: { cause: 'Gemini 입력창에 작성 중인 내용이 있어 덮어쓰지 않았습니다.', fix: 'Gemini 입력창을 비운 뒤 다시 시작해 주세요.' },
  GEMINI_BUSY: { cause: 'Gemini가 이전 답변을 아직 생성하고 있습니다.', fix: '답변이 끝난 뒤 다시 시작해 주세요.' },
  EXTENSION_BUSY: { cause: '같은 Gemini 탭에서 다른 요청을 처리 중입니다.', fix: '진행 중인 요청이 끝난 뒤 다시 시작해 주세요.' },
  SEND_UNCERTAIN: { cause: '전송 버튼은 눌렀지만 전송 여부를 확인하지 못했습니다.', fix: 'Gemini 화면에 이번 요청이 올라갔는지 직접 확인해 주세요. 올라갔다면 「응답 기다리기」, 없다면 「다시 보내기」를 누르세요. 앱은 자동으로 다시 보내지 않습니다.' },
  NO_RESPONSE: { cause: 'Gemini 탭과의 통신이 중간에 끊겨 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  TIMEOUT: { cause: '확장 프로그램이 제시간에 전송 결과를 알려주지 않았습니다. 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  CONNECTION_LOST: { cause: '전송 중 연결이 끊겼습니다. 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  CONNECTION_LOST_WAITING: { cause: '응답을 기다리는 중 Chrome 확장 연결이 끊겼습니다.', fix: 'Chrome이 열려 있는지 확인해 주세요. 다시 연결되면 「응답 다시 가져오기」로 받아올 수 있습니다.' },
  APP_RESTARTED_WAITING: { cause: '응답을 기다리는 동안 앱이 종료되었습니다.', fix: '「응답 다시 가져오기」를 누르면 확장 프로그램에 보관된 응답을 받아옵니다(재전송 아님).' },
  APP_RESTARTED_UNCERTAIN: { cause: '전송 도중 앱이 종료되어 전송 여부를 알 수 없습니다.', fix: 'Gemini 화면을 확인한 뒤 「응답 기다리기」 또는 「다시 보내기」를 선택해 주세요.' },
  RESPONSE_TIMEOUT: { cause: 'Gemini 응답 완료를 제시간에 확인하지 못했습니다.', fix: 'Gemini 화면에서 답변이 끝났는지 확인해 주세요. 끝났다면 「응답 다시 가져오기」 또는 수동 연결로 붙여넣을 수 있습니다.' },
  NO_RESPONSE_NODE: { cause: '전송 후 Gemini 응답 블록을 찾지 못했습니다(화면 구조 변경 가능).', fix: '선택자 진단 결과를 확인하고, 답변이 보이면 수동 연결로 붙여넣어 주세요.' },
  INVALID_JSON: { cause: 'Gemini 응답에서 올바른 creator.analysis.v1 JSON을 찾지 못했습니다.', fix: '아래 「Gemini 응답 원문」을 확인하고 「다시 요청」하거나, 수동 연결에서 JSON을 고쳐 적용해 주세요.' },
  EMPTY_RESPONSE: { cause: 'Gemini 응답이 비어 있습니다.', fix: 'Gemini 화면을 확인하고 「다시 요청」해 주세요.' },
  BRIEF_CHANGED: { cause: '요청 후 작품 정보가 바뀌어 결과를 자동 적용하지 않았습니다.', fix: '바뀐 작품 정보로 「다시 요청」하는 것을 권장합니다. 그래도 이 결과를 쓰려면 「이 결과 적용」을 누르세요.' },
  NEWER_ANALYSIS: { cause: '이 요청 이후 다른 기획 분석 결과가 이미 적용되어 있습니다.', fix: '덮어쓰려면 「이 결과 적용」을 누르세요. 그대로 두려면 닫으면 됩니다.' },
  PROJECT_NOT_FOUND: { cause: '요청한 작품을 찾을 수 없습니다(보관·삭제됨).', fix: '작품을 복원한 뒤 다시 요청해 주세요.' },
  SAVE_FAILED: { cause: '결과를 작품 파일에 저장하지 못했습니다.', fix: '작품을 다시 열고 「응답 다시 가져오기」 또는 「이 결과 적용」을 눌러 주세요.' }
};

export function guideFor(job: GeminiJobRecord | null | undefined): { cause: string; fix: string } | null {
  if (!job || !job.errorCode) return null;
  return ERROR_GUIDE[job.errorCode] || { cause: job.errorMessage || job.errorCode, fix: 'Gemini 화면과 연결 상태를 확인한 뒤 다시 시도하거나 수동 연결을 사용해 주세요.' };
}
