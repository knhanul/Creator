/**
 * Project Gutenberg Source Adapter (Gutendex 공개 메타데이터 API + gutenberg.org UTF-8 원문).
 *
 * 원칙:
 * - Project Gutenberg에 게시되었다는 이유만으로 한국 내 퍼블릭 도메인으로 자동 단정하지 않는다.
 * - 저자 사망연도와 국외 저작물/번역 여부를 검토해 근거와 함께 표시한다.
 * - Gutenberg 표준 머리말/꼬리말(*** START/END OF THE PROJECT GUTENBERG EBOOK ***)만 제거하고 작품 본문은 보존한다.
 */
import type {
  OriginalFetchResult,
  RightsEvidence,
  SourceCandidate,
  SourceSearchQuery
} from '../../shared/source-types';
import { evaluateRightsEvidence } from '../../shared/copyright';
import { verifyOriginalText } from '../../shared/text-verify';
import type { OriginalSourceProvider, SafeHttpClient } from './types';

interface GutendexPerson {
  name: string;
  birth_year?: number | null;
  death_year?: number | null;
}

interface GutendexBook {
  id: number;
  title: string;
  authors: GutendexPerson[];
  translators?: GutendexPerson[];
  languages: string[];
  copyright: boolean | null;
  formats: Record<string, string>;
}

/** Gutenberg plain text에서 라이선스 머리말/꼬리말만 제거하고 작품 본문·줄바꿈은 보존 */
export function stripGutenbergBoilerplate(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let body = normalized;
  const startMatch = body.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (startMatch && startMatch.index !== undefined) {
    body = body.slice(startMatch.index + startMatch[0].length);
  }
  const endMatch = body.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (endMatch && endMatch.index !== undefined) {
    body = body.slice(0, endMatch.index);
  }
  return body.trim();
}

function pickPlainTextFormatUrl(formats: Record<string, string>): string | undefined {
  const keys = Object.keys(formats);
  const utf8Key = keys.find(k => /text\/plain.*utf-8/i.test(k) && !formats[k].endsWith('.zip'));
  if (utf8Key) return formats[utf8Key];
  const plainKey = keys.find(k => k.startsWith('text/plain') && !formats[k].endsWith('.zip'));
  if (plainKey) return formats[plainKey];
  return undefined;
}

