/**
 * 저작권 검증 모듈 (한국 저작권법 제39조·제44조 참고).
 *
 * 핵심 원칙:
 * 1. 저작권이 불분명한 원문은 절대 자동으로 이용 가능(PUBLIC_DOMAIN_VERIFIED / LICENSE_VERIFIED) 판정하지 않는다.
 * 2. 작가 사망연도를 모르면 임의로 추정하지 않는다.
 * 3. 공동저작물, 무명·이명 저작물, 번역저작물, 국외 저작물, 경과규정 경계, 권리자 불명확 시 일반 계산만으로 자동 확정하지 않는다.
 * 4. 사용자가 직접 신고한 권리 상태(USER_RIGHTS_DECLARED)와 시스템 검증 상태(PUBLIC_DOMAIN_VERIFIED / LICENSE_VERIFIED)를 혼동하지 않는다.
 */
import type {
  ProtectionTermCalculation,
  RightsEvidence,
  RightsReviewStatus,
  UsageAllowance,
  UsagePermissions
} from './source-types';
import type { Brief } from './types';

export const RIGHTS_STATUS_META: Record<
  RightsReviewStatus,
  { label: string; shortLabel: string; tone: 'success' | 'accent' | 'warning' | 'muted'; systemVerified: boolean; description: string }
> = {
  PUBLIC_DOMAIN_VERIFIED: {
    label: '퍼블릭 도메인 확인됨',
    shortLabel: '퍼블릭 도메인',
    tone: 'success',
    systemVerified: true,
    description: '저작재산권 보호기간 만료가 확인 가능한 근거로 검토되었습니다. 판본·출처 표기 및 동일성 유지 조건을 함께 확인하세요.'
  },
  LICENSE_VERIFIED: {
    label: '이용허락 확인됨',
    shortLabel: '이용허락 확인',
    tone: 'success',
    systemVerified: true,
    description: '명시적 이용허락(라이선스) 근거가 확인되었습니다. 허용 용도(상업적 이용, 2차적저작물, 출처 표기 등)를 확인하세요.'
  },
  USER_RIGHTS_DECLARED: {
    label: '사용자 권리 직접 신고',
    shortLabel: '사용자 신고',
    tone: 'accent',
    systemVerified: false,
    description: '사용자가 권리 보유 또는 이용허락 확보를 직접 신고한 상태입니다(시스템 검증과 구분됨).'
  },
  REVIEW_REQUIRED: {
    label: '저작권 추가 확인 필요',
    shortLabel: '확인 필요',
    tone: 'warning',
    systemVerified: false,
    description: '자동 판정할 수 없는 예외 사항(번역·공동저작·국외저작·경과규정 등)이 있어 사용자의 직접 확인이 필요합니다.'
  },
  RESTRICTED: {
    label: '이용 제한됨',
    shortLabel: '이용 제한',
    tone: 'warning',
    systemVerified: false,
    description: '저작권이 보호 중이거나 확인된 허락 범위를 벗어나 자동 수집·무단 이용이 제한됩니다.'
  },
  UNKNOWN: {
    label: '권리 정보 부족',
    shortLabel: '정보 부족',
    tone: 'muted',
    systemVerified: false,
    description: '신뢰할 수 있는 저작권 정보를 찾지 못했습니다. 이용 가능 여부를 직접 확인하기 전에는 자동 승인하지 않습니다.'
  }
};

export const USAGE_LABELS: Record<keyof UsagePermissions, string> = {
  storage: '원문 로컬 저장',
  aiAnalysis: 'AI 분석(외부 Gemini 전송)',
  narration: '낭독(음성 녹음)',
  subtitles: '자막 표시',
  videoCreation: '영상 제작',
  publicRelease: 'YouTube 등 외부 공개',
  monetization: '수익화(상업적 이용)'
};

export const ALLOWANCE_LABELS: Record<UsageAllowance, { label: string; tone: 'success' | 'warning' | 'muted' }> = {
  allowed: { label: '허용 근거 있음', tone: 'success' },
  conditional: { label: '조건 확인 필요', tone: 'warning' },
  restricted: { label: '제한됨', tone: 'warning' },
  unknown: { label: '확인 불가', tone: 'muted' }
};

