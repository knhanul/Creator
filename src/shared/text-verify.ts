/**
 * 원문 정확성 검증 및 판본 비교 모듈.
 *
 * 핵심 원칙:
 * - 원문의 띄어쓰기·맞춤법·고어·현대어·문장·연 순서·제목을 절대 자동으로 고치지 않는다.
 * - 발견된 문제는 수정 제안(TextVerificationIssue)으로만 표시하고 원문 문자열은 그대로 유지한다.
 * - 비교 가능한 독립 판본이 하나뿐이면 "다른 판본과 대조하지 못함"을 명시한다.
 * - AI가 생성한 문장을 두 번째 검증 자료로 사용하지 않는다.
 */
import type {
  BibleReference,
  EditionComparisonLineDiff,
  EditionComparisonSummary,
  TextVerificationIssue,
  TextVerificationReport
} from './source-types';
import type { Genre } from './types';

const CHROME_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(?:^|\n)\s*(?:로그인|회원가입|마이페이지|사이트맵)\s*(?:$|\n)/i, label: '웹사이트 로그인/메뉴 문구' },
  { re: /(?:^|\n)\s*(?:이전\s*글|다음\s*글|목록으로|맨\s*위로|공유하기|인쇄하기)\s*(?:$|\n)/i, label: '내비게이션 버튼 문구' },
  { re: /쿠키\s*(?:사용|정책)|개인정보\s*처리방침|All rights reserved/i, label: '웹사이트 푸터/약관 문구' },
  { re: /이\s*저작물은\s*저자가\s*사망한\s*지|크리에이티브\s*커먼즈\s*저작자표시|위키문헌에서\s*제공/i, label: '출처/라이선스 배너 문구' },
  { re: /\*\*\*\s*(?:START|END)\s+OF\s+(?:THE|THIS)\s+PROJECT\s+GUTENBERG/i, label: 'Project Gutenberg 머리말/꼬리말' }
];

const TRUNCATION_PATTERNS = [/\.\.\.\s*$/, /…\s*$/, /\[(?:생략|중략|하략|더보기)\]\s*$/, /더\s*보기\s*$/];

const MIXED_EDITION_MARKERS = [
  { label: '개역한글', re: /개역한글/ },
  { label: '개역개정', re: /개역개정/ },
  { label: '새번역', re: /표준새번역|새번역/ },
  { label: '공동번역', re: /공동번역/ },
  { label: '현대인의 성경', re: /현대인의\s*성경/ }
];

export interface VerifyOriginalTextOptions {
  text: string;
  genre?: Genre;
  expectedTitle?: string;
  actualTitle?: string;
  expectedAuthor?: string;
  actualAuthor?: string;
  bibleRef?: BibleReference;
  extraIssues?: TextVerificationIssue[];
}

