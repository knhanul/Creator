/**
 * 성경 66권 목록, 번역본별 저작권 정책, 장·절 범위 및 원문 무결성 검증.
 *
 * 원칙:
 * - 개역한글판(1961)과 개역개정판(1998) 및 현대 번역본을 절대 동일 취급하지 않는다.
 * - 절 번호 유지, 요청하지 않은 절 추가 금지, 절 누락 감지, 번역본 혼합 금지, 문장 변경/해설 삽입 금지.
 */
import type { BibleReference, RightsEvidence, TextVerificationIssue } from './source-types';

export interface BibleBook {
  id: number;
  testament: 'old' | 'new';
  nameKo: string;
  abbrKo: string;
  nameEn: string;
  chapters: number;
}

export interface BibleTranslationInfo {
  id: string;
  nameKo: string;
  nameEn: string;
  year: string;
  publisher: string;
  language: 'ko' | 'en';
  autoFetchSupported: boolean;
  rightsStatus: 'PUBLIC_DOMAIN_VERIFIED' | 'RESTRICTED';
  rightsBasis: string;
  rightsEvidenceItems: string[];
  reviewItems: string[];
  officialNoticeUrl: string;
  remoteApiCode?: string;
}

export const BIBLE_TRANSLATIONS: readonly BibleTranslationInfo[] = [
  {
    id: 'KRV',
    nameKo: '개역한글판 (1961)',
    nameEn: 'Korean Revised Version (1961)',
    year: '1961',
    publisher: '대한성서공회 (초판 1961)',
    language: 'ko',
    autoFetchSupported: true,
    rightsStatus: 'PUBLIC_DOMAIN_VERIFIED',
    rightsBasis: '대한성서공회 안내 기준 1961년 발행 성경전서 개역한글판은 저작재산권 보호기간(구법 50년)이 2011년 12월 31일 종료되었습니다.',
    rightsEvidenceItems: [
      '대한성서공회 공식 안내: 성경전서 개역한글판 저작재산권 보호기간 2011-12-31 만료',
      '1998년 발행 개역개정판과는 별개의 번역본(개역한글판 원문만 사용)',
      '전자 원문 데이터 출처 및 판본 정보를 함께 기록하고 원문 문장을 변경하지 않음'
    ],
    reviewItems: [
      '전자 데이터 제공처의 출처 표기 조건 및 오탈자 여부를 최종 확인하세요.',
      '성경 원문의 동일성을 유지하고 임의의 해설·각색을 섞지 마세요.'
    ],
    officialNoticeUrl: 'https://www.bskorea.or.kr/',
    remoteApiCode: 'KRV'
  },
  {
    id: 'KJV',
    nameKo: 'King James Version (영문, 1769)',
    nameEn: 'King James Version (Public Domain)',
    year: '1611 / 1769',
    publisher: 'Public Domain',
    language: 'en',
    autoFetchSupported: true,
    rightsStatus: 'PUBLIC_DOMAIN_VERIFIED',
    rightsBasis: '1611/1769년 발행 영문 King James Version은 한국 및 미국 등에서 저작권 보호기간이 만료된 퍼블릭 도메인 원문입니다.',
    rightsEvidenceItems: [
      '1611년 초판 / 1769년 표준판 영문 원문으로 저작재산권 보호기간 만료',
      '단, 영국 내에서는 왕실 특허권(Crown Patent) 특례가 논의되므로 영국 배포 시 별도 확인 권장'
    ],
    reviewItems: [
      '영국 지역 출판·배포 예정인 경우 현지 Crown Copyright 조건을 별도 확인하세요.'
    ],
    officialNoticeUrl: 'https://www.gutenberg.org/ebooks/10',
    remoteApiCode: 'KJV'
  },
  {
    id: 'NKRV',
    nameKo: '개역개정판 (1998) — 저작권 보호 중',
    nameEn: 'New Korean Revised Version (Copyrighted)',
    year: '1998',
    publisher: '대한성서공회',
    language: 'ko',
    autoFetchSupported: false,
    rightsStatus: 'RESTRICTED',
    rightsBasis: '개역개정판(1998)은 대한성서공회가 저작권을 보유한 번역본입니다. 개역한글판과 동일하게 취급할 수 없으며 자동 가져오기를 지원하지 않습니다.',
    rightsEvidenceItems: [
      '대한성서공회 저작권 보호 대상(1998년 발행)',
      '사전 이용허락 없이 자동 수집·배포·영상 제작에 사용할 수 없음'
    ],
    reviewItems: [
      '개역개정판을 사용하려면 대한성서공회의 정식 이용허락을 확보한 뒤 직접 입력 및 권리 신고 절차를 거쳐야 합니다.'
    ],
    officialNoticeUrl: 'https://www.bskorea.or.kr/'
  },
  {
    id: 'MODERN_OTHER',
    nameKo: '기타 현대 번역본 (새번역·공동번역·쉬운성경 등) — 저작권 보호 중',
    nameEn: 'Other Modern Translations (Copyrighted)',
    year: '현대 번역',
    publisher: '각 번역 출판사·성서공회',
    language: 'ko',
    autoFetchSupported: false,
    rightsStatus: 'RESTRICTED',
    rightsBasis: '현대 성경 번역본은 각 출판사·성서공회가 저작권을 보유합니다. 자동 수집을 지원하지 않으며 반드시 개별 이용허락을 확인해야 합니다.',
    rightsEvidenceItems: [
      '현대 번역본은 별도의 2차적저작물 저작권이 존재함',
      '개역한글판과 혼동하거나 자동 이용 가능 판정할 수 없음'
    ],
    reviewItems: [
      '해당 번역본 권리자의 명시적 이용허락 범위를 확인하세요.'
    ],
    officialNoticeUrl: 'https://www.bskorea.or.kr/'
  }
] as const;