export function unknownUsage(): UsagePermissions {
  return {
    storage: 'unknown',
    aiAnalysis: 'unknown',
    narration: 'unknown',
    subtitles: 'unknown',
    videoCreation: 'unknown',
    publicRelease: 'unknown',
    monetization: 'unknown'
  };
}

export function restrictedUsage(): UsagePermissions {
  return {
    storage: 'restricted',
    aiAnalysis: 'restricted',
    narration: 'restricted',
    subtitles: 'restricted',
    videoCreation: 'restricted',
    publicRelease: 'restricted',
    monetization: 'restricted'
  };
}

export function publicDomainUsage(noteExtra = false): UsagePermissions {
  return {
    storage: 'allowed',
    aiAnalysis: 'conditional', // 외부 서비스(Gemini) 전송 안내 필요
    narration: 'allowed',
    subtitles: 'allowed',
    videoCreation: 'allowed',
    publicRelease: noteExtra ? 'conditional' : 'allowed',
    monetization: noteExtra ? 'conditional' : 'allowed'
  };
}

/**
 * 한국 저작권법 제39조(보호기간의 원칙) 및 제44조(보호기간의 기산: 다음 해 1월 1일부터 기산) 참고 검토.
 * 예외 사유가 하나라도 있으면 autoConclusive = false 로 돌려주어 자동 확정하지 않는다.
 */
export interface ProtectionTermInput {
  authorDeathYear?: number | null;
  publishedYear?: number | null;
  isJointWork?: boolean;
  isAnonymousOrPseudonymous?: boolean;
  isTranslation?: boolean;
  translatorDeathYear?: number | null;
  isForeignWork?: boolean;
  unclearRightsHolder?: boolean;
  hasSpecialException?: boolean;
  referenceYear?: number;
}

export function evaluateKoreanProtectionTerm(input: ProtectionTermInput): ProtectionTermCalculation {
  const refYear = input.referenceYear ?? new Date().getFullYear();
  const warnings: string[] = [];

  if (input.isJointWork) {
    warnings.push('공동저작물은 맨 마지막으로 사망한 저작자의 사망 시점을 기준으로 보호기간을 계산해야 하므로 자동 확정할 수 없습니다.');
  }
  if (input.isAnonymousOrPseudonymous) {
    warnings.push('무명·이명 저작물은 공표 시점 기준 보호기간(저작권법 제40조) 또는 실명 확인 여부에 따라 달라지므로 자동 확정할 수 없습니다.');
  }
  if (input.isTranslation) {
    warnings.push('번역저작물은 원작과 별개의 2차적저작물 권리가 발생합니다. 번역자의 저작재산권 보호기간 또는 이용허락을 별도로 확인해야 합니다.');
  }
  if (input.isForeignWork) {
    warnings.push('국외 저작물은 본국 및 대한민국의 보호기간과 국제조약(베른협약 등) 상호주의·복원 규정을 별도로 확인해야 합니다.');
  }
  if (input.unclearRightsHolder) {
    warnings.push('권리자 정보가 불명확하여 보호기간 만료를 자동 단정할 수 없습니다.');
  }
  if (input.hasSpecialException) {
    warnings.push('단체명의·영상·경과규정 등 보호기간 산정 특례 가능성이 있어 법적 검토가 필요합니다.');
  }

  if (input.authorDeathYear === null || input.authorDeathYear === undefined || !Number.isInteger(input.authorDeathYear)) {
    warnings.push('작가 사망연도 정보가 없어 보호기간을 계산할 수 없습니다(임의 추정 금지).');
    return {
      calculated: false,
      rule: '대한민국 저작권법 제39조·제44조 (사망연도 미확인)',
      warnings,
      autoConclusive: false
    };
  }

  const deathYear = input.authorDeathYear;
  // 한국 저작권법: 2013년 7월 1일 시행으로 사후 50년 -> 사후 70년 연장.
  // 1962년 이전 사망자는 구법 50년 보호기간이 2012년 말까지 이미 만료됨(단, 경과규정·재발행·판본 특례 주의).
  // 1963년 이후 사망자는 사후 70년 적용 (사망 다음 해 1월 1일부터 70년 → deathYear + 70년 12월 31일 만료).
  let termYears = 70;
  let rule = '대한민국 저작권법 제39조(저작자 사후 70년) 및 제44조(다음 해 1월 1일 기산)';

  if (deathYear <= 1962) {
    termYears = 50;
    rule = '대한민국 구 저작권법(사후 50년, 2013.7.1. 연장 시행 전 이미 보호기간 만료 대상) 및 제44조 참고';
    if (deathYear >= 1957) {
      warnings.push('1957~1962년 사망 저작자는 구법/개정법 경과규정 및 출판판본 권리를 추가 확인하는 것이 안전합니다.');
    }
  }

  // 번역 저작물일 경우 번역자 사망연도도 별도 체크
  if (input.isTranslation) {
    if (input.translatorDeathYear === null || input.translatorDeathYear === undefined) {
      warnings.push('번역자의 사망연도가 확인되지 않아 한국어 번역본의 보호기간 만료를 확정할 수 없습니다.');
    } else {
      const trTerm = input.translatorDeathYear <= 1962 ? 50 : 70;
      const trExpiry = input.translatorDeathYear + trTerm;
      if (refYear <= trExpiry) {
        warnings.push(`번역자 사망연도(${input.translatorDeathYear}년) 기준 번역 저작물 보호기간(${trExpiry}년 말)이 만료되지 않았을 수 있습니다.`);
      }
    }
  }

  const expiryYear = deathYear + termYears;
  const expired = refYear > expiryYear;
  const hasBlockingException = Boolean(
    input.isJointWork ||
      input.isAnonymousOrPseudonymous ||
      input.isTranslation ||
      input.isForeignWork ||
      input.unclearRightsHolder ||
      input.hasSpecialException ||
      (deathYear >= 1957 && deathYear <= 1962)
  );

  return {
    calculated: true,
    expired,
    expiryYear,
    baseYear: deathYear,
    termYears,
    rule,
    warnings,
    autoConclusive: !hasBlockingException
  };
}

