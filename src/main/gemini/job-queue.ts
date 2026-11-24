/**
 * Typed facade over job-queue.mjs (single implementation).
 */
export type JobKind = 'analysis' | 'storyboard' | 'prompt' | 'editplan' | 'image' | 'video' | 'music';
export type JobState =
  | 'queued'
  | 'dispatching'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'needs_confirmation'
  | 'cancelled'
  | 'cancelling';

export interface GeminiJobRecord {
  jobId: string;
  requestId: string;
  projectId: string;
  sceneId?: string;
  kind: JobKind;
  executable: boolean;
  prompt: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  sentAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  resultText?: string;
  resultRef?: string;
  cancelRequested: boolean;
  externalCancelConfirmed: boolean;
  sendConfirmed: boolean;
}

export interface EnqueueInput {
  projectId: string;
  kind: JobKind;
  prompt: string;
  sceneId?: string;
}

export { GeminiJobQueue } from './job-queue.mjs';