export function getBibleTranslation(id: string): BibleTranslationInfo | undefined {
  return BIBLE_TRANSLATIONS.find(t => t.id === id);
}

/** 작품 정보 화면의 번역본 선택 목록 (짧은 표시 이름). 기존 API용 BIBLE_TRANSLATIONS와 ID를 공유한다. */
export interface BibleEditionChoice {
  id: string;
  label: string;
  nameEn: string;
}

export const DEFAULT_BIBLE_TRANSLATION = 'NKRV';

export const BIBLE_EDITION_CHOICES: readonly BibleEditionChoice[] = [
  { id: 'NKRV', label: '개역개정', nameEn: 'New Korean Revised Version' },
  { id: 'KRV', label: '개역한글', nameEn: 'Korean Revised Version (1961)' },
  { id: 'RNKSV', label: '새번역', nameEn: 'Revised New Korean Standard Version' },
  { id: 'CL', label: '공동번역', nameEn: 'Common Translation' },
  { id: 'KLBT', label: '현대인의 성경', nameEn: "Today's Korean Living Bible" },
  { id: 'EASY', label: '쉬운성경', nameEn: 'Easy Korean Bible' },
  { id: 'KJV', label: 'KJV', nameEn: 'King James Version' },
  { id: 'NIV', label: 'NIV', nameEn: 'New International Version' }
];

export function getBibleEditionChoice(id: string | undefined): BibleEditionChoice {
  return BIBLE_EDITION_CHOICES.find(t => t.id === id) || BIBLE_EDITION_CHOICES[0];
}

export function normalizeBibleTranslationId(id: string | undefined): string {
  return BIBLE_EDITION_CHOICES.some(t => t.id === id) ? (id as string) : DEFAULT_BIBLE_TRANSLATION;
}

export function bibleTranslationLabel(id: string | undefined): string {
  const c = getBibleEditionChoice(id);
  return c.nameEn ? `${c.label} (${c.nameEn})` : c.label;
}

/** 기존 성경 API 선택기(BIBLE_TRANSLATIONS)에 없는 번역본은 기타 현대 번역본으로 매핑 */
export function toCatalogBibleTranslationId(id: string | undefined): string {
  const normalized = normalizeBibleTranslationId(id);
  return getBibleTranslation(normalized) ? normalized : 'MODERN_OTHER';
}

