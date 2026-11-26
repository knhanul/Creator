import type { Brief } from './types';
import { AUTO_FILL_FIELDS } from './brief-edit';

export type BriefFlushResult = {
  ok: boolean;
  startedSession?: boolean;
  error?: string;
  /** mutate 등에서 이미 오류를 보여 줬으면 중복 알림을 생략한다 */
  notified?: boolean;
};

const EDITABLE = [
  'genre', 'audience', 'title', 'author', 'source', 'sourceUrl', 'originalText',
  'rightsStatus', 'targetDuration', 'aspectRatio', 'originalFileName', 'bibleTranslation'
] as const;

/** 작품 정보 화면에서 사용자가 고치는 칸만 비교한다. (originalMeta는 저장 로직이 채우므로 제외) */
export function editableBriefSnapshot(brief: Brief): string {
  const autoFilled = AUTO_FILL_FIELDS
    .map(field => [field, brief.autoFilled?.[field] ?? ''] as const)
    .filter(([, value]) => value);
  const picked: Record<string, unknown> = {};
  for (const key of EDITABLE) picked[key] = brief[key] ?? '';
  picked.autoFilled = autoFilled;
  return JSON.stringify(picked);
}

export function editableBriefEqual(a: Brief, b: Brief): boolean {
  return editableBriefSnapshot(a) === editableBriefSnapshot(b);
}

export const DEFAULT_AUTOSAVE_MS = 700;
export const DEFAULT_SAVE_TIMEOUT_MS = 20_000;
export const SAVE_TIMEOUT_MESSAGE = '작품 정보를 저장하는 데 시간이 너무 오래 걸려요. 이 화면에 머물면서 잠시 후 다시 시도해 주세요.';
export const SAVE_FAILED_MESSAGE = '작품 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.';

export function notifiedError(message: string, notified = false): Error & { notified?: boolean } {
  const error = new Error(message) as Error & { notified?: boolean };
  if (notified) error.notified = true;
  return error;
}

export function errorFlushResult(error: unknown): BriefFlushResult {
  const err = error instanceof Error ? error : new Error(String(error));
  const notified = Boolean((err as { notified?: boolean }).notified);
  return { ok: false, error: err.message || SAVE_FAILED_MESSAGE, notified };
}

type TimerId = ReturnType<typeof setTimeout>;

export interface BriefAutosaveOptions {
  getDraft: () => Brief;
  getSaved: () => Brief;
  save: (brief: Brief, continueSession: boolean) => Promise<boolean>;
  onPendingChange: (pending: boolean) => void;
  delayMs?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerId;
  clearTimeoutFn?: (id: TimerId) => void;
}

export interface BriefAutosaveSession {
  markPending: () => void;
  flush: () => Promise<BriefFlushResult>;
  cancelPending: () => void;
  noteSubmitted: (brief: Brief) => void;
  reset: () => void;
}

/**
 * 작품 정보 자동 저장 세션.
 * - 키 입력은 delayMs 동안 모아서 저장한다.
 * - pending 플래그가 꺼져 있어도, 화면에 있는 내용이 저장된 작품과 다르면 flush 때 저장한다.
 * - 저장이 진행 중일 때 flush를 다시 호출하면 그 저장이 끝난 뒤 최신 초안을 한 번 더 저장한다.
 * - 저장이 실패하거나 시간 제한을 넘기면 pending을 유지하고 오류를 돌려 준다. (화면 이동을 막기 위함)
 */
export function createBriefAutosaveSession(opts: BriefAutosaveOptions): BriefAutosaveSession {
  const delayMs = opts.delayMs ?? DEFAULT_AUTOSAVE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
  const timeoutMessage = opts.timeoutMessage ?? SAVE_TIMEOUT_MESSAGE;
  const schedule = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimerFn = opts.clearTimeoutFn ?? (id => clearTimeout(id));

  let pending = false;
  let continueSession = false;
  let timer: TimerId | null = null;
  let lastSubmitted: Brief | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const isDirty = () => {
    const draft = opts.getDraft();
    if (lastSubmitted && editableBriefEqual(draft, lastSubmitted)) return false;
    return !editableBriefEqual(draft, opts.getSaved());
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancelTimerFn(timer);
      timer = null;
    }
  };

  const setPending = (value: boolean) => {
    pending = value;
    opts.onPendingChange(value);
  };

  const runSave = async (): Promise<BriefFlushResult> => {
    const draft = opts.getDraft();
    try {
      const started = await withTimeout(
        Promise.resolve().then(() => opts.save(draft, continueSession)),
        timeoutMs,
        timeoutMessage,
        schedule,
        cancelTimerFn
      );
      if (started) continueSession = true;
      lastSubmitted = draft;
      setPending(isDirty());
      return { ok: true, startedSession: started };
    } catch (error) {
      setPending(true);
      return errorFlushResult(error);
    }
  };

  const saveIfDirty = async (): Promise<BriefFlushResult> => {
    clearTimer();
    if (!pending && !isDirty()) return { ok: true, startedSession: false };
    return runSave();
  };

  const enqueue = (fn: () => Promise<BriefFlushResult>): Promise<BriefFlushResult> => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    markPending() {
      setPending(true);
      clearTimer();
      timer = schedule(() => { timer = null; return enqueue(saveIfDirty); }, delayMs);
    },
    flush() {
      clearTimer();
      return enqueue(saveIfDirty);
    },
    cancelPending() {
      clearTimer();
      setPending(false);
    },
    noteSubmitted(brief) {
      lastSubmitted = brief;
      clearTimer();
      setPending(false);
    },
    reset() {
      clearTimer();
      pending = false;
      continueSession = false;
      lastSubmitted = null;
      chain = Promise.resolve();
      opts.onPendingChange(false);
    }
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  schedule: (fn: () => void, ms: number) => TimerId,
  cancel: (id: TimerId) => void
): Promise<T> {
  if (ms <= 0) return promise;
  let timer: TimerId | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = schedule(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => { if (timer !== null) cancel(timer); });
  });
}
