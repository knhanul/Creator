/**
 * 원문 자동 검색·가져오기·저작권 검증·버전 관리 공용 타입 (main / preload / renderer 공용).
 */
import type { Genre } from './types';

/** 저작권 검토 상태 (6종 필수 구분) */
export type RightsReviewStatus =
  | 'PUBLIC_DOMAIN_VERIFIED'
  | 'LICENSE_VERIFIED'
  | 'USER_RIGHTS_DECLARED'
  | 'REVIEW_REQUIRED'
  | 'RESTRICTED'
  | 'UNKNOWN';

/** 용도별 이용허락 판정 */
export type UsageAllowance = 'allowed' | 'conditional' | 'restricted' | 'unknown';

/** 7개 활용 용도별 이용 가능 여부 */
export interface UsagePermissions {
  storage: UsageAllowance;
  aiAnalysis: UsageAllowance;
  narration: UsageAllowance;
  subtitles: UsageAllowance;
  videoCreation: UsageAllowance;
  publicRelease: UsageAllowance;
  monetization: UsageAllowance;
}

/** 한국 저작권법 보호기간 검토 결과 (제39조·제44조 참고, 자동 단정 금지) */
export interface ProtectionTermCalculation {
  calculated: boolean;
  expired?: boolean;
  expiryYear?: number;
  baseYear?: number;
  termYears?: number;
  rule: string;
  warnings: string[];
  autoConclusive: boolean;
}

/** 저작권 및 이용허락 근거 정보 */
export interface RightsEvidence {
  status: RightsReviewStatus;
  /** 요약 판정 근거 */
  basis: string;
  /** 세부 확인 근거 목록 */
  evidenceItems: string[];
  licenseName?: string;
  licenseUrl?: string;
  authorDeathYear?: number | null;
  translatorName?: string;
  translatorDeathYear?: number | null;
  isTranslation?: boolean;
  isJointWork?: boolean;
  isAnonymousOrPseudonymous?: boolean;
  isForeignWork?: boolean;
  jurisdiction?: string;
  protectionCalculation?: ProtectionTermCalculation;
  usage: UsagePermissions;
  /** 사용자 추가 확인이 필요한지 여부 */
  needsManualReview: boolean;
  /** 사용자가 반드시 확인해야 할 항목 */
  reviewItems: string[];
  /** 출처 표기 필요 여부 */
  attributionRequired?: boolean;
  /** 동일성 유지(원문 훼손 금지) 안내 필요 여부 */
  integrityRequired?: boolean;
  /** 제공처 접근·다운로드 조건 메모 */
  sourceAccessNote?: string;
  /** 사용자 직접 신고 내용 (USER_RIGHTS_DECLARED일 때만) */
  userDeclarationNote?: string;
  /** 사용자 직접 신고 시각 */
  userDeclaredAt?: string;
  checkedAt: string;
}

/** 원문 정확성 검증 항목 */
export type VerificationSeverity = 'info' | 'warning' | 'error';

export interface TextVerificationIssue {
  code:
    | 'TITLE_MISMATCH'
    | 'AUTHOR_MISMATCH'
    | 'POSSIBLE_TRUNCATION'
    | 'DUPLICATE_LINE'
    | 'DUPLICATE_STANZA'
    | 'BLANK_LINE_ANOMALY'
    | 'BOUNDARY_ARTIFACT'
    | 'MIXED_EDITION'
    | 'ENCODING_OR_OCR_ERROR'
    | 'BIBLE_VERSE_MISSING'
    | 'BIBLE_VERSE_UNREQUESTED'
    | 'BIBLE_TRANSLATION_MIXED'
    | 'CHROME_OR_AD_CONTAMINATION'
    | 'EMPTY_TEXT'
    | 'FILE_EXTRACTION_NOTICE';
  severity: VerificationSeverity;
  message: string;
  suggestion?: string;
  lineNumbers?: number[];
}

export interface TextVerificationReport {
  checkedAt: string;
  charCount: number;
  lineCount: number;
  stanzaCount: number;
  preservesLineBreaks: boolean;
  issues: TextVerificationIssue[];
  passed: boolean;
}

/** 두 판본 비교 결과 */
export interface EditionComparisonLineDiff {
  lineIndex: number;
  primaryLine: string;
  secondaryLine: string;
  kind: 'same' | 'different' | 'missing_in_primary' | 'missing_in_secondary';
}

export interface EditionComparisonSummary {
  compared: boolean;
  message: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  sameCount?: number;
  differentCount?: number;
  suspectedMissingCount?: number;
  similarityRatio?: number;
  editionNotes?: string[];
  diffs?: EditionComparisonLineDiff[];
}