/** 구약 39권 + 신약 27권 = 66권 표준 목록 */
export const BIBLE_BOOKS: readonly BibleBook[] = [
  // 구약 (Old Testament, 1-39)
  { id: 1, testament: 'old', nameKo: '창세기', abbrKo: '창', nameEn: 'Genesis', chapters: 50 },
  { id: 2, testament: 'old', nameKo: '출애굽기', abbrKo: '출', nameEn: 'Exodus', chapters: 40 },
  { id: 3, testament: 'old', nameKo: '레위기', abbrKo: '레', nameEn: 'Leviticus', chapters: 27 },
  { id: 4, testament: 'old', nameKo: '민수기', abbrKo: '민', nameEn: 'Numbers', chapters: 36 },
  { id: 5, testament: 'old', nameKo: '신명기', abbrKo: '신', nameEn: 'Deuteronomy', chapters: 34 },
  { id: 6, testament: 'old', nameKo: '여호수아', abbrKo: '수', nameEn: 'Joshua', chapters: 24 },
  { id: 7, testament: 'old', nameKo: '사사기', abbrKo: '삿', nameEn: 'Judges', chapters: 21 },
  { id: 8, testament: 'old', nameKo: '룻기', abbrKo: '룻', nameEn: 'Ruth', chapters: 4 },
  { id: 9, testament: 'old', nameKo: '사무엘상', abbrKo: '삼상', nameEn: '1 Samuel', chapters: 31 },
  { id: 10, testament: 'old', nameKo: '사무엘하', abbrKo: '삼하', nameEn: '2 Samuel', chapters: 24 },
  { id: 11, testament: 'old', nameKo: '열왕기상', abbrKo: '왕상', nameEn: '1 Kings', chapters: 22 },
  { id: 12, testament: 'old', nameKo: '열왕기하', abbrKo: '왕하', nameEn: '2 Kings', chapters: 25 },
  { id: 13, testament: 'old', nameKo: '역대상', abbrKo: '대상', nameEn: '1 Chronicles', chapters: 29 },
  { id: 14, testament: 'old', nameKo: '역대하', abbrKo: '대하', nameEn: '2 Chronicles', chapters: 36 },
  { id: 15, testament: 'old', nameKo: '에스라', abbrKo: '스', nameEn: 'Ezra', chapters: 10 },
  { id: 16, testament: 'old', nameKo: '느헤미야', abbrKo: '느', nameEn: 'Nehemiah', chapters: 13 },
  { id: 17, testament: 'old', nameKo: '에스더', abbrKo: '에', nameEn: 'Esther', chapters: 10 },
  { id: 18, testament: 'old', nameKo: '욥기', abbrKo: '욥', nameEn: 'Job', chapters: 42 },
  { id: 19, testament: 'old', nameKo: '시편', abbrKo: '시', nameEn: 'Psalms', chapters: 150 },
  { id: 20, testament: 'old', nameKo: '잠언', abbrKo: '잠', nameEn: 'Proverbs', chapters: 31 },
  { id: 21, testament: 'old', nameKo: '전도서', abbrKo: '전', nameEn: 'Ecclesiastes', chapters: 12 },
  { id: 22, testament: 'old', nameKo: '아가', abbrKo: '아', nameEn: 'Song of Solomon', chapters: 8 },
  { id: 23, testament: 'old', nameKo: '이사야', abbrKo: '사', nameEn: 'Isaiah', chapters: 66 },
  { id: 24, testament: 'old', nameKo: '예레미야', abbrKo: '렘', nameEn: 'Jeremiah', chapters: 52 },
  { id: 25, testament: 'old', nameKo: '예레미야애가', abbrKo: '애', nameEn: 'Lamentations', chapters: 5 },
  { id: 26, testament: 'old', nameKo: '에스겔', abbrKo: '겔', nameEn: 'Ezekiel', chapters: 48 },
  { id: 27, testament: 'old', nameKo: '다니엘', abbrKo: '단', nameEn: 'Daniel', chapters: 12 },
  { id: 28, testament: 'old', nameKo: '호세아', abbrKo: '호', nameEn: 'Hosea', chapters: 14 },
  { id: 29, testament: 'old', nameKo: '요엘', abbrKo: '욜', nameEn: 'Joel', chapters: 3 },
  { id: 30, testament: 'old', nameKo: '아모스', abbrKo: '암', nameEn: 'Amos', chapters: 9 },
  { id: 31, testament: 'old', nameKo: '오바댜', abbrKo: '옵', nameEn: 'Obadiah', chapters: 1 },
  { id: 32, testament: 'old', nameKo: '요나', abbrKo: '욘', nameEn: 'Jonah', chapters: 4 },
  { id: 33, testament: 'old', nameKo: '미가', abbrKo: '미', nameEn: 'Micah', chapters: 7 },
  { id: 34, testament: 'old', nameKo: '나훔', abbrKo: '나', nameEn: 'Nahum', chapters: 3 },
  { id: 35, testament: 'old', nameKo: '하박국', abbrKo: '합', nameEn: 'Habakkuk', chapters: 3 },
  { id: 36, testament: 'old', nameKo: '스바냐', abbrKo: '습', nameEn: 'Zephaniah', chapters: 3 },
  { id: 37, testament: 'old', nameKo: '학개', abbrKo: '학', nameEn: 'Haggai', chapters: 2 },
  { id: 38, testament: 'old', nameKo: '스가랴', abbrKo: '슥', nameEn: 'Zechariah', chapters: 14 },
  { id: 39, testament: 'old', nameKo: '말라기', abbrKo: '말', nameEn: 'Malachi', chapters: 4 },
  // 신약 (New Testament, 40-66)
  { id: 40, testament: 'new', nameKo: '마태복음', abbrKo: '마', nameEn: 'Matthew', chapters: 28 },
  { id: 41, testament: 'new', nameKo: '마가복음', abbrKo: '막', nameEn: 'Mark', chapters: 16 },
  { id: 42, testament: 'new', nameKo: '누가복음', abbrKo: '눅', nameEn: 'Luke', chapters: 24 },
  { id: 43, testament: 'new', nameKo: '요한복음', abbrKo: '요', nameEn: 'John', chapters: 21 },
  { id: 44, testament: 'new', nameKo: '사도행전', abbrKo: '행', nameEn: 'Acts', chapters: 28 },
  { id: 45, testament: 'new', nameKo: '로마서', abbrKo: '롬', nameEn: 'Romans', chapters: 16 },
  { id: 46, testament: 'new', nameKo: '고린도전서', abbrKo: '고전', nameEn: '1 Corinthians', chapters: 16 },
  { id: 47, testament: 'new', nameKo: '고린도후서', abbrKo: '고후', nameEn: '2 Corinthians', chapters: 13 },
  { id: 48, testament: 'new', nameKo: '갈라디아서', abbrKo: '갈', nameEn: 'Galatians', chapters: 6 },
  { id: 49, testament: 'new', nameKo: '에베소서', abbrKo: '엡', nameEn: 'Ephesians', chapters: 6 },
  { id: 50, testament: 'new', nameKo: '빌립보서', abbrKo: '빌', nameEn: 'Philippians', chapters: 4 },
  { id: 51, testament: 'new', nameKo: '골로새서', abbrKo: '골', nameEn: 'Colossians', chapters: 4 },
  { id: 52, testament: 'new', nameKo: '데살로니가전서', abbrKo: '살전', nameEn: '1 Thessalonians', chapters: 5 },
  { id: 53, testament: 'new', nameKo: '데살로니가후서', abbrKo: '살후', nameEn: '2 Thessalonians', chapters: 3 },
  { id: 54, testament: 'new', nameKo: '디모데전서', abbrKo: '딤전', nameEn: '1 Timothy', chapters: 6 },
  { id: 55, testament: 'new', nameKo: '디모데후서', abbrKo: '딤후', nameEn: '2 Timothy', chapters: 4 },
  { id: 56, testament: 'new', nameKo: '디도서', abbrKo: '딛', nameEn: 'Titus', chapters: 3 },
  { id: 57, testament: 'new', nameKo: '빌레몬서', abbrKo: '몬', nameEn: 'Philemon', chapters: 1 },
  { id: 58, testament: 'new', nameKo: '히브리서', abbrKo: '히', nameEn: 'Hebrews', chapters: 13 },
  { id: 59, testament: 'new', nameKo: '야고보서', abbrKo: '약', nameEn: 'James', chapters: 5 },
  { id: 60, testament: 'new', nameKo: '베드로전서', abbrKo: '벧전', nameEn: '1 Peter', chapters: 5 },
  { id: 61, testament: 'new', nameKo: '베드로후서', abbrKo: '벧후', nameEn: '2 Peter', chapters: 3 },
  { id: 62, testament: 'new', nameKo: '요한일서', abbrKo: '요일', nameEn: '1 John', chapters: 5 },
  { id: 63, testament: 'new', nameKo: '요한이서', abbrKo: '요이', nameEn: '2 John', chapters: 1 },
  { id: 64, testament: 'new', nameKo: '요한삼서', abbrKo: '요삼', nameEn: '3 John', chapters: 1 },
  { id: 65, testament: 'new', nameKo: '유다서', abbrKo: '유', nameEn: 'Jude', chapters: 1 },
  { id: 66, testament: 'new', nameKo: '요한계시록', abbrKo: '계', nameEn: 'Revelation', chapters: 22 }
] as const;

