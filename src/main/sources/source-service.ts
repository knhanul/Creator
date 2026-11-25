/**
 * 원문 검색·가져오기·판본 비교·URL·파일·성경 통합 오케스트레이터.
 *
 * 의존성을 주입받도록 설계하여 테스트에서 MockSourceProvider로 외부 네트워크 없이
 * 검색·가져오기·권리 검증·판본 비교 전체 흐름을 자동 검증할 수 있다.
 */
import type {
  BibleFetchRequest,
  EditionComparisonSummary,
  OriginalFetchResult,
  SourceCandidate,
  SourceProviderInfo,
  SourceSearchQuery,
  SourceSearchResponse
} from '../../shared/source-types';
import { compareEditions } from '../../shared/text-verify';
import { evaluateRightsEvidence } from '../../shared/copyright';
import { createSafeHttpClient, validateSafeUrl } from './http-client';
import { createWikisourceProvider } from './wikisource-provider';
import { createGonguProvider, buildGonguOfficialSearchUrl } from './gongu-provider';
import { createGutenbergProvider } from './gutenberg-provider';
import { createBibleSourceAdapter, createBollsBibleFetcher, type BibleChapterFetcher } from './bible-provider';
import { createUrlImporter } from './url-importer';
import { importOriginalFromFilePath } from './file-importer';
import type { OriginalSourceProvider, SafeHttpClient } from './types';

export interface SourceServiceDeps {
  providers: OriginalSourceProvider[];
  bibleAdapter: ReturnType<typeof createBibleSourceAdapter>;
  urlImporter: ReturnType<typeof createUrlImporter>;
  openExternalUrl?: (url: string) => Promise<void>;
}

/** 동일 제목의 다른 작가 또는 여러 판본이 섞여 있는지 안내 문구 생성 */
function buildDisambiguationNote(candidates: SourceCandidate[]): string | undefined {
  if (candidates.length < 2) return undefined;
  const byTitle = new Map<string, SourceCandidate[]>();
  for (const c of candidates) {
    const key = c.title.trim().toLowerCase();
    const list = byTitle.get(key) || [];
    list.push(c);
    byTitle.set(key, list);
  }
  let diffAuthor = false;
  let multiEdition = false;
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    const authors = new Set(list.map(x => x.author.trim()).filter(Boolean));
    const editions = new Set(list.map(x => x.edition.trim()).filter(Boolean));
    if (authors.size >= 2) diffAuthor = true;
    if (editions.size >= 2 || list.length >= 2) multiEdition = true;
  }
  if (diffAuthor && multiEdition) {
    return '같은 제목의 서로 다른 작가 작품과 여러 판본이 함께 검색되었습니다. 작가와 판본을 확인하고 선택해 주세요.';
  }
  if (diffAuthor) {
    return '같은 제목이지만 작가가 다른 작품이 검색되었습니다. 저자를 확인해 주세요.';
  }
  if (multiEdition) {
    return '여러 판본이 발견되었습니다. 사용할 판본을 선택해 주세요.';
  }
  return undefined;
}

