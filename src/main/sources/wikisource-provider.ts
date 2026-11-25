/**
 * 위키문헌(Wikisource) 공식 MediaWiki API 어댑터 (기본: ko.wikisource.org).
 *
 * - 공식 MediaWiki Action API(action=query / action=parse)만 사용
 * - {{머리말}} 템플릿에서 제목·저자·역자·발행연도·판본 정보 추출
 * - 분류/틀(PD-old-70, PD-old-100, PD-KR, CC-BY-SA 등)에서 실제 저작권 근거 파싱
 * - 번역자(역자)가 존재하면 번역저작물 별도 권리 검토(REVIEW_REQUIRED)로 처리
 * - 원문은 줄바꿈·연 구분을 그대로 보존하여 추출 (자동 교정 금지)
 */
import type {
  OriginalFetchResult,
  RightsEvidence,
  RightsReviewStatus,
  SourceCandidate,
  SourceSearchQuery
} from '../../shared/source-types';
import { evaluateRightsEvidence } from '../../shared/copyright';
import { verifyOriginalText } from '../../shared/text-verify';
import { extractWikisourceText, decodeHtmlEntities } from './html-extract';
import type { OriginalSourceProvider, SafeHttpClient } from './types';

function stripWikiMarkup(raw: string): string {
  return decodeHtmlEntities(
    raw
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/'''?/g, '')
      .trim()
  );
}

/** {{머리말 ... }} 또는 {{header ... }} 위키텍스트에서 메타데이터 추출 */
export function parseWikisourceHeader(wikitext: string): {
  title?: string;
  subtitle?: string;
  author?: string;
  translator?: string;
  year?: string;
  edition?: string;
} {
  const headerMatch = wikitext.match(/\{\{(?:머리말|header|Header)\s*([\s\S]*?)\n\}\}/i);
  if (!headerMatch) return {};
  const block = headerMatch[1];

  const readField = (names: string[]): string | undefined => {
    for (const n of names) {
      const re = new RegExp(`(?:^|\\n)[ \\t]*\\|[ \\t]*${n}[ \\t]*=[ \\t]*([^\\n}]*)`, 'i');
      const m = block.match(re);
      if (m?.[1]?.trim()) {
        const cleaned = stripWikiMarkup(m[1].trim());
        if (cleaned) return cleaned;
      }
    }
    return undefined;
  };

  return {
    title: readField(['제목', 'title']),
    subtitle: readField(['부제', 'section', '부제 다른 표기']),
    author: readField(['저자', '지은이', 'author']),
    translator: readField(['역자', '번역', 'translator']),
    year: readField(['연도', '발행연도', 'year']),
    edition: readField(['출전', '판본', 'edition', 'notes'])
  };
}

/** 위키문헌 분류·틀 목록에서 실제 라이선스/퍼블릭 도메인 근거 판독 */
export function parseWikisourceRights(params: {
  categories: string[];
  templates: string[];
  translator?: string;
  year?: string;
  lang: 'ko' | 'en';
  sourceUrl: string;
}): RightsEvidence {
  const tokens = [...params.categories, ...params.templates].map(t => t.toLowerCase());
  const evidenceItems: string[] = [];
  const isTranslation = Boolean(params.translator && params.translator.trim());
  const isForeignWork = params.lang !== 'ko';

  const hasPdOld100 = tokens.some(t => /pd-old-100|pd-old-auto-expired/.test(t));
  const hasPdOld70 = tokens.some(t => /pd-old-70|pd-old-auto|pd-kr|pd-korea|pd-old(?!-)/.test(t));
  const hasPd1923 = tokens.some(t => /pd-1923|pd-us-expired|pd-us/.test(t));
  const ccToken = tokens.find(t => /cc-by|cc0/.test(t));

  let providerEvidenceStatus: RightsReviewStatus = 'UNKNOWN';
  let licenseName: string | undefined;
  let licenseUrl: string | undefined;
  let licenseAllowsCommercial = true;
  let licenseAllowsDerivatives = true;
  let licenseRequiresAttribution = false;
  let licenseShareAlike = false;

  if (hasPdOld100) {
    providerEvidenceStatus = 'PUBLIC_DOMAIN_VERIFIED';
    licenseName = 'PD-old-100 (저작자 사후 100년 경과 퍼블릭 도메인)';
    evidenceItems.push('위키문헌 라이선스 틀/분류 확인: PD-old-100 (사후 100년 경과)');
  } else if (hasPdOld70) {
    providerEvidenceStatus = 'PUBLIC_DOMAIN_VERIFIED';
    licenseName = 'PD-old-70 / PD-KR (저작자 사후 70년 경과 퍼블릭 도메인)';
    evidenceItems.push('위키문헌 라이선스 틀/분류 확인: PD-old-70 / PD-KR');
  } else if (hasPd1923) {
    // 미국 기준 PD-1923은 한국 기준 보호기간과 다를 수 있으므로 추가 검토
    providerEvidenceStatus = 'REVIEW_REQUIRED';
    licenseName = 'PD-1923 (미국 기준 퍼블릭 도메인 — 한국 보호기간 별도 확인 필요)';
    evidenceItems.push('위키문헌 라이선스 틀 확인: PD-1923 (미국 출판 기준)');
  } else if (ccToken) {
    providerEvidenceStatus = 'LICENSE_VERIFIED';
    licenseName = ccToken.replace(/^(?:틀:|template:)/i, '').toUpperCase();
    licenseUrl = 'https://creativecommons.org/licenses/';
    licenseAllowsCommercial = !/-nc/i.test(ccToken);
    licenseAllowsDerivatives = !/-nd/i.test(ccToken);
    licenseRequiresAttribution = /-by/i.test(ccToken);
    licenseShareAlike = /-sa/i.test(ccToken);
    evidenceItems.push(`위키문헌 크리에이티브 커먼즈 틀 확인: ${licenseName}`);
  } else {
    evidenceItems.push('위키문헌 문서에서 명시적 퍼블릭 도메인/라이선스 틀을 확인하지 못했습니다.');
  }

  evidenceItems.push(`원문 확인 페이지: ${params.sourceUrl}`);

  return evaluateRightsEvidence({
    providerEvidenceStatus,
    providerEvidenceItems: evidenceItems,
    licenseName,
    licenseUrl,
    licenseAllowsCommercial,
    licenseAllowsDerivatives,
    licenseRequiresAttribution,
    licenseShareAlike,
    isTranslation,
    translatorName: params.translator,
    isForeignWork,
    jurisdiction: params.lang === 'ko' ? '대한민국 / Wikimedia' : '미국 / 국제(한국 보호기간 별도 확인)',
    sourceAccessNote: '위키문헌 공식 MediaWiki API를 통해 접근했습니다. 위키문헌 자체의 편집 기여물에는 CC BY-SA 4.0이 적용될 수 있으므로 출처 표기를 권장합니다.'
  });
}

export function createWikisourceProvider(
  http: SafeHttpClient,
  opts: { lang?: 'ko' | 'en' } = {}
): OriginalSourceProvider {
  const lang = opts.lang ?? 'ko';
  const host = `${lang}.wikisource.org`;
  const apiBase = `https://${host}/w/api.php`;
  const id = lang === 'ko' ? 'wikisource-ko' : 'wikisource-en';
  const name = lang === 'ko' ? '한국어 위키문헌 (Wikisource)' : '영어 위키문헌 (English Wikisource)';

  function pageUrl(title: string): string {
    return `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  }

  function extractEditionHint(pageTitle: string): string {
    const paren = pageTitle.match(/\(([^)]+)\)/);
    if (paren) return paren[1];
    if (pageTitle.includes('/')) return pageTitle.split('/')[0];
    return `${lang === 'ko' ? '한국어' : '영어'} 위키문헌 판본`;
  }

  function extractAuthorFromSnippet(snippet: string): string {
    const plain = decodeHtmlEntities(snippet.replace(/<[^>]+>/g, ''));
    const m = plain.match(/(?:저자|지은이|Author)\s*[:：]\s*([^\s,·(|]+)/i);
    return m?.[1]?.trim() || '';
  }

  async function search(query: SourceSearchQuery): Promise<SourceCandidate[]> {
    const terms = [query.query.trim(), query.author?.trim()].filter(Boolean).join(' ');
    if (!terms) return [];
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 15);
    const url = `${apiBase}?action=query&list=search&srnamespace=0&srlimit=${limit}&srsearch=${encodeURIComponent(terms)}&format=json`;
    const res = await http.fetchText(url, { accept: 'application/json' });
    if (!res.ok) return [];
    const json = JSON.parse(res.text) as {
      query?: { search?: { pageid: number; title: string; snippet?: string; size?: number }[] };
    };
    const items = json.query?.search || [];
    return items.map(item => {
      const cleanSnippet = decodeHtmlEntities((item.snippet || '').replace(/<[^>]+>/g, '')).trim();
      const authorHint = extractAuthorFromSnippet(item.snippet || '');
      const displayTitle = item.title.includes('/') ? item.title.split('/').pop() || item.title : item.title;
      return {
        sourceId: id,
        sourceName: name,
        workId: String(item.pageid),
        title: displayTitle,
        author: authorHint,
        edition: extractEditionHint(item.title),
        snippet: cleanSnippet,
        sourceUrl: pageUrl(item.title),
        autoFetchSupported: true,
        textFetched: false as const,
        preliminaryRightsStatus: 'REVIEW_REQUIRED' as const,
        accessNote: 'MediaWiki 공식 API로 원문과 라이선스 틀을 직접 확인할 수 있습니다.',
        meta: { pageTitle: item.title, pageId: item.pageid, lang }
      };
    });
  }

  async function fetchParsedPage(pageTitle: string) {
    const url = `${apiBase}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text|categories|templates|wikitext&redirects=1&format=json`;
    const res = await http.fetchText(url, { accept: 'application/json' });
    if (!res.ok) {
      throw new Error(`위키문헌 응답 오류 (HTTP ${res.status})`);
    }
    const json = JSON.parse(res.text) as {
      error?: { code?: string; info?: string };
      parse?: {
        title: string;
        pageid: number;
        text?: { '*': string };
        wikitext?: { '*': string };
        categories?: { '*': string }[];
        templates?: { '*': string }[];
      };
    };
    if (json.error || !json.parse) {
      throw new Error(json.error?.info || '위키문헌 문서를 찾을 수 없습니다.');
    }
    return json.parse;
  }

  async function getRightsInfo(candidate: SourceCandidate): Promise<RightsEvidence> {
    const pageTitle = String(candidate.meta?.pageTitle || candidate.title);
    const parsed = await fetchParsedPage(pageTitle);
    const header = parseWikisourceHeader(parsed.wikitext?.['*'] || '');
    const categories = (parsed.categories || []).map(c => c['*']);
    const templates = (parsed.templates || []).map(t => t['*']);
    return parseWikisourceRights({
      categories,
      templates,
      translator: header.translator || candidate.translator,
      year: header.year || candidate.publishedYear,
      lang,
      sourceUrl: pageUrl(parsed.title)
    });
  }

  async function fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult> {
    const fetchedAt = new Date().toISOString();
    const pageTitle = String(candidate.meta?.pageTitle || candidate.title);
    try {
      const parsed = await fetchParsedPage(pageTitle);
      const wikitext = parsed.wikitext?.['*'] || '';
      const html = parsed.text?.['*'] || '';
      const header = parseWikisourceHeader(wikitext);
      const categories = (parsed.categories || []).map(c => c['*']);
      const templates = (parsed.templates || []).map(t => t['*']);
      const finalUrl = pageUrl(parsed.title);

      const originalText = extractWikisourceText(html);
      const rights = parseWikisourceRights({
        categories,
        templates,
        translator: header.translator || candidate.translator,
        year: header.year || candidate.publishedYear,
        lang,
        sourceUrl: finalUrl
      });

      const resolvedTitle =
        (parsed.title.includes('/') ? parsed.title.split('/').pop() : undefined) ||
        header.title ||
        candidate.title;
      const resolvedAuthor = header.author || candidate.author || '';
      const editionParts = [
        parsed.title.includes('/') ? parsed.title.split('/')[0] : candidate.edition,
        header.edition,
        header.year ? `${header.year}년` : ''
      ].filter(Boolean);
      const resolvedEdition = Array.from(new Set(editionParts)).join(' · ') || `${name} 판본`;

      const verification = verifyOriginalText({
        text: originalText,
        genre: candidate.genreHint,
        expectedTitle: candidate.title,
        actualTitle: resolvedTitle,
        expectedAuthor: candidate.author,
        actualAuthor: resolvedAuthor
      });

      if (!originalText.trim()) {
        return {
          ok: false,
          sourceId: id,
          sourceName: name,
          workId: String(parsed.pageid),
          title: resolvedTitle,
          author: resolvedAuthor,
          translator: header.translator,
          edition: resolvedEdition,
          publishedYear: header.year,
          sourceUrl: finalUrl,
          rights,
          verification,
          fetchedAt,
          inputMethod: 'search',
          errorCode: 'EMPTY_BODY',
          errorMessage: '작품 페이지는 찾았지만 본문 텍스트가 비어 있거나 목차(하위 문서 안내) 페이지입니다. 하위 작품을 선택하거나 공식 페이지를 확인해 주세요.',
          accessInfo: {
            manualOnly: true,
            officialUrl: finalUrl,
            reason: '목차 페이지이거나 본문 텍스트를 자동 추출할 수 없는 구조입니다.'
          }
        };
      }

      return {
        ok: true,
        sourceId: id,
        sourceName: name,
        workId: String(parsed.pageid),
        title: resolvedTitle,
        author: resolvedAuthor,
        translator: header.translator,
        edition: resolvedEdition,
        publishedYear: header.year,
        sourceUrl: finalUrl,
        originalText,
        rights,
        verification,
        fetchedAt,
        inputMethod: 'search',
        meta: { pageTitle: parsed.title, pageId: parsed.pageid, categories }
      };
    } catch (err) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: candidate.workId,
        title: candidate.title,
        author: candidate.author,
        edition: candidate.edition,
        sourceUrl: candidate.sourceUrl,
        rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
        fetchedAt,
        inputMethod: 'search',
        errorCode: 'FETCH_FAILED',
        errorMessage: err instanceof Error ? err.message : '위키문헌에서 원문을 가져오지 못했습니다.'
      };
    }
  }

  return {
    id,
    name,
    description:
      lang === 'ko'
        ? '한국어 위키문헌 공식 MediaWiki API로 저작권 만료 문학 원문과 라이선스 근거를 검색·추출합니다.'
        : '영어 위키문헌 공식 MediaWiki API로 영문 원문과 라이선스 근거를 검색·추출합니다.',
    officialUrl: `https://${host}/`,
    autoFetchSupported: true,
    kinds: ['literature'],
    search,
    fetchOriginal,
    getRightsInfo
  };
}
