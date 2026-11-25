/**
 * 성경 전용 Source Adapter (일반 문학 검색 어댑터와 분리).
 *
 * 지원 정책:
 * - 개역한글판 (KRV, 1961): 저작재산권 보호기간 만료(2011.12.31, 대한성서공회 안내) → 공개 성경 데이터 API(bolls.life/get-text/KRV)에서 가져와 엄격 검증
 * - King James Version (KJV, 1769): 퍼블릭 도메인 영문 원문 지원
 * - 개역개정판(NKRV) 및 기타 현대 번역본: 저작권 보호 중 → 절대 개역한글판과 동일 취급하지 않으며 자동 가져오기 차단(RESTRICTED)
 *
 * 엄격 검증 규칙:
 * - 절 번호 유지, 장·절 범위 정확 검증, 요청하지 않은 절 추가 금지, 절 누락 감지, 번역본 혼합 금지, 문장 변경·해설 삽입 금지.
 */
import type { BibleFetchRequest, OriginalFetchResult } from '../../shared/source-types';
import {
  buildBibleRightsEvidence,
  buildValidatedBiblePassage,
  formatBiblePassageTitle,
  getBibleBook,
  getBibleTranslation,
  type BibleVerseRaw
} from '../../shared/bible-catalog';
import { verifyOriginalText } from '../../shared/text-verify';
import type { SafeHttpClient } from './types';

export interface BibleChapterFetcher {
  fetchChapter(translationCode: string, bookId: number, chapter: number): Promise<{
    verses: BibleVerseRaw[];
    sourceUrl: string;
    sourceNote: string;
  }>;
}

export function createBollsBibleFetcher(http: SafeHttpClient): BibleChapterFetcher {
  return {
    async fetchChapter(translationCode: string, bookId: number, chapter: number) {
      const url = `https://bolls.life/get-text/${encodeURIComponent(translationCode)}/${bookId}/${chapter}/`;
      const res = await http.fetchText(url, { timeoutMs: 12_000, accept: 'application/json' });
      if (!res.ok) {
        throw new Error(`성경 본문 제공 서버 응답 오류 (HTTP ${res.status})`);
      }
      const raw = JSON.parse(res.text) as Array<{ verse?: number; text?: string; translation?: string }>;
      if (!Array.isArray(raw)) {
        throw new Error('성경 본문 응답 형식이 올바르지 않습니다.');
      }
      const verses: BibleVerseRaw[] = raw.map(item => ({
        verse: Number(item.verse),
        text: String(item.text ?? ''),
        translationId: item.translation || translationCode
      }));
      return {
        verses,
        sourceUrl: url,
        sourceNote: `공개 성경 텍스트 API(bolls.life, 역본 코드 ${translationCode})에서 조회함. 원문 동일성 및 판본 오탈자를 최종 확인하세요.`
      };
    }
  };
}