export function createSourceService(deps: SourceServiceDeps) {
  const providerMap = new Map(deps.providers.map(p => [p.id, p]));

  function listProviders(): SourceProviderInfo[] {
    return [
      ...deps.providers.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        kinds: p.kinds,
        autoFetchSupported: p.autoFetchSupported,
        officialUrl: p.officialUrl
      })),
      {
        id: deps.bibleAdapter.id,
        name: deps.bibleAdapter.name,
        description: '개역한글판(1961) 등 퍼블릭 도메인 성경 번역본을 장·절 단위로 검증하여 가져옵니다.',
        kinds: ['bible'],
        autoFetchSupported: true,
        officialUrl: 'https://www.bskorea.or.kr/'
      }
    ];
  }

  async function search(query: SourceSearchQuery): Promise<SourceSearchResponse> {
    const q = query.query.trim();
    const author = query.author?.trim() || '';
    if (!q && !author) {
      return { query, candidates: [], providerStatuses: [] };
    }

    const targets = query.providerIds?.length
      ? deps.providers.filter(p => query.providerIds!.includes(p.id))
      : deps.providers;

    const results = await Promise.all(
      targets.map(async provider => {
        try {
          const items = await provider.search(query);
          const gonguHint =
            provider.id === 'gongu-copyright' && items.length === 0
              ? `공유마당은 robots.txt 정책상 자동 다운로드를 지원하지 않습니다. 공식 검색 페이지(${buildGonguOfficialSearchUrl(q || author)})에서 직접 확인해 주세요.`
              : undefined;
          return {
            provider,
            items,
            ok: true,
            message: gonguHint
          };
        } catch (err) {
          return {
            provider,
            items: [] as SourceCandidate[],
            ok: false,
            message: err instanceof Error ? err.message : '검색 중 오류가 발생했습니다.'
          };
        }
      })
    );

    const candidates: SourceCandidate[] = [];
    const seenUrls = new Set<string>();
    for (const r of results) {
      for (const c of r.items) {
        const key = `${c.sourceId}::${c.workId}::${c.sourceUrl}`;
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        candidates.push({ ...c, textFetched: false });
      }
    }

    return {
      query,
      candidates,
      disambiguationNote: buildDisambiguationNote(candidates),
      providerStatuses: results.map(r => ({
        providerId: r.provider.id,
        providerName: r.provider.name,
        ok: r.ok,
        count: r.items.length,
        message: r.message
      }))
    };
  }

  async function fetchOriginal(candidate: SourceCandidate): Promise<OriginalFetchResult> {
    const provider = providerMap.get(candidate.sourceId);
    if (!provider) {
      return {
        ok: false,
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
        workId: candidate.workId,
        title: candidate.title,
        author: candidate.author,
        edition: candidate.edition,
        sourceUrl: candidate.sourceUrl,
        rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
        fetchedAt: new Date().toISOString(),
        inputMethod: 'search',
        errorCode: 'UNKNOWN_PROVIDER',
        errorMessage: `등록되지 않은 원문 제공처(${candidate.sourceId})입니다.`
      };
    }
    const result = await provider.fetchOriginal(candidate);
    // 비교 자료가 하나뿐인 기본 상태 명시
    if (result.ok && !result.comparison) {
      result.comparison = compareEditions({ label: result.edition || result.sourceName, text: result.originalText || '' }, null);
    }
    return result;
  }

  async function compare(
    primary: { label: string; text: string },
    secondary: { label: string; text: string }
  ): Promise<EditionComparisonSummary> {
    return compareEditions(primary, secondary);
  }

  async function importUrl(url: string): Promise<OriginalFetchResult> {
    const res = await deps.urlImporter.importFromUrl(url);
    if (res.ok && !res.comparison) {
      res.comparison = compareEditions({ label: res.edition || res.sourceName, text: res.originalText || '' }, null);
    }
    return res;
  }

  async function importFilePath(filePath: string): Promise<OriginalFetchResult> {
    const res = await importOriginalFromFilePath(filePath);
    if (res.ok && !res.comparison) {
      res.comparison = compareEditions({ label: res.edition || res.sourceName, text: res.originalText || '' }, null);
    }
    return res;
  }

  async function fetchBible(req: BibleFetchRequest): Promise<OriginalFetchResult> {
    const res = await deps.bibleAdapter.fetchPassage(req);
    if (res.ok && !res.comparison) {
      res.comparison = compareEditions({ label: res.edition || res.sourceName, text: res.originalText || '' }, null);
    }
    return res;
  }

  async function openExternal(rawUrl: string): Promise<{ success: boolean; message?: string }> {
    try {
      const safe = validateSafeUrl(rawUrl, { requireHttps: true });
      if (!deps.openExternalUrl) {
        return { success: false, message: '외부 브라우저 열기가 지원되지 않는 환경입니다.' };
      }
      await deps.openExternalUrl(safe.toString());
      return { success: true };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : '유효하지 않은 URL입니다.' };
    }
  }

  return {
    listProviders,
    search,
    fetchOriginal,
    compare,
    importUrl,
    importFilePath,
    fetchBible,
    openExternal
  };
}

export type SourceService = ReturnType<typeof createSourceService>;

/** 실제 운영용 기본 SourceService 생성 */
export function createDefaultSourceService(opts: {
  http?: SafeHttpClient;
  bibleFetcher?: BibleChapterFetcher;
  openExternalUrl?: (url: string) => Promise<void>;
} = {}): SourceService {
  const http = opts.http ?? createSafeHttpClient();
  const wikisourceKo = createWikisourceProvider(http, { lang: 'ko' });
  const wikisourceEn = createWikisourceProvider(http, { lang: 'en' });
  const gongu = createGonguProvider();
  const gutenberg = createGutenbergProvider(http);
  const bibleAdapter = createBibleSourceAdapter(opts.bibleFetcher ?? createBollsBibleFetcher(http));
  const urlImporter = createUrlImporter({ http, wikisourceKo, wikisourceEn });

  return createSourceService({
    providers: [wikisourceKo, gongu, gutenberg, wikisourceEn],
    bibleAdapter,
    urlImporter,
    openExternalUrl: opts.openExternalUrl
  });
}