function normCompare(s: string): string {
  return s.toLowerCase().replace(/[\s·.,()[\]'"`“”‘’]/g, '');
}

/**
 * 원문을 변경하지 않고 정확성·무결성 검사 보고서를 생성한다.
 */
export function verifyOriginalText(opts: VerifyOriginalTextOptions): TextVerificationReport {
  const checkedAt = new Date().toISOString();
  const raw = opts.text ?? '';
  const issues: TextVerificationIssue[] = [...(opts.extraIssues || [])];

  if (!raw.trim()) {
    issues.push({
      code: 'EMPTY_TEXT',
      severity: 'error',
      message: '원문 텍스트가 비어 있습니다.'
    });
    return {
      checkedAt,
      charCount: 0,
      lineCount: 0,
      stanzaCount: 0,
      preservesLineBreaks: true,
      issues,
      passed: false
    };
  }

  const normalizedNewlines = raw.replace(/\r\n?/g, '\n');
  const lines = normalizedNewlines.split('\n');
  const nonEmptyLines = lines.map((l, idx) => ({ text: l.trim(), lineNo: idx + 1 })).filter(x => x.text.length > 0);
  const stanzas = normalizedNewlines
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  // 1) 제목·작가 일치 여부
  if (opts.expectedTitle && opts.actualTitle) {
    const exp = normCompare(opts.expectedTitle);
    const act = normCompare(opts.actualTitle);
    if (exp && act && !act.includes(exp) && !exp.includes(act)) {
      issues.push({
        code: 'TITLE_MISMATCH',
        severity: 'warning',
        message: `검색한 제목("${opts.expectedTitle}")과 가져온 자료 제목("${opts.actualTitle}")이 다릅니다.`,
        suggestion: '같은 작품의 이표기·수집본인지 다른 작품인지 확인하세요.'
      });
    }
  }
  if (opts.expectedAuthor && opts.actualAuthor) {
    const exp = normCompare(opts.expectedAuthor);
    const act = normCompare(opts.actualAuthor);
    if (exp && act && !act.includes(exp) && !exp.includes(act)) {
      issues.push({
        code: 'AUTHOR_MISMATCH',
        severity: 'warning',
        message: `검색한 작가("${opts.expectedAuthor}")와 가져온 자료의 저자("${opts.actualAuthor}")가 다릅니다.`,
        suggestion: '동명이인 또는 동명 이작인지 확인하세요.'
      });
    }
  }

  // 2) 원문 누락/잘림 가능성
  const trimmed = normalizedNewlines.trim();
  if (trimmed.length < 20) {
    issues.push({
      code: 'POSSIBLE_TRUNCATION',
      severity: 'warning',
      message: `원문 길이가 매우 짧습니다(${trimmed.length}자). 본문 일부만 가져왔을 수 있습니다.`,
      suggestion: '원본 출처 페이지에서 전체 원문이 누락 없이 들어왔는지 확인하세요.'
    });
  }
  if (TRUNCATION_PATTERNS.some(re => re.test(trimmed))) {
    issues.push({
      code: 'POSSIBLE_TRUNCATION',
      severity: 'warning',
      message: '원문 끝부분에 생략 표시("...", "…", "더보기" 등)가 감지되었습니다.',
      suggestion: '미리보기 요약문만 추출되었을 수 있으므로 원문 전체를 확인하세요.'
    });
  }

  // 3) 중복된 행·연 감지 (시의 의도적 후렴구일 수 있으므로 자동 삭제하지 않고 안내만)
  const consecutiveDupLines: number[] = [];
  for (let i = 1; i < nonEmptyLines.length; i++) {
    if (nonEmptyLines[i].text.length >= 6 && nonEmptyLines[i].text === nonEmptyLines[i - 1].text) {
      consecutiveDupLines.push(nonEmptyLines[i].lineNo);
    }
  }
  if (consecutiveDupLines.length > 0) {
    issues.push({
      code: 'DUPLICATE_LINE',
      severity: 'info',
      message: `연속 중복된 행이 감지되었습니다(${consecutiveDupLines.slice(0, 5).map(n => `${n}행`).join(', ')}).`,
      suggestion: '시의 의도적 반복(후렴)이 아니라면 중복 복사 여부를 확인하세요(원문은 자동 수정하지 않음).',
      lineNumbers: consecutiveDupLines
    });
  }

  const seenStanzas = new Set<string>();
  let dupStanzaCount = 0;
  for (const st of stanzas) {
    if (st.length < 15) continue;
    if (seenStanzas.has(st)) dupStanzaCount++;
    else seenStanzas.add(st);
  }
  if (dupStanzaCount > 0) {
    issues.push({
      code: 'DUPLICATE_STANZA',
      severity: 'info',
      message: `동일한 연/문단이 ${dupStanzaCount}회 반복됩니다.`,
      suggestion: '의도적 반복 구절인지, 페이지 본문이 중복 추출되었는지 확인하세요.'
    });
  }

  // 4) 시 원문 줄바꿈 및 빈 행(연 구분) 점검
  if (opts.genre === 'poetry' && lines.length <= 1 && trimmed.length > 60) {
    issues.push({
      code: 'BLANK_LINE_ANOMALY',
      severity: 'warning',
      message: '시(poetry) 원문이지만 줄바꿈이 없는 한 줄로 되어 있습니다.',
      suggestion: '원본 시의 행·연 구분이 손실되었을 수 있습니다. 원본 출처에서 행 구분을 확인하세요.'
    });
  }
  if (/\n{4,}/.test(normalizedNewlines)) {
    issues.push({
      code: 'BLANK_LINE_ANOMALY',
      severity: 'info',
      message: '연속된 빈 행(3줄 이상)이 포함되어 있습니다.',
      suggestion: '불필요한 공백 행이 섞였는지 확인하세요(원문은 자동 변경하지 않음).'
    });
  }

  // 5) 시작·끝 부분의 페이지 번호/편집 표식 등 경계 잔여물
  const firstLine = nonEmptyLines[0]?.text || '';
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1]?.text || '';
  if (/^(?:편집|\[편집\]|목차|이전|다음|p\.\s*\d+|-\s*\d+\s*-)$/i.test(firstLine) || /^(?:편집|\[편집\]|목차|이전|다음|p\.\s*\d+|-\s*\d+\s*-)$/i.test(lastLine)) {
    issues.push({
      code: 'BOUNDARY_ARTIFACT',
      severity: 'warning',
      message: '원문 시작 또는 끝부분에 페이지 번호·편집 표식 같은 잔여 문구가 포함되어 있습니다.',
      suggestion: '원문 시작과 끝이 실제 작품 본문과 일치하는지 확인하세요.'
    });
  }

  // 6) 서로 다른 판본/번역본 혼합 의심
  const foundEditionMarkers = MIXED_EDITION_MARKERS.filter(m => m.re.test(normalizedNewlines)).map(m => m.label);
  if (foundEditionMarkers.length >= 2) {
    issues.push({
      code: 'MIXED_EDITION',
      severity: 'warning',
      message: `본문 안에 서로 다른 판본/번역본 표기(${foundEditionMarkers.join(', ')})가 함께 나타납니다.`,
      suggestion: '판본이 혼합되지 않았는지 반드시 확인하세요.'
    });
  }

  // 7) OCR 또는 문자 인코딩 오류 감지
  const badChars: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(l) || /Ã.|Â.|â€|ï»¿/.test(l)) {
      badChars.push(i + 1);
    }
  }
  if (badChars.length > 0) {
    issues.push({
      code: 'ENCODING_OR_OCR_ERROR',
      severity: 'error',
      message: `문자 깨짐(인코딩 오류) 또는 제어 문자가 감지되었습니다(${badChars.slice(0, 5).map(n => `${n}행`).join(', ')}).`,
      suggestion: 'UTF-8 인코딩 파일인지 또는 OCR 오인식이 있는지 확인하세요.',
      lineNumbers: badChars
    });
  }

  // 8) 성경 장·절 번호 연속성 추가 검증
  if (opts.bibleRef) {
    const verseNums: number[] = [];
    for (const item of nonEmptyLines) {
      const m = item.text.match(/^(\d{1,3})\s+/);
      if (m) verseNums.push(Number(m[1]));
    }
    const missing: number[] = [];
    for (let v = opts.bibleRef.startVerse; v <= opts.bibleRef.endVerse; v++) {
      if (!verseNums.includes(v)) missing.push(v);
    }
    const extra = verseNums.filter(v => v < opts.bibleRef!.startVerse || v > opts.bibleRef!.endVerse);
    if (missing.length > 0 && !issues.some(x => x.code === 'BIBLE_VERSE_MISSING')) {
      issues.push({
        code: 'BIBLE_VERSE_MISSING',
        severity: 'warning',
        message: `성경 범위(${opts.bibleRef.startVerse}~${opts.bibleRef.endVerse}절) 중 ${missing.join(', ')}절 번호가 보이지 않습니다.`
      });
    }
    if (extra.length > 0) {
      issues.push({
        code: 'BIBLE_VERSE_UNREQUESTED',
        severity: 'error',
        message: `요청 범위 밖의 절 번호(${extra.join(', ')}절)가 포함되어 있습니다.`
      });
    }
  }

  // 9) 광고·내비게이션·출처 설명 혼입
  for (const pat of CHROME_PATTERNS) {
    if (pat.re.test(normalizedNewlines)) {
      issues.push({
        code: 'CHROME_OR_AD_CONTAMINATION',
        severity: 'warning',
        message: `원문 내에 ${pat.label}가 혼입된 것으로 보입니다.`,
        suggestion: '본문 외의 웹 메뉴·출처 설명·안내 문구가 포함되었는지 확인하세요.'
      });
    }
  }

  const hasError = issues.some(i => i.severity === 'error');
  return {
    checkedAt,
    charCount: raw.length,
    lineCount: lines.length,
    stanzaCount: stanzas.length,
    preservesLineBreaks: lines.length > 1 || trimmed.length <= 60,
    issues,
    passed: !hasError
  };
}