/**
 * 메타데이터와 제공처 근거를 종합해 RightsEvidence를 생성.
 * 확인되지 않은 경우 절대 PUBLIC_DOMAIN_VERIFIED / LICENSE_VERIFIED를 반환하지 않는다.
 */
export interface RightsAssessmentInput extends ProtectionTermInput {
  providerEvidenceStatus?: RightsReviewStatus;
  providerEvidenceItems?: string[];
  licenseName?: string;
  licenseUrl?: string;
  licenseAllowsCommercial?: boolean;
  licenseAllowsDerivatives?: boolean;
  licenseRequiresAttribution?: boolean;
  licenseShareAlike?: boolean;
  translatorName?: string;
  jurisdiction?: string;
  sourceAccessNote?: string;
}

export function evaluateRightsEvidence(input: RightsAssessmentInput): RightsEvidence {
  const checkedAt = new Date().toISOString();
  const calc = evaluateKoreanProtectionTerm(input);
  const evidenceItems = [...(input.providerEvidenceItems || [])];
  const reviewItems = [...calc.warnings];

  if (calc.calculated && calc.baseYear !== undefined && calc.expiryYear !== undefined) {
    evidenceItems.push(
      `저자 사망연도 ${calc.baseYear}년 기준 ${calc.rule} → 추정 만료: ${calc.expiryYear}년 12월 31일 (${calc.expired ? '경과' : '미경과'})`
    );
  }

  // 1) 명시적 RESTRICTED가 확인된 경우 최우선 차단
  if (input.providerEvidenceStatus === 'RESTRICTED') {
    return {
      status: 'RESTRICTED',
      basis: '제공처 또는 저작권 정보에서 이용 제한(저작권 보호 중)으로 확인되었습니다.',
      evidenceItems,
      licenseName: input.licenseName,
      licenseUrl: input.licenseUrl,
      authorDeathYear: input.authorDeathYear ?? null,
      translatorName: input.translatorName,
      translatorDeathYear: input.translatorDeathYear ?? null,
      isTranslation: input.isTranslation,
      isJointWork: input.isJointWork,
      isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
      isForeignWork: input.isForeignWork,
      jurisdiction: input.jurisdiction,
      protectionCalculation: calc,
      usage: restrictedUsage(),
      needsManualReview: true,
      reviewItems: reviewItems.length ? reviewItems : ['권리자의 명시적 이용허락 없이는 사용할 수 없습니다.'],
      sourceAccessNote: input.sourceAccessNote,
      checkedAt
    };
  }

  // 2) 명시적 이용허락(CC / KOGL 등)이 확인된 경우
  if (input.providerEvidenceStatus === 'LICENSE_VERIFIED' && input.licenseName) {
    const allowsDerivatives = input.licenseAllowsDerivatives !== false;
    const allowsCommercial = input.licenseAllowsCommercial !== false;
    const usage: UsagePermissions = {
      storage: 'allowed',
      aiAnalysis: 'conditional',
      narration: allowsDerivatives ? 'allowed' : 'conditional',
      subtitles: 'allowed',
      videoCreation: allowsDerivatives ? 'allowed' : 'restricted',
      publicRelease: 'conditional',
      monetization: allowsCommercial ? 'conditional' : 'restricted'
    };
    if (!allowsCommercial) {
      reviewItems.push('비영리(NC) 조건 라이선스입니다. YouTube 수익화 등 상업적 이용이 제한됩니다.');
    }
    if (!allowsDerivatives) {
      reviewItems.push('변경금지(ND) 조건 라이선스입니다. 영상화·편집 활용 가능 여부를 반드시 확인하세요.');
    }
    if (input.licenseShareAlike) {
      reviewItems.push('동일조건변경허락(SA) 조건이 포함되어 있습니다. 파생 영상의 배포 조건을 확인하세요.');
    }
    if (input.licenseRequiresAttribution) {
      reviewItems.push('출처 및 저작자 표시(BY) 의무가 있습니다.');
    }
    if (input.isTranslation) {
      reviewItems.push('번역저작물의 원저작물 권리와 번역 라이선스 적용 범위를 함께 확인하세요.');
    }

    return {
      status: input.isTranslation ? 'REVIEW_REQUIRED' : 'LICENSE_VERIFIED',
      basis: input.isTranslation
        ? `라이선스(${input.licenseName})가 기재되어 있으나 번역저작물 권리 추가 확인이 필요합니다.`
        : `확인 가능한 이용허락(${input.licenseName})이 확인되었습니다.`,
      evidenceItems,
      licenseName: input.licenseName,
      licenseUrl: input.licenseUrl,
      authorDeathYear: input.authorDeathYear ?? null,
      translatorName: input.translatorName,
      translatorDeathYear: input.translatorDeathYear ?? null,
      isTranslation: input.isTranslation,
      isJointWork: input.isJointWork,
      isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
      isForeignWork: input.isForeignWork,
      jurisdiction: input.jurisdiction,
      protectionCalculation: calc,
      usage,
      needsManualReview: reviewItems.length > 0 || Boolean(input.isTranslation),
      reviewItems,
      attributionRequired: input.licenseRequiresAttribution,
      integrityRequired: true,
      sourceAccessNote: input.sourceAccessNote,
      checkedAt
    };
  }

  // 3) 보호기간이 명백히 미경과인 경우
  if (calc.calculated && calc.expired === false) {
    return {
      status: 'RESTRICTED',
      basis: `저자 사망연도(${calc.baseYear}년) 기준 보호기간(${calc.expiryYear}년 말)이 아직 만료되지 않은 것으로 계산됩니다.`,
      evidenceItems,
      licenseName: input.licenseName,
      licenseUrl: input.licenseUrl,
      authorDeathYear: input.authorDeathYear ?? null,
      translatorName: input.translatorName,
      translatorDeathYear: input.translatorDeathYear ?? null,
      isTranslation: input.isTranslation,
      isJointWork: input.isJointWork,
      isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
      isForeignWork: input.isForeignWork,
      jurisdiction: input.jurisdiction,
      protectionCalculation: calc,
      usage: restrictedUsage(),
      needsManualReview: true,
      reviewItems: [...reviewItems, '저작재산권 보호기간이 남아 있을 가능성이 높습니다. 이용허락을 확인하세요.'],
      sourceAccessNote: input.sourceAccessNote,
      checkedAt
    };
  }

  // 4) 신뢰 가능한 제공처의 퍼블릭 도메인 근거 OR 한국 저작권법 일반 계산 만료(예외 없음)
  const verifiedByCalc = calc.calculated && calc.expired === true && calc.autoConclusive;
  const verifiedByProvider =
    input.providerEvidenceStatus === 'PUBLIC_DOMAIN_VERIFIED' &&
    !input.isTranslation &&
    !input.isJointWork &&
    !input.isAnonymousOrPseudonymous &&
    !input.unclearRightsHolder &&
    !input.hasSpecialException;

  if (verifiedByCalc || (verifiedByProvider && !input.isForeignWork)) {
    if (input.isForeignWork) {
      reviewItems.push('국외 저작물의 한국 내 보호기간 및 출판 판본 권리를 최종 확인하세요.');
    }
    return {
      status: 'PUBLIC_DOMAIN_VERIFIED',
      basis: verifiedByCalc
        ? `저자 사망연도(${calc.baseYear}년)와 출처 근거를 기준으로 대한민국 저작재산권 보호기간 만료가 확인되었습니다.`
        : '신뢰 가능한 출처의 퍼블릭 도메인 표기 근거가 확인되었습니다.',
      evidenceItems,
      licenseName: input.licenseName || '퍼블릭 도메인 (보호기간 만료)',
      licenseUrl: input.licenseUrl,
      authorDeathYear: input.authorDeathYear ?? null,
      translatorName: input.translatorName,
      translatorDeathYear: input.translatorDeathYear ?? null,
      isTranslation: input.isTranslation,
      isJointWork: input.isJointWork,
      isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
      isForeignWork: input.isForeignWork,
      jurisdiction: input.jurisdiction || '대한민국',
      protectionCalculation: calc,
      usage: publicDomainUsage(Boolean(input.isForeignWork)),
      needsManualReview: reviewItems.length > 0,
      reviewItems,
      attributionRequired: true,
      integrityRequired: true,
      sourceAccessNote: input.sourceAccessNote,
      checkedAt
    };
  }

  // 5) 제공처 PD 표기 또는 만료 계산이 있으나 예외(번역·국외·공동·경과규정 등)로 자동 확정 불가 → REVIEW_REQUIRED
  if (
    input.providerEvidenceStatus === 'PUBLIC_DOMAIN_VERIFIED' ||
    input.providerEvidenceStatus === 'REVIEW_REQUIRED' ||
    (calc.calculated && calc.expired === true)
  ) {
    return {
      status: 'REVIEW_REQUIRED',
      basis: '일부 퍼블릭 도메인 단서가 있으나 예외 사항(번역·국외·공동저작·사망연도 미확인 등)으로 자동 확정할 수 없어 사용자 검토가 필요합니다.',
      evidenceItems,
      licenseName: input.licenseName,
      licenseUrl: input.licenseUrl,
      authorDeathYear: input.authorDeathYear ?? null,
      translatorName: input.translatorName,
      translatorDeathYear: input.translatorDeathYear ?? null,
      isTranslation: input.isTranslation,
      isJointWork: input.isJointWork,
      isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
      isForeignWork: input.isForeignWork,
      jurisdiction: input.jurisdiction,
      protectionCalculation: calc,
      usage: {
        storage: 'conditional',
        aiAnalysis: 'conditional',
        narration: 'unknown',
        subtitles: 'unknown',
        videoCreation: 'unknown',
        publicRelease: 'unknown',
        monetization: 'unknown'
      },
      needsManualReview: true,
      reviewItems: reviewItems.length ? reviewItems : ['출처의 원 저작자·번역자·판본 권리를 직접 확인하세요.'],
      attributionRequired: true,
      integrityRequired: true,
      sourceAccessNote: input.sourceAccessNote,
      checkedAt
    };
  }

  // 6) 정보 부족 → UNKNOWN (절대 이용 가능으로 자동 판정하지 않음)
  return {
    status: 'UNKNOWN',
    basis: '신뢰할 수 있는 저작권·이용허락 근거를 찾지 못했습니다. 이용 가능 여부를 직접 확인해야 합니다.',
    evidenceItems,
    licenseName: input.licenseName,
    licenseUrl: input.licenseUrl,
    authorDeathYear: input.authorDeathYear ?? null,
    translatorName: input.translatorName,
    translatorDeathYear: input.translatorDeathYear ?? null,
    isTranslation: input.isTranslation,
    isJointWork: input.isJointWork,
    isAnonymousOrPseudonymous: input.isAnonymousOrPseudonymous,
    isForeignWork: input.isForeignWork,
    jurisdiction: input.jurisdiction,
    protectionCalculation: calc,
    usage: unknownUsage(),
    needsManualReview: true,
    reviewItems: reviewItems.length ? reviewItems : ['저작권 보호기간 만료 또는 이용허락 여부를 직접 확인하기 전에는 배포·수익화에 사용하지 마세요.'],
    sourceAccessNote: input.sourceAccessNote,
    checkedAt
  };
}