export function getBibleBook(bookId: number): BibleBook | undefined {
  return BIBLE_BOOKS.find(b => b.id === bookId);
}

export function findBibleBookByName(name: string): BibleBook | undefined {
  const q = name.trim().toLowerCase();
  return BIBLE_BOOKS.find(
    b => b.nameKo === q || b.abbrKo === q || b.nameEn.toLowerCase() === q
  );
}

export interface BibleVerseRaw {
  verse: number;
  text: string;
  translationId?: string;
}

export interface BiblePassageBuildResult {
  ok: boolean;
  title: string;
  ref?: BibleReference;
  formattedText: string;
  verses: { verse: number; text: string }[];
  missingVerses: number[];
  issues: TextVerificationIssue[];
  errorMessage?: string;
}

export function formatBiblePassageTitle(book: BibleBook, chapter: number, startVerse: number, endVerse: number): string {
  const unit = book.id === 19 ? '편' : '장';
  const range = startVerse === endVerse ? `${startVerse}절` : `${startVerse}~${endVerse}절`;
  return `${book.nameKo} ${chapter}${unit} ${range}`;
}

/**
 * 성경 본문 엄격 검증·조립:
 * - 번역본 혼합 차단
 * - 요청하지 않은 절 제외 (자동 추가 금지)
 * - 절 누락 감지
 * - 절 번호 유지, 문장 임의 수정·해설 삽입 금지
 */
