/**
 * Typed facade over job-queue.mjs (single implementation).
 * 레코드 타입은 renderer와 공유하기 위해 src/shared/types.ts에 둡니다.
 */
export type {
  GeminiJobKind as JobKind,
  GeminiJobState as JobState,
  GeminiJobPhase as JobPhase,
  GeminiJobRecord,
  GeminiEnqueueInput as EnqueueInput
} from '../../shared/types';

export { GeminiJobQueue } from './job-queue.mjs';
