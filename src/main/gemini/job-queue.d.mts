/** Type declarations for job-queue.mjs (runtime is plain JS so it can be tested directly with node). */
import type { GeminiJobRecord, EnqueueInput } from './job-queue';

export interface QueueSubmitResult {
  success: boolean;
  uncertain?: boolean;
  sendState?: 'sent' | 'not_sent' | 'uncertain';
  needsUser?: boolean;
  errorCode?: string;
  message?: string;
  tab?: { id: number; title: string; url?: string };
  insertMethod?: string;
  evidence?: string;
}
export interface QueueProvider {
  submit(job: GeminiJobRecord): Promise<QueueSubmitResult>;
  cancelExternal?(jobId: string): Promise<boolean>;
}
export declare class GeminiJobQueue {
  constructor(storePath: string);
  storePath: string;
  jobs: GeminiJobRecord[];
  load(): Promise<void>;
  recoverOnStartup(): void;
  subscribe(fn: () => void): () => void;
  list(): GeminiJobRecord[];
  get(jobId: string): GeminiJobRecord | undefined;
  findActive(projectId: string, kind: string): GeminiJobRecord | undefined;
  latest(projectId: string, kind?: string): GeminiJobRecord | undefined;
  enqueue(input: EnqueueInput): Promise<GeminiJobRecord>;
  tick(provider: QueueProvider): Promise<void>;
  onResponse(jobId: string, requestId: string, text: string, complete: boolean, extra?: { projectId?: string; codeBlocks?: string[]; isolation?: string }): Promise<'applied' | 'ignored'>;
  setPhase(jobId: string, requestId: string, phase: string, info?: Record<string, unknown>, projectId?: string): Promise<'applied' | 'ignored'>;
  onRemoteError(jobId: string, requestId: string, projectId: string | undefined, code: string, message: string, partialText?: string): Promise<'applied' | 'ignored'>;
  markConnectionLost(): Promise<boolean>;
  expireStale(maxIdleMs: number, nowMs?: number): Promise<boolean>;
  setOutcome(jobId: string, requestId: string, fields: Partial<GeminiJobRecord>): Promise<GeminiJobRecord | null>;
  cancel(jobId: string, provider?: QueueProvider): Promise<GeminiJobRecord | null>;
  retry(jobId: string): Promise<GeminiJobRecord | null>;
  confirmResend(jobId: string): Promise<GeminiJobRecord | null>;
  continueWaiting(jobId: string): Promise<GeminiJobRecord | null>;
  persist(): Promise<void>;
}