export function buildValidatedBiblePassage(params: {
  translationId: string;
  bookId: number;
  chapter: number;
  startVerse: number;
  endVerse: number;
  rawVerses: BibleVerseRaw[];
}): BiblePassageBuildResult {
  const translation = getBibleTranslation(params.translationId);
  const book = getBibleBook(params.bookId);
  const issues: TextVerificationIssue[] = [];

  if (!translation) {
    return { ok: false, title: '', formattedText: '', verses: [], missingVerses: [], issues, errorMessage: '지원하지 않는 성경 번역본입니다.' };
  }
  if (!book) {
    return { ok: false, title: '', formattedText: '', verses: [], missingVerses: [], issues, errorMessage: '유효하지 않은 성경 책입니다.' };
  }
  if (!Number.isInteger(params.chapter) || params.chapter < 1 || params.chapter > book.chapters) {
    return { ok: false, title: '', formattedText: '', verses: [], missingVerses: [], issues, errorMessage: `${book.nameKo}의 장 번호는 1~${book.chapters} 범위여야 합니다.` };
  }
  if (!Number.isInteger(params.startVerse) || !Number.isInteger(params.endVerse) || params.startVerse < 1 || params.endVerse < params.startVerse) {
    return { ok: false, title: '', formattedText: '', verses: [], missingVerses: [], issues, errorMessage: '시작 절과 종료 절 범위가 올바르지 않습니다.' };
  }

  // 번역본 혼합 검사
  const foreignTranslation = params.rawVerses.find(v => v.translationId && v.translationId !== params.translationId);
  if (foreignTranslation) {
    issues.push({
      code: 'BIBLE_TRANSLATION_MIXED',
      severity: 'error',
      message: `요청한 번역본(${params.translationId})과 다른 번역본(${foreignTranslation.translationId}) 절이 섞여 있어 차단했습니다.`
    });
    return {
      ok: false,
      title: formatBiblePassageTitle(book, params.chapter, params.startVerse, params.endVerse),
      formattedText: '',
      verses: [],
      missingVerses: [],
      issues,
      errorMessage: `서로 다른 성경 번역본(${params.translationId}, ${foreignTranslation.translationId})이 혼합되어 가져올 수 없습니다.`
    };
  }

  // 요청 범위 내 절만 엄격 선별 (요청하지 않은 절 추가 금지)
  const byVerse = new Map<number, string>();
  for (const v of params.rawVerses) {
    if (!Number.isInteger(v.verse)) continue;
    if (v.verse < params.startVerse || v.verse > params.endVerse) continue;
    // HTML 태그만 무해화 (원문 문장은 절대 수정하지 않음)
    const cleanText = String(v.text ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!cleanText) continue;
    if (!byVerse.has(v.verse)) byVerse.set(v.verse, cleanText);
  }

  const verses: { verse: number; text: string }[] = [];
  const missingVerses: number[] = [];
  for (let n = params.startVerse; n <= params.endVerse; n++) {
    const t = byVerse.get(n);
    if (t === undefined) missingVerses.push(n);
    else verses.push({ verse: n, text: t });
  }

  const title = formatBiblePassageTitle(book, params.chapter, params.startVerse, params.endVerse);
  const ref: BibleReference = {
    translationId: translation.id,
    translationName: translation.nameKo,
    testament: book.testament,
    bookId: book.id,
    bookName: book.nameKo,
    chapter: params.chapter,
    startVerse: params.startVerse,
    endVerse: params.endVerse
  };

  if (verses.length === 0) {
    issues.push({
      code: 'BIBLE_VERSE_MISSING',
      severity: 'error',
      message: `요청한 범위(${title})에 해당하는 절을 찾지 못했습니다.`
    });
    return { ok: false, title, ref, formattedText: '', verses: [], missingVerses, issues, errorMessage: `요청한 범위(${title})의 본문이 존재하지 않습니다. 장·절 범위를 확인해 주세요.` };
  }

  if (missingVerses.length > 0) {
    issues.push({
      code: 'BIBLE_VERSE_MISSING',
      severity: 'warning',
      message: `요청 범위(${params.startVerse}~${params.endVerse}절) 중 ${missingVerses.join(', ')}절이 누락되었습니다.`,
      suggestion: '장·절 끝 번호가 정확한지 또는 출처 데이터에 누락이 있는지 확인하세요.'
    });
  }

  // 절 번호 유지 형식: "1 여호와는 나의 목자시니..."
  const formattedText = verses.map(v => `${v.verse} ${v.text}`).join('\n');

  return {
    ok: true,
    title,
    ref,
    formattedText,
    verses,
    missingVerses,
    issues
  };
}