/**
 * 사용자가 직접 권리 보유 또는 이용허락을 신고할 때 호출.
 * 시스템 검증 상태(PUBLIC_DOMAIN_VERIFIED / LICENSE_VERIFIED)로 위장하지 않고 USER_RIGHTS_DECLARED로 분리 기록한다.
 */
export function applyUserRightsDeclaration(current: RightsEvidence, note: string): RightsEvidence {
  const trimmed = note.trim();
  if (!trimmed) {
    throw new Error('권리 보유 또는 이용허락 근거 메모를 입력해 주세요.');
  }
  const now = new Date().toISOString();
  return {
    ...current,
    status: 'USER_RIGHTS_DECLARED',
    basis: `사용자가 직접 이용 권한을 신고함: ${trimmed}`,
    evidenceItems: [...current.evidenceItems, `[사용자 직접 신고 ${now.slice(0, 10)}] ${trimmed}`],
    userDeclarationNote: trimmed,
    userDeclaredAt: now,
    usage: {
      storage: 'allowed',
      aiAnalysis: 'conditional',
      narration: 'conditional',
      subtitles: 'conditional',
      videoCreation: 'conditional',
      publicRelease: 'conditional',
      monetization: 'conditional'
    },
    needsManualReview: false,
    checkedAt: now
  };
}

