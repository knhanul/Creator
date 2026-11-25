/**
 * Source Adapter 인터페이스 (원문 제공처와 UI 완전 분리).
 */
import type {
  OriginalFetchResult,
  RightsEvidence,
  SourceCandidate,
  SourceProviderInfo,
  SourceSearchQuery
} from '../../shared/source-types';

export interface OriginalSourceProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly officialUrl: string;
  readonly autoFetchSupported: boolean;
  readonly kinds: SourceProviderInfo['kinds'];

  search(query: SourceSearchQuery): Promise<SourceCandidate[]>;
  fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult>;
  getRightsInfo(candidate: SourceCandidate): Promise<RightsEvidence>;
}

export interface SafeHttpResponse {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
  bytes: number;
}

export interface SafeHttpClient {
  fetchText(
    url: string,
    opts?: {
      timeoutMs?: number;
      maxBytes?: number;
      checkRobots?: boolean;
      accept?: string;
    }
  ): Promise<SafeHttpResponse>;
  isRobotsAllowed(url: string): Promise<{ allowed: boolean; reason?: string }>;
}