/** 성경 번역본별 저작권 근거 객체 생성 */
export function buildBibleRightsEvidence(translation: BibleTranslationInfo, sourceAccessNote: string): RightsEvidence {
  const isPd = translation.rightsStatus === 'PUBLIC_DOMAIN_VERIFIED';
  return {
    status: translation.rightsStatus,
    basis: translation.rightsBasis,
    evidenceItems: [...translation.rightsEvidenceItems],
    licenseName: isPd ? '퍼블릭 도메인 (저작재산권 보호기간 만료)' : '저작권 보호 대상 (이용허락 필요)',
    licenseUrl: translation.officialNoticeUrl,
    jurisdiction: translation.language === 'ko' ? '대한민국' : '국제(영국 특례 별도 확인)',
    usage: isPd
      ? {
          storage: 'allowed',
          aiAnalysis: 'conditional',
          narration: 'allowed',
          subtitles: 'allowed',
          videoCreation: 'allowed',
          publicRelease: 'allowed',
          monetization: 'conditional'
        }
      : {
          storage: 'restricted',
          aiAnalysis: 'restricted',
          narration: 'restricted',
          subtitles: 'restricted',
          videoCreation: 'restricted',
          publicRelease: 'restricted',
          monetization: 'restricted'
        },
    needsManualReview: !isPd || translation.reviewItems.length > 0,
    reviewItems: [...translation.reviewItems],
    attributionRequired: true,
    integrityRequired: true,
    sourceAccessNote,
    checkedAt: new Date().toISOString()
  };
}