/** 성경 본문 지정 정보 */
export interface BibleReference {
  translationId: string;
  translationName: string;
  testament: 'old' | 'new';
  bookId: number;
  bookName: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
}

/** 원문 입력 방식 */
export type OriginalInputMethod = 'search' | 'url' | 'file' | 'bible' | 'manual';

/** 원문 검색 질의 */
export interface SourceSearchQuery {
  query: string;
  author?: string;
  genre?: Genre | 'all';
  providerIds?: string[];
  limit?: number;
}

/** 검색 결과 후보 (검색 단계와 원문 확보 단계는 분리됨) */
export interface SourceCandidate {
  sourceId: string;
  sourceName: string;
  workId: string;
  title: string;
  author: string;
  translator?: string;
  edition: string;
  publishedYear?: string;
  genreHint?: Genre;
  snippet?: string;
  sourceUrl: string;
  /** 원문을 자동으로 가져올 수 있는지 (공식 페이지 안내 전용이면 false) */
  autoFetchSupported: boolean;
  /** 검색 시점에서는 원문 미확보 상태 */
  textFetched: false;
  /** 검색 시점의 예비 저작권 상태 (원문 확보 시 재검증) */
  preliminaryRightsStatus: RightsReviewStatus;
  accessNote?: string;
  /** 제공처 내부 메타데이터 */
  meta?: Record<string, unknown>;
}

/** 실제 원문 가져오기 결과 */
export interface OriginalFetchResult {
  ok: boolean;
  sourceId: string;
  sourceName: string;
  workId: string;
  title: string;
  author: string;
  translator?: string;
  edition: string;
  publishedYear?: string;
  sourceUrl: string;
  /** 실제 원문 텍스트 (가져오기 실패·공식 페이지 전용이면 undefined) */
  originalText?: string;
  /** 자동 수집 불가 시 공식 페이지 링크 등 접근 안내 */
  accessInfo?: {
    manualOnly: boolean;
    officialUrl: string;
    reason: string;
  };
  rights: RightsEvidence;
  verification?: TextVerificationReport;
  comparison?: EditionComparisonSummary;
  bibleRef?: BibleReference;
  fetchedAt: string;
  inputMethod: OriginalInputMethod;
  errorCode?: string;
  errorMessage?: string;
  /** 제공처 내부 참고 데이터 */
  meta?: Record<string, unknown>;
}

/** 검색 응답 (복수 제공처 통합) */
export interface SourceSearchResponse {
  query: SourceSearchQuery;
  candidates: SourceCandidate[];
  /** 같은 제목의 다른 작가/판본이 감지되었는지 안내 */
  disambiguationNote?: string;
  providerStatuses: {
    providerId: string;
    providerName: string;
    ok: boolean;
    count: number;
    message?: string;
  }[];
}

/** 확정된 기준 원문 메타데이터 (Brief에 저장) */
export interface OriginalSourceMeta {
  inputMethod: OriginalInputMethod;
  providerId: string;
  providerName: string;
  workId: string;
  title: string;
  author: string;
  translator?: string;
  edition: string;
  publishedYear?: string;
  sourceUrl: string;
  fetchedAt: string;
  approvedAt: string;
  sha256: string;
  version: number;
  rights: RightsEvidence;
  bibleRef?: BibleReference;
  verification?: TextVerificationReport;
  comparison?: EditionComparisonSummary;
}

/** 기준 원문 변경 시 보존되는 과거 이력 항목 */
export interface OriginalVersionEntry {
  version: number;
  title: string;
  author: string;
  source: string;
  sourceUrl: string;
  originalText: string;
  sha256: string;
  approvedAt: string;
  archivedAt: string;
  reason?: string;
  meta?: OriginalSourceMeta;
}

/** 원문 변경 후 후속 단계 재검토 필요 표시 */
export interface StageReviewFlags {
  analysis?: boolean;
  storyboard?: boolean;
  prompt?: boolean;
  editplan?: boolean;
  subtitles?: boolean;
  reason?: string;
  changedAt?: string;
  fromVersion?: number;
  toVersion?: number;
}

/** 제공처 목록 안내용 정보 */
export interface SourceProviderInfo {
  id: string;
  name: string;
  description: string;
  kinds: ('literature' | 'bible' | 'url' | 'file')[];
  autoFetchSupported: boolean;
  officialUrl: string;
}

/** 성경 가져오기 요청 */
export interface BibleFetchRequest {
  translationId: string;
  bookId: number;
  chapter: number;
  startVerse: number;
  endVerse: number;
}