/**
 * 두 개 이상의 독립된 신뢰 판본을 대조한다.
 * 비교 대상이 없으면 "다른 판본과 대조하지 못함"을 반환한다.
 */
export function compareEditions(
  primary: { label: string; text: string },
  secondary?: { label: string; text: string } | null
): EditionComparisonSummary {
  if (!secondary || !secondary.text.trim()) {
    return {
      compared: false,
      message: '다른 판본과 대조하지 못함'
    };
  }

  const pLines = primary.text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const sLines = secondary.text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const maxLen = Math.max(pLines.length, sLines.length);
  const diffs: EditionComparisonLineDiff[] = [];
  let sameCount = 0;
  let differentCount = 0;
  let suspectedMissingCount = 0;

  for (let i = 0; i < maxLen; i++) {
    const a = pLines[i] ?? '';
    const b = sLines[i] ?? '';
    if (a && b && a === b) {
      sameCount++;
      diffs.push({ lineIndex: i + 1, primaryLine: a, secondaryLine: b, kind: 'same' });
    } else if (!a && b) {
      suspectedMissingCount++;
      diffs.push({ lineIndex: i + 1, primaryLine: '', secondaryLine: b, kind: 'missing_in_primary' });
    } else if (a && !b) {
      suspectedMissingCount++;
      diffs.push({ lineIndex: i + 1, primaryLine: a, secondaryLine: '', kind: 'missing_in_secondary' });
    } else {
      differentCount++;
      diffs.push({ lineIndex: i + 1, primaryLine: a, secondaryLine: b, kind: 'different' });
    }
  }

  const similarityRatio = maxLen > 0 ? Math.round((sameCount / maxLen) * 100) / 100 : 1;
  const editionNotes: string[] = [];
  if (sameCount === maxLen) {
    editionNotes.push('두 판본의 행 구성과 문장이 완전히 일치합니다.');
  } else {
    if (differentCount > 0) editionNotes.push(`표기·띄어쓰기·고어 차이가 있는 행이 ${differentCount}개 있습니다.`);
    if (suspectedMissingCount > 0) editionNotes.push(`한쪽 판본에만 존재하는 행(누락 의심 포함)이 ${suspectedMissingCount}개 있습니다.`);
  }
  if (pLines.length !== sLines.length) {
    editionNotes.push(`행 수 차이: ${primary.label}(${pLines.length}행) vs ${secondary.label}(${sLines.length}행)`);
  }

  return {
    compared: true,
    message: `${primary.label} ↔ ${secondary.label} 대조 완료 (일치 ${sameCount}행, 차이 ${differentCount}행, 누락 의심 ${suspectedMissingCount}행)`,
    primaryLabel: primary.label,
    secondaryLabel: secondary.label,
    sameCount,
    differentCount,
    suspectedMissingCount,
    similarityRatio,
    editionNotes,
    diffs: diffs.slice(0, 200)
  };
}