/**
 * 자동 승인 방지 가드:
 * - UNKNOWN, REVIEW_REQUIRED, RESTRICTED 상태는 자동 승인 불가!
 * - 모든 원문은 기본적으로 사용자 검토 후 확정해야 하며, 미확인 권리 상태는 명시적 사용자 확인/신고 없이 확정할 수 없다.
 */
export function canApproveOriginalRights(
  rights: RightsEvidence | undefined,
  opts: { allowReviewRequiredWithAck?: boolean } = {}
): { allowed: boolean; reason?: string } {
  if (!rights) {
    return { allowed: false, reason: '저작권 검토 정보가 없습니다. 권리 상태를 먼저 확인해 주세요.' };
  }
  if (rights.status === 'RESTRICTED') {
    return { allowed: false, reason: '이용이 제한된 저작물입니다. 별도 이용허락을 확보해 직접 신고하기 전에는 확정할 수 없습니다.' };
  }
  if (rights.status === 'UNKNOWN') {
    return { allowed: false, reason: '권리 상태가 불명확(UNKNOWN)하여 자동 승인할 수 없습니다. 이용 권한을 직접 확인하고 신고하거나 확인된 출처를 선택하세요.' };
  }
  if (rights.status === 'REVIEW_REQUIRED' && !opts.allowReviewRequiredWithAck) {
    return { allowed: false, reason: '저작권 추가 확인이 필요합니다(REVIEW_REQUIRED). 검토 항목을 확인한 뒤 사용자 권리 신고를 완료하거나 확인 체크를 해 주세요.' };
  }
  return { allowed: true };
}

/** 신규 RightsReviewStatus → 기존 Brief.rightsStatus 하위 호환 매핑 */
export function toLegacyRightsStatus(status: RightsReviewStatus): Brief['rightsStatus'] {
  if (status === 'PUBLIC_DOMAIN_VERIFIED') return 'public-domain';
  if (status === 'LICENSE_VERIFIED') return 'licensed';
  if (status === 'USER_RIGHTS_DECLARED') return 'reviewed';
  return 'unreviewed';
}

/** 기존 Brief.rightsStatus → RightsReviewStatus 매핑 (기존 프로젝트 마이그레이션용) */
export function fromLegacyRightsStatus(legacy: Brief['rightsStatus']): RightsReviewStatus {
  if (legacy === 'public-domain') return 'PUBLIC_DOMAIN_VERIFIED';
  if (legacy === 'licensed') return 'LICENSE_VERIFIED';
  if (legacy === 'reviewed') return 'USER_RIGHTS_DECLARED';
  return 'UNKNOWN';
}