export function createGutenbergProvider(http: SafeHttpClient): OriginalSourceProvider {
  const id = 'project-gutenberg';
  const name = 'Project Gutenberg (영문·다국어 고전)';

  function buildRightsFromMeta(meta: {
    bookId: number;
    authors: GutendexPerson[];
    translators: GutendexPerson[];
    copyright: boolean | null;
    languages: string[];
    sourceUrl: string;
  }): RightsEvidence {
    const isJointWork = meta.authors.length > 1;
    const isTranslation = meta.translators.length > 0;
    const primaryAuthor = meta.authors[0];
    const primaryTranslator = meta.translators[0];

    const evidenceItems: string[] = [
      `Project Gutenberg 도서 ID #${meta.bookId} (${meta.sourceUrl})`,
      `Gutenberg 메타데이터 미국 저작권 표시: ${meta.copyright === false ? '미국 퍼블릭 도메인 표기(copyright=false)' : meta.copyright === true ? '저작권 보호 표기(copyright=true)' : '미표기'}`
    ];
    if (primaryAuthor) {
      evidenceItems.push(
        `저자: ${primaryAuthor.name} (사망연도: ${primaryAuthor.death_year ?? '미확인'})`
      );
    }
    if (primaryTranslator) {
      evidenceItems.push(
        `번역자: ${primaryTranslator.name} (사망연도: ${primaryTranslator.death_year ?? '미확인'})`
      );
    }

    return evaluateRightsEvidence({
      authorDeathYear: primaryAuthor?.death_year ?? null,
      translatorDeathYear: primaryTranslator?.death_year ?? null,
      translatorName: primaryTranslator?.name,
      isJointWork,
      isTranslation,
      isForeignWork: !meta.languages.includes('ko'),
      providerEvidenceStatus:
        meta.copyright === true
          ? 'RESTRICTED'
          : meta.copyright === false
          ? 'PUBLIC_DOMAIN_VERIFIED'
          : 'UNKNOWN',
      providerEvidenceItems: evidenceItems,
      licenseName: meta.copyright === false ? 'Project Gutenberg (미국 퍼블릭 도메인 표기)' : undefined,
      licenseUrl: 'https://www.gutenberg.org/policy/permission.html',
      jurisdiction: '미국 기준 게시 (대한민국 보호기간 별도 검토)',
      sourceAccessNote:
        'Project Gutenberg 원문에서 상표(Project Gutenberg) 문구를 제거한 순수 본문을 추출했습니다. 한국 및 배포 대상 국가의 보호기간을 반드시 확인하세요.'
    });
  }

  async function search(query: SourceSearchQuery): Promise<SourceCandidate[]> {
    const terms = [query.query.trim(), query.author?.trim()].filter(Boolean).join(' ');
    if (!terms) return [];
    const url = `https://gutendex.com/books?search=${encodeURIComponent(terms)}`;
    const res = await http.fetchText(url, { timeoutMs: 12_000, accept: 'application/json' });
    if (!res.ok) return [];
    const json = JSON.parse(res.text) as { results?: GutendexBook[] };
    const limit = Math.min(Math.max(query.limit ?? 6, 1), 15);
    return (json.results || []).slice(0, limit).map(book => {
      const textUrl = pickPlainTextFormatUrl(book.formats || {});
      const authorNames = (book.authors || []).map(a => a.name).join(', ');
      const translatorNames = (book.translators || []).map(t => t.name).join(', ');
      const sourceUrl = `https://www.gutenberg.org/ebooks/${book.id}`;
      return {
        sourceId: id,
        sourceName: name,
        workId: String(book.id),
        title: book.title,
        author: authorNames,
        translator: translatorNames || undefined,
        edition: `Project Gutenberg #${book.id} (${(book.languages || []).join(', ').toUpperCase() || 'UNKNOWN'})`,
        sourceUrl,
        autoFetchSupported: Boolean(textUrl),
        textFetched: false as const,
        preliminaryRightsStatus: book.copyright === true ? ('RESTRICTED' as const) : ('REVIEW_REQUIRED' as const),
        accessNote: textUrl
          ? 'UTF-8 텍스트 원문을 가져올 수 있습니다. 국외 저작물이므로 한국 보호기간을 함께 확인합니다.'
          : 'UTF-8 텍스트 파일이 없어 공식 페이지에서 직접 확인해야 합니다.',
        meta: {
          bookId: book.id,
          textUrl,
          authors: book.authors || [],
          translators: book.translators || [],
          copyright: book.copyright,
          languages: book.languages || []
        }
      };
    });
  }

  async function getRightsInfo(candidate: SourceCandidate): Promise<RightsEvidence> {
    const meta = (candidate.meta || {}) as {
      bookId?: number;
      authors?: GutendexPerson[];
      translators?: GutendexPerson[];
      copyright?: boolean | null;
      languages?: string[];
    };
    return buildRightsFromMeta({
      bookId: meta.bookId ?? (Number(candidate.workId) || 0),
      authors: meta.authors || [],
      translators: meta.translators || [],
      copyright: meta.copyright ?? null,
      languages: meta.languages || [],
      sourceUrl: candidate.sourceUrl
    });
  }

  async function fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult> {
    const fetchedAt = new Date().toISOString();
    const rights = await getRightsInfo(candidate);
    const textUrl = typeof candidate.meta?.textUrl === 'string' ? candidate.meta.textUrl : '';

    if (!textUrl) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: candidate.workId,
        title: candidate.title,
        author: candidate.author,
        translator: candidate.translator,
        edition: candidate.edition,
        sourceUrl: candidate.sourceUrl,
        rights,
        fetchedAt,
        inputMethod: 'search',
        errorCode: 'NO_PLAIN_TEXT',
        errorMessage: '이 도서는 UTF-8 일반 텍스트 형식을 제공하지 않습니다. 공식 Project Gutenberg 페이지에서 직접 확인해 주세요.',
        accessInfo: { manualOnly: true, officialUrl: candidate.sourceUrl, reason: 'UTF-8 텍스트 링크 없음' }
      };
    }

    try {
      const res = await http.fetchText(textUrl, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, accept: 'text/plain,*/*' });
      if (!res.ok) {
        throw new Error(`원문 다운로드 실패 (HTTP ${res.status})`);
      }
      const originalText = stripGutenbergBoilerplate(res.text);
      const verification = verifyOriginalText({
        text: originalText,
        genre: candidate.genreHint,
        expectedTitle: candidate.title,
        actualTitle: candidate.title,
        expectedAuthor: candidate.author,
        actualAuthor: candidate.author
      });

      return {
        ok: true,
        sourceId: id,
        sourceName: name,
        workId: candidate.workId,
        title: candidate.title,
        author: candidate.author,
        translator: candidate.translator,
        edition: candidate.edition,
        sourceUrl: candidate.sourceUrl,
        originalText,
        rights,
        verification,
        fetchedAt,
        inputMethod: 'search',
        meta: { textUrl, finalUrl: res.finalUrl }
      };
    } catch (err) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: candidate.workId,
        title: candidate.title,
        author: candidate.author,
        translator: candidate.translator,
        edition: candidate.edition,
        sourceUrl: candidate.sourceUrl,
        rights,
        fetchedAt,
        inputMethod: 'search',
        errorCode: 'FETCH_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Project Gutenberg 원문을 내려받지 못했습니다.'
      };
    }
  }

  return {
    id,
    name,
    description: 'Project Gutenberg(Gutendex)에서 고전 문학 원문을 검색하고 UTF-8 텍스트를 가져옵니다.',
    officialUrl: 'https://www.gutenberg.org/',
    autoFetchSupported: true,
    kinds: ['literature'],
    search,
    fetchOriginal,
    getRightsInfo
  };
}