export function createBibleSourceAdapter(fetcher: BibleChapterFetcher) {
  const id = 'bible-source';
  const name = '성경 원문 가져오기 (전용 어댑터)';

  async function fetchPassage(req: BibleFetchRequest): Promise<OriginalFetchResult> {
    const fetchedAt = new Date().toISOString();
    const translation = getBibleTranslation(req.translationId);
    const book = getBibleBook(req.bookId);

    if (!translation) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: `bible:${req.translationId}`,
        title: '',
        author: '성경',
        edition: req.translationId,
        sourceUrl: '',
        rights: buildBibleRightsEvidence(
          getBibleTranslation('MODERN_OTHER')!,
          '알 수 없는 번역본입니다.'
        ),
        fetchedAt,
        inputMethod: 'bible',
        errorCode: 'UNSUPPORTED_TRANSLATION',
        errorMessage: '지원하지 않는 성경 번역본입니다.'
      };
    }

    const title = book
      ? formatBiblePassageTitle(book, req.chapter, req.startVerse, req.endVerse)
      : `성경 ${req.bookId}권 ${req.chapter}장`;

    // 개역개정판 등 저작권 보호 번역본은 절대 개역한글판과 동일 취급하지 않고 차단
    if (!translation.autoFetchSupported || translation.rightsStatus === 'RESTRICTED' || !translation.remoteApiCode) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: `bible:${translation.id}:${req.bookId}:${req.chapter}:${req.startVerse}-${req.endVerse}`,
        title,
        author: book ? `성경 (${book.nameKo})` : '성경',
        edition: translation.nameKo,
        sourceUrl: translation.officialNoticeUrl,
        rights: buildBibleRightsEvidence(
          translation,
          '저작권 보호 대상 성경 번역본이므로 자동 가져오기를 차단했습니다.'
        ),
        fetchedAt,
        inputMethod: 'bible',
        errorCode: 'RIGHTS_RESTRICTED',
        errorMessage: `${translation.nameKo}은(는) 저작권 보호 대상 번역본입니다. 개역한글판과 동일하게 취급할 수 없으며 자동 가져오기를 지원하지 않습니다. 개역한글판을 선택하거나 정식 이용허락 확보 후 직접 입력해 주세요.`,
        accessInfo: {
          manualOnly: true,
          officialUrl: translation.officialNoticeUrl,
          reason: '대한성서공회 또는 해당 출판사의 저작권 보호 번역본'
        }
      };
    }

    if (!book) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: `bible:${translation.id}:invalid`,
        title,
        author: '성경',
        edition: translation.nameKo,
        sourceUrl: translation.officialNoticeUrl,
        rights: buildBibleRightsEvidence(translation, '유효하지 않은 책 번호'),
        fetchedAt,
        inputMethod: 'bible',
        errorCode: 'INVALID_BOOK',
        errorMessage: '올바른 성경 책을 선택해 주세요.'
      };
    }

    try {
      const fetched = await fetcher.fetchChapter(translation.remoteApiCode, book.id, req.chapter);
      const built = buildValidatedBiblePassage({
        translationId: translation.id,
        bookId: book.id,
        chapter: req.chapter,
        startVerse: req.startVerse,
        endVerse: req.endVerse,
        rawVerses: fetched.verses
      });

      const rights = buildBibleRightsEvidence(translation, fetched.sourceNote);

      if (!built.ok || !built.ref) {
        return {
          ok: false,
          sourceId: id,
          sourceName: name,
          workId: `bible:${translation.id}:${book.id}:${req.chapter}:${req.startVerse}-${req.endVerse}`,
          title: built.title || title,
          author: `성경 (${book.nameKo})`,
          edition: translation.nameKo,
          sourceUrl: fetched.sourceUrl,
          rights,
          verification: verifyOriginalText({
            text: built.formattedText,
            genre: 'bible',
            bibleRef: built.ref,
            extraIssues: built.issues
          }),
          fetchedAt,
          inputMethod: 'bible',
          errorCode: built.issues[0]?.code || 'BIBLE_VALIDATION_FAILED',
          errorMessage: built.errorMessage || '성경 본문 검증에 실패했습니다.'
        };
      }

      const verification = verifyOriginalText({
        text: built.formattedText,
        genre: 'bible',
        expectedTitle: built.title,
        actualTitle: built.title,
        bibleRef: built.ref,
        extraIssues: built.issues
      });

      return {
        ok: true,
        sourceId: id,
        sourceName: name,
        workId: `bible:${translation.id}:${book.id}:${req.chapter}:${req.startVerse}-${req.endVerse}`,
        title: built.title,
        author: `성경 (${book.nameKo})`,
        edition: translation.nameKo,
        publishedYear: translation.year,
        sourceUrl: fetched.sourceUrl,
        originalText: built.formattedText,
        rights,
        verification,
        bibleRef: built.ref,
        fetchedAt,
        inputMethod: 'bible',
        meta: {
          translationId: translation.id,
          verseCount: built.verses.length,
          missingVerses: built.missingVerses
        }
      };
    } catch (err) {
      return {
        ok: false,
        sourceId: id,
        sourceName: name,
        workId: `bible:${translation.id}:${book.id}:${req.chapter}:${req.startVerse}-${req.endVerse}`,
        title,
        author: `성경 (${book.nameKo})`,
        edition: translation.nameKo,
        sourceUrl: translation.officialNoticeUrl,
        rights: buildBibleRightsEvidence(translation, '네트워크 조회 실패'),
        fetchedAt,
        inputMethod: 'bible',
        errorCode: 'NETWORK_ERROR',
        errorMessage: err instanceof Error ? err.message : '성경 본문을 가져오는 중 오류가 발생했습니다.'
      };
    }
  }

  return {
    id,
    name,
    fetchPassage
  };
}
