import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  FileUp,
  GitCompare,
  Globe,
  Info,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import type {
  BibleReference,
  EditionComparisonSummary,
  OriginalFetchResult,
  OriginalSourceMeta,
  RightsEvidence,
  SourceCandidate,
  SourceSearchResponse
} from '../../shared/source-types';
import type { Genre } from '../../shared/types';
import { GENRES } from '../../shared/workflow';
import {
  ALLOWANCE_LABELS,
  RIGHTS_STATUS_META,
  USAGE_LABELS,
  applyUserRightsDeclaration,
  canApproveOriginalRights
} from '../../shared/copyright';
import {
  BIBLE_BOOKS,
  BIBLE_TRANSLATIONS,
  getBibleBook,
  getBibleTranslation
} from '../../shared/bible-catalog';
import { Button, Field, Tag } from './UI';

export type SourceTab = 'search' | 'bible' | 'url' | 'file';

export interface ApprovedOriginalPayload {
  title: string;
  author: string;
  source: string;
  sourceUrl: string;
  originalText: string;
  genre?: Genre;
  meta: Omit<OriginalSourceMeta, 'approvedAt' | 'sha256' | 'version'>;
}

interface OriginalSourcePanelProps {
  defaultGenre?: Genre;
  initialQuery?: string;
  initialAuthor?: string;
  /** false를 돌려주면(사용자가 덮어쓰기를 취소) 검토 화면을 그대로 둔다 */
  onApprove: (payload: ApprovedOriginalPayload) => boolean | void;
  onSwitchManual?: () => void;
  /** 닫기 버튼 이름 (기본: 직접 입력으로 전환) */
  switchLabel?: string;
  flash?: (text: string, type?: 'info' | 'success' | 'error') => void;
  compact?: boolean;
  /** 보여 줄 가져오기 방식 (기본: 전부). 하나뿐이면 탭 줄을 숨긴다 */
  tabs?: SourceTab[];
  /** 성경 범위 처음 값 (이미 확정한 범위가 있으면 그 값) */
  initialBible?: { translationId: string; testament: 'old' | 'new'; bookId: number; chapter: number; startVerse: number; endVerse: number };
  /** 확정한 뒤 검토 카드를 닫고 처음 상태로 (입력 칸 자리에 붙박이로 쓸 때) */
  resetAfterApprove?: boolean;
  /** 열자마자 처음 검색어로 한 번 검색 */
  autoSearch?: boolean;
}

const ALL_TABS: SourceTab[] = ['search', 'bible', 'url', 'file'];
const TAB_META: Record<SourceTab, { label: string; title: string; icon: typeof Search }> = {
  search: { label: '작품 검색', title: '작품 검색', icon: Search },
  bible: { label: '성경 본문', title: '성경 본문 범위', icon: BookOpen },
  url: { label: 'URL에서 가져오기', title: 'URL에서 가져오기', icon: Globe },
  file: { label: '파일 가져오기', title: '파일 가져오기', icon: FileUp }
};

type UiStatus =
  | 'idle'
  | 'searching'
  | 'found'
  | 'fetching'
  | 'ready'
  | 'rights_check'
  | 'text_review'
  | 'approved';

const UI_STATUS_LABEL: Record<UiStatus, { label: string; tone: 'muted' | 'accent' | 'success' | 'warning' }> = {
  idle: { label: '검색 대기', tone: 'muted' },
  searching: { label: '검색 중', tone: 'accent' },
  found: { label: '작품 발견', tone: 'accent' },
  fetching: { label: '원문 확인 중', tone: 'accent' },
  ready: { label: '원문 가져오기 가능', tone: 'success' },
  rights_check: { label: '이용 조건 확인 필요', tone: 'warning' },
  text_review: { label: '원문 검토 필요', tone: 'warning' },
  approved: { label: '확정 완료', tone: 'success' }
};

function computeReviewStatus(res: OriginalFetchResult): UiStatus {
  if (!res.ok || !res.originalText) return 'rights_check';
  if (
    res.rights.status === 'UNKNOWN' ||
    res.rights.status === 'REVIEW_REQUIRED' ||
    res.rights.status === 'RESTRICTED'
  ) {
    return 'rights_check';
  }
  if (res.verification && res.verification.issues.length > 0) return 'text_review';
  return 'ready';
}

export function OriginalSourcePanel({
  defaultGenre = 'poetry',
  initialQuery = '',
  initialAuthor = '',
  onApprove,
  onSwitchManual,
  switchLabel = '직접 입력으로 전환',
  flash,
  compact = false,
  tabs = ALL_TABS,
  initialBible,
  resetAfterApprove = false,
  autoSearch = false
}: OriginalSourcePanelProps) {
  const [tab, setTab] = useState<SourceTab>(
    tabs.includes(defaultGenre === 'bible' ? 'bible' : 'search') ? (defaultGenre === 'bible' ? 'bible' : 'search') : tabs[0]
  );
  const [status, setStatus] = useState<UiStatus>('idle');

  // 1) 작품 검색 상태
  const [queryText, setQueryText] = useState(initialQuery);
  const [authorQuery, setAuthorQuery] = useState(initialAuthor);
  const [genreFilter, setGenreFilter] = useState<Genre | 'all'>(defaultGenre === 'bible' ? 'all' : defaultGenre);
  const [searchResult, setSearchResult] = useState<SourceSearchResponse | null>(null);
  const [searchError, setSearchError] = useState('');

  // 2) 성경 전용 상태
  const [translationId, setTranslationId] = useState(initialBible?.translationId ?? 'KRV');
  const [testament, setTestament] = useState<'old' | 'new'>(initialBible?.testament ?? 'old');
  const [bookId, setBookId] = useState(initialBible?.bookId ?? 19); // 시편 기본
  const [chapter, setChapter] = useState(initialBible?.chapter ?? 23);
  const [startVerse, setStartVerse] = useState(initialBible?.startVerse ?? 1);
  const [endVerse, setEndVerse] = useState(initialBible?.endVerse ?? 6);

  // 3) URL 입력 상태
  const [urlInput, setUrlInput] = useState('');

  // 4) 가져온 원문 검토·비교·승인 상태
  const [fetched, setFetched] = useState<OriginalFetchResult | null>(null);
  const [rightsDraft, setRightsDraft] = useState<RightsEvidence | null>(null);
  const [comparison, setComparison] = useState<EditionComparisonSummary | null>(null);
  const [comparing, setComparing] = useState(false);
  const [declarationNote, setDeclarationNote] = useState('');
  const [reviewChecked, setReviewChecked] = useState(false);

  const selectedBook = useMemo(() => getBibleBook(bookId) || BIBLE_BOOKS[0], [bookId]);
  const filteredBooks = useMemo(() => BIBLE_BOOKS.filter(b => b.testament === testament), [testament]);
  const selectedTranslation = useMemo(() => getBibleTranslation(translationId) || BIBLE_TRANSLATIONS[0], [translationId]);

  const activeRights = rightsDraft || fetched?.rights || null;

  const openExternal = async (url: string) => {
    const r = await window.studio.sources.openExternal(url);
    if (!r.success && flash) flash(r.message || '외부 링크를 열 수 없습니다.', 'error');
  };

  const applyFetchedResult = (res: OriginalFetchResult) => {
    setFetched(res);
    setRightsDraft(res.rights);
    setComparison(res.comparison || { compared: false, message: '다른 판본과 대조하지 못함' });
    setDeclarationNote('');
    setReviewChecked(false);
    setStatus(computeReviewStatus(res));
  };

  const handleSearch = async () => {
    if (!queryText.trim() && !authorQuery.trim()) {
      setSearchError('작품 제목 또는 작가명을 입력해 주세요.');
      return;
    }
    setSearchError('');
    setStatus('searching');
    try {
      const res = await window.studio.sources.search({
        query: queryText.trim(),
        author: authorQuery.trim() || undefined,
        genre: genreFilter
      });
      setSearchResult(res);
      setStatus(res.candidates.length > 0 ? 'found' : 'idle');
      if (res.candidates.length === 0) {
        setSearchError('검색 결과가 없습니다. 제목 또는 작가명을 확인해 주세요. 공유마당 공식 검색이나 직접 입력을 이용할 수 있습니다.');
      }
    } catch (err) {
      setStatus('idle');
      setSearchError(err instanceof Error ? err.message : '검색 중 오류가 발생했습니다.');
    }
  };

  const handleFetchCandidate = async (candidate: SourceCandidate) => {
    setStatus('fetching');
    try {
      const res = await window.studio.sources.fetchOriginal(candidate);
      applyFetchedResult(res);
      if (!res.ok && flash) {
        flash(res.errorMessage || '원문을 자동으로 가져올 수 없습니다.', 'info');
      }
    } catch (err) {
      setStatus('found');
      if (flash) flash(err instanceof Error ? err.message : '원문을 가져오지 못했습니다.', 'error');
    }
  };

  const handleCompareWithCandidate = async (candidate: SourceCandidate) => {
    if (!fetched?.ok || !fetched.originalText) return;
    setComparing(true);
    try {
      const second = await window.studio.sources.fetchOriginal(candidate);
      if (!second.ok || !second.originalText) {
        if (flash) flash('대조할 두 번째 판본의 원문을 가져오지 못했습니다.', 'error');
        return;
      }
      const diff = await window.studio.sources.compare(
        { label: `${fetched.sourceName} (${fetched.edition})`, text: fetched.originalText },
        { label: `${second.sourceName} (${second.edition})`, text: second.originalText }
      );
      setComparison(diff);
      if (flash) flash('두 판본을 대조했습니다.', 'success');
    } catch (err) {
      if (flash) flash(err instanceof Error ? err.message : '판본 비교 중 오류가 발생했습니다.', 'error');
    } finally {
      setComparing(false);
    }
  };

  const handleFetchBible = async () => {
    setStatus('fetching');
    try {
      const res = await window.studio.sources.fetchBible({
        translationId,
        bookId,
        chapter,
        startVerse,
        endVerse
      });
      applyFetchedResult(res);
      if (!res.ok && flash) flash(res.errorMessage || '성경 본문을 가져오지 못했습니다.', 'error');
    } catch (err) {
      setStatus('idle');
      if (flash) flash(err instanceof Error ? err.message : '성경 본문 조회 실패', 'error');
    }
  };

  const handleImportUrl = async () => {
    if (!urlInput.trim()) {
      if (flash) flash('가져올 원문 페이지의 HTTPS URL을 입력해 주세요.', 'error');
      return;
    }
    setStatus('fetching');
    try {
      const res = await window.studio.sources.importUrl(urlInput.trim());
      applyFetchedResult(res);
      if (!res.ok && flash) flash(res.errorMessage || 'URL에서 원문을 가져오지 못했습니다.', 'error');
    } catch (err) {
      setStatus('idle');
      if (flash) flash(err instanceof Error ? err.message : 'URL 가져오기 오류', 'error');
    }
  };

  const handleImportFile = async () => {
    setStatus('fetching');
    try {
      const res = await window.studio.sources.importFile();
      if (!res) {
        setStatus(fetched ? computeReviewStatus(fetched) : 'idle');
        return;
      }
      applyFetchedResult(res);
      if (!res.ok && flash) flash(res.errorMessage || '파일을 불러오지 못했습니다.', 'error');
    } catch (err) {
      setStatus('idle');
      if (flash) flash(err instanceof Error ? err.message : '파일 가져오기 오류', 'error');
    }
  };

  const handleDeclareUserRights = () => {
    if (!activeRights) return;
    try {
      const updated = applyUserRightsDeclaration(activeRights, declarationNote);
      setRightsDraft(updated);
      setStatus(fetched?.verification?.issues.length ? 'text_review' : 'ready');
      if (flash) flash('사용자 직접 권리 신고가 기록되었습니다(시스템 검증과 별도 표시).', 'info');
    } catch (err) {
      if (flash) flash(err instanceof Error ? err.message : '신고 내용을 입력해 주세요.', 'error');
    }
  };

  const approvalCheck = canApproveOriginalRights(activeRights || undefined, {
    allowReviewRequiredWithAck: reviewChecked
  });

  const handleConfirmApproval = () => {
    if (!fetched?.ok || !fetched.originalText || !activeRights) return;
    if (!approvalCheck.allowed) {
      if (flash) flash(approvalCheck.reason || '저작권 확인이 필요합니다.', 'error');
      return;
    }
    const sourceLabel = [fetched.sourceName, fetched.edition].filter(Boolean).join(' · ');
    const genreResolved: Genre | undefined =
      fetched.inputMethod === 'bible'
        ? 'bible'
        : genreFilter !== 'all'
        ? genreFilter
        : undefined;

    const accepted = onApprove({
      title: fetched.title || queryText.trim() || '제목 없는 작품',
      author: fetched.author || authorQuery.trim(),
      source: sourceLabel,
      sourceUrl: fetched.sourceUrl,
      originalText: fetched.originalText,
      genre: genreResolved,
      meta: {
        inputMethod: fetched.inputMethod,
        providerId: fetched.sourceId,
        providerName: fetched.sourceName,
        workId: fetched.workId,
        title: fetched.title,
        author: fetched.author,
        translator: fetched.translator,
        edition: fetched.edition,
        publishedYear: fetched.publishedYear,
        sourceUrl: fetched.sourceUrl,
        fetchedAt: fetched.fetchedAt,
        rights: activeRights,
        bibleRef: fetched.bibleRef as BibleReference | undefined,
        verification: fetched.verification,
        comparison: comparison || fetched.comparison
      }
    });
    if (accepted === false) return;
    if (resetAfterApprove) {
      setFetched(null);
      setRightsDraft(null);
      setComparison(null);
      setStatus('idle');
      return;
    }
    setStatus('approved');
  };

  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fetched) return;
    setTimeout(() => {
      const el = reviewRef.current;
      if (!el) return;
      // 작품 정보 화면 안의 펼침 영역이면 그 영역만 스크롤 (화면 전체가 밀리지 않게)
      const box = el.closest<HTMLElement>('.finder-inline, .bible-inline');
      if (box) box.scrollBy({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8, behavior: 'smooth' });
      else el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  }, [fetched]);
  const autoSearched = useRef(false);
  useEffect(() => {
    if (!autoSearch || autoSearched.current || tab !== 'search') return;
    autoSearched.current = true;
    if (queryText.trim() || authorQuery.trim()) void handleSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusMeta = status === 'idle' && tab === 'bible' ? { label: '범위를 고르세요', tone: 'muted' as const } : UI_STATUS_LABEL[status];
  const gonguSearchUrl = `https://gongu.copyright.or.kr/gongu/search/search/list.do?searchWord=${encodeURIComponent(
    (queryText || authorQuery).trim()
  )}`;

  return (
    <div className={`source-panel ${compact ? 'is-compact' : ''}`}>
      <div className="source-panel-head">
        {tabs.length > 1 ? (
          <div className="source-tabs" role="tablist" aria-label="원문 가져오기 방식">
            {tabs.map(t => {
              const Icon = TAB_META[t].icon;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`source-tab ${tab === t ? 'active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  <Icon size={14} /> {TAB_META[t].label}
                </button>
              );
            })}
          </div>
        ) : (
          <strong className="source-single-title">{TAB_META[tab].title}</strong>
        )}
        <div className="source-status-right">
          <Tag tone={statusMeta.tone}>
            {(status === 'searching' || status === 'fetching') && <Loader2 size={12} className="spin" />}
            {statusMeta.label}
          </Tag>
          {onSwitchManual && (
            <Button type="button" size="sm" kind="ghost" onClick={onSwitchManual}>
              {switchLabel}
            </Button>
          )}
        </div>
      </div>

      {/* ① 작품 검색 */}
      {tab === 'search' && (
        <div className="source-tab-body">
          <div className="source-search-bar">
            <input
              value={queryText}
              onChange={e => setQueryText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSearch();
                }
              }}
              placeholder="작품 제목 입력 (예: 서시, 진달래꽃, 날개, Pride and Prejudice)"
              aria-label="작품 제목 검색"
            />
            <input
              value={authorQuery}
              onChange={e => setAuthorQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSearch();
                }
              }}
              placeholder="작가명 (선택 · 예: 윤동주, 김소월)"
              aria-label="작가명 검색"
              className="source-author-input"
            />
            <select
              value={genreFilter}
              onChange={e => setGenreFilter(e.target.value as Genre | 'all')}
              aria-label="콘텐츠 유형 필터"
              className="source-genre-select"
            >
              <option value="all">전체 유형</option>
              {Object.entries(GENRES)
                .filter(([k]) => k !== 'bible')
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
            <Button type="button" onClick={() => void handleSearch()} disabled={status === 'searching'}>
              <Search size={15} /> 검색
            </Button>
          </div>

          <div className="source-provider-bar">
            <span>연동 제공처: 위키문헌(한국어·영어) · Project Gutenberg · 공유마당(공식 페이지 연계)</span>
            <Button
              type="button"
              size="sm"
              kind="outline"
              onClick={() => void openExternal(gonguSearchUrl)}
            >
              <ExternalLink size={13} /> 공유마당 공식 사이트에서 검색
            </Button>
          </div>

          {searchError && (
            <div className="source-alert tone-warning">
              <AlertTriangle size={15} />
              <span>{searchError}</span>
            </div>
          )}

          {searchResult?.disambiguationNote && (
            <div className="source-alert tone-info">
              <Info size={15} />
              <span>{searchResult.disambiguationNote}</span>
            </div>
          )}

          {searchResult && searchResult.candidates.length > 0 && (
            <div className="candidate-list">
              {searchResult.candidates.map(c => {
                const isSelected = fetched?.workId === c.workId && fetched?.sourceId === c.sourceId;
                const prelim = RIGHTS_STATUS_META[c.preliminaryRightsStatus];
                return (
                  <article key={`${c.sourceId}:${c.workId}`} className={`candidate-card ${isSelected ? 'selected' : ''}`}>
                    <div className="candidate-main">
                      <div className="candidate-tags">
                        <Tag tone="accent">{c.sourceName}</Tag>
                        <Tag tone={prelim.tone}>{prelim.shortLabel}</Tag>
                        <Tag tone="muted">{c.autoFetchSupported ? '원문 가져오기 가능' : '공식 페이지 확인'}</Tag>
                      </div>
                      <h4>
                        {c.title}
                        {c.author && <span className="candidate-author"> · {c.author}</span>}
                      </h4>
                      <div className="candidate-meta">
                        <span>판본: {c.edition}</span>
                        {c.translator && <span> · 번역: {c.translator}</span>}
                      </div>
                      {c.snippet && <p className="candidate-snippet">{c.snippet}</p>}
                    </div>
                    <div className="candidate-actions">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleFetchCandidate(c)}
                        disabled={status === 'fetching'}
                      >
                        <FileText size={14} /> {c.autoFetchSupported ? '원문 가져오기' : '조건 확인'}
                      </Button>
                      {fetched?.ok && !isSelected && c.autoFetchSupported && (
                        <Button
                          type="button"
                          size="sm"
                          kind="secondary"
                          onClick={() => void handleCompareWithCandidate(c)}
                          disabled={comparing}
                        >
                          <GitCompare size={14} /> 판본 대조
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        kind="ghost"
                        onClick={() => void openExternal(c.sourceUrl)}
                      >
                        <ExternalLink size={13} /> 출처 열기
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ② 성경 전용 가져오기 */}
      {tab === 'bible' && (
        <div className="source-tab-body">
          <div className="bible-grid">
            <Field label="성경 번역본">
              <select value={translationId} onChange={e => setTranslationId(e.target.value)}>
                {BIBLE_TRANSLATIONS.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.nameKo}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="구약 / 신약">
              <select
                value={testament}
                onChange={e => {
                  const nextTestament = e.target.value as 'old' | 'new';
                  setTestament(nextTestament);
                  const firstBook = BIBLE_BOOKS.find(b => b.testament === nextTestament);
                  if (firstBook) {
                    setBookId(firstBook.id);
                    setChapter(1);
                    setStartVerse(1);
                    setEndVerse(6);
                  }
                }}
              >
                <option value="old">구약 (39권)</option>
                <option value="new">신약 (27권)</option>
              </select>
            </Field>
            <Field label="책">
              <select
                value={bookId}
                onChange={e => {
                  const id = Number(e.target.value);
                  setBookId(id);
                  setChapter(1);
                }}
              >
                {filteredBooks.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.nameKo} ({b.chapters}{b.id === 19 ? '편' : '장'})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={selectedBook.id === 19 ? '편(장)' : '장'}>
              <input
                type="number"
                min={1}
                max={selectedBook.chapters}
                value={chapter}
                onChange={e => setChapter(Math.min(selectedBook.chapters, Math.max(1, Number(e.target.value) || 1)))}
              />
            </Field>
            <Field label="시작 절">
              <input
                type="number"
                min={1}
                max={176}
                value={startVerse}
                onChange={e => {
                  const v = Math.max(1, Number(e.target.value) || 1);
                  setStartVerse(v);
                  if (endVerse < v) setEndVerse(v);
                }}
              />
            </Field>
            <Field label="종료 절">
              <input
                type="number"
                min={startVerse}
                max={176}
                value={endVerse}
                onChange={e => setEndVerse(Math.max(startVerse, Number(e.target.value) || startVerse))}
              />
            </Field>
          </div>

          <div
            className={`source-alert ${
              selectedTranslation.rightsStatus === 'PUBLIC_DOMAIN_VERIFIED' ? 'tone-info' : 'tone-warning'
            }`}
          >
            {selectedTranslation.rightsStatus === 'PUBLIC_DOMAIN_VERIFIED' ? (
              <ShieldCheck size={15} />
            ) : (
              <ShieldAlert size={15} />
            )}
            <div>
              <strong>{selectedTranslation.nameKo}</strong> — {selectedTranslation.rightsBasis}
            </div>
          </div>

          <div className="bible-actions">
            <Button
              type="button"
              onClick={() => void handleFetchBible()}
              disabled={status === 'fetching'}
            >
              <BookOpen size={15} /> 성경 본문 가져오기
            </Button>
            <Button
              type="button"
              size="sm"
              kind="outline"
              onClick={() => {
                setTranslationId('KRV');
                setTestament('old');
                setBookId(19);
                setChapter(23);
                setStartVerse(1);
                setEndVerse(6);
              }}
            >
              예시: 시편 23편 1~6절
            </Button>
            <Button
              type="button"
              size="sm"
              kind="outline"
              onClick={() => {
                setTranslationId('KRV');
                setTestament('new');
                setBookId(46);
                setChapter(13);
                setStartVerse(1);
                setEndVerse(13);
              }}
            >
              예시: 고린도전서 13장 1~13절
            </Button>
          </div>
        </div>
      )}

      {/* ③ URL에서 가져오기 */}
      {tab === 'url' && (
        <div className="source-tab-body">
          <div className="source-search-bar">
            <input
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleImportUrl();
                }
              }}
              placeholder="https://ko.wikisource.org/wiki/... 또는 공개 원문 페이지 URL"
              aria-label="원문 제공 페이지 URL"
            />
            <Button type="button" onClick={() => void handleImportUrl()} disabled={status === 'fetching'}>
              <Globe size={15} /> 원문 추출
            </Button>
          </div>
          <p className="source-hint">
            HTTPS 우선 · 사설 IP/로컬 주소 차단 · robots.txt 준수 · HTML 스크립트/메뉴 제거 후 순수 텍스트로 추출합니다. 일반 웹페이지의 저작권은 자동으로 이용 가능 판정하지 않습니다.
          </p>
        </div>
      )}

      {/* ④ 파일에서 가져오기 */}
      {tab === 'file' && (
        <div className="source-tab-body">
          <div className="file-import-box">
            <div>
              <strong>TXT · UTF-8 텍스트 또는 DOCX 파일에서 원문 불러오기</strong>
              <p>
                UTF-8 / UTF-16 / EUC-KR 텍스트 파일과 Word(DOCX) 본문 추출을 지원합니다. PDF는 다단·OCR 오류 위험 때문에 자동 추출을 비활성화했습니다.
              </p>
            </div>
            <Button type="button" onClick={() => void handleImportFile()} disabled={status === 'fetching'}>
              <FileUp size={15} /> 파일 선택
            </Button>
          </div>
        </div>
      )}

      {/* 가져온 결과 검토 및 기준 원문 확정 카드 */}
      {fetched && (
        <div className="source-review-card" ref={reviewRef}>
          <div className="source-review-head">
            <div>
              <div className="eyebrow">ORIGINAL SOURCE REVIEW</div>
              <h3>{fetched.title || '제목 미확인'}</h3>
              <div className="source-review-meta">
                <span>저자: <b>{fetched.author || '미확인'}</b></span>
                {fetched.translator && <span> · 번역자: <b>{fetched.translator}</b></span>}
                <span> · 출처: <b>{fetched.sourceName}</b></span>
                <span> · 판본: <b>{fetched.edition}</b></span>
                {fetched.publishedYear && <span> · 발행: <b>{fetched.publishedYear}</b></span>}
              </div>
              {fetched.sourceUrl && (
                <button
                  type="button"
                  className="source-url-link"
                  onClick={() => void openExternal(fetched.sourceUrl)}
                >
                  <ExternalLink size={12} /> {fetched.sourceUrl}
                </button>
              )}
            </div>
            {activeRights && (
              <Tag tone={RIGHTS_STATUS_META[activeRights.status].tone}>
                {RIGHTS_STATUS_META[activeRights.status].label}
              </Tag>
            )}
          </div>

          {/* 가져오기 실패 또는 공식 페이지 전용 안내 */}
          {!fetched.ok && (
            <div className="source-alert tone-warning">
              <ShieldAlert size={16} />
              <div className="source-alert-body">
                <strong>{fetched.errorMessage || '작품 자료는 찾았지만 원문을 자동으로 가져올 수 없습니다.'}</strong>
                {fetched.accessInfo?.officialUrl && (
                  <div className="source-alert-actions">
                    <Button
                      type="button"
                      size="sm"
                      kind="outline"
                      onClick={() => void openExternal(fetched.accessInfo!.officialUrl)}
                    >
                      <ExternalLink size={13} /> 공식 자료 페이지 열기
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 저작권 검토 결과 및 용도별 범위 */}
          {activeRights && (
            <div className="rights-box">
              <div className="rights-box-head">
                <strong>저작권·이용허락 검토 결과</strong>
                <span className="micro">{activeRights.status}</span>
              </div>
              <p className="rights-basis">{activeRights.basis}</p>

              {activeRights.evidenceItems.length > 0 && (
                <ul className="rights-evidence-list">
                  {activeRights.evidenceItems.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              )}

              <div className="usage-grid">
                {(Object.keys(USAGE_LABELS) as Array<keyof typeof USAGE_LABELS>).map(key => {
                  const allowance = activeRights.usage[key];
                  const meta = ALLOWANCE_LABELS[allowance];
                  return (
                    <div key={key} className="usage-pill">
                      <span>{USAGE_LABELS[key]}</span>
                      <Tag tone={meta.tone}>{meta.label}</Tag>
                    </div>
                  );
                })}
              </div>

              {activeRights.reviewItems.length > 0 && (
                <div className="rights-review-items">
                  <strong>검증이 필요한 항목</strong>
                  <ul>
                    {activeRights.reviewItems.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 시스템 검증 미충족 시 사용자 직접 권리 신고 영역 */}
              {(activeRights.status === 'UNKNOWN' ||
                activeRights.status === 'REVIEW_REQUIRED' ||
                activeRights.status === 'RESTRICTED') &&
                fetched.ok && (
                  <div className="user-declare-box">
                    <strong>사용자 권리 직접 신고 (시스템 검증과 구분됨)</strong>
                    <p>
                      직접 저작권을 보유하거나 권리자로부터 이용허락을 확보한 경우에만 근거를 기록해 신고하세요.
                      {activeRights.status === 'REVIEW_REQUIRED' &&
                        ' 또는 위 검토 항목을 직접 확인했다면 아래 확인 체크로 진행할 수 있습니다.'}
                    </p>
                    <div className="user-declare-row">
                      <input
                        value={declarationNote}
                        onChange={e => setDeclarationNote(e.target.value)}
                        placeholder="예: 저자 사망연도 및 한국 보호기간 만료 직접 확인 / 권리자 서면 허락 확보"
                      />
                      <Button
                        type="button"
                        size="sm"
                        kind="secondary"
                        onClick={handleDeclareUserRights}
                        disabled={!declarationNote.trim()}
                      >
                        권리 직접 신고
                      </Button>
                    </div>
                    {activeRights.status === 'REVIEW_REQUIRED' && (
                      <label className="review-ack-check">
                        <input
                          type="checkbox"
                          checked={reviewChecked}
                          onChange={e => setReviewChecked(e.target.checked)}
                        />
                        <span>위 저작권 검토 항목과 판본·출처 조건을 직접 확인했습니다.</span>
                      </label>
                    )}
                  </div>
                )}
            </div>
          )}

          {/* 원문 정확성 검증 리포트 */}
          {fetched.ok && fetched.verification && (
            <div className="verify-box">
              <div className="rights-box-head">
                <strong>원문 정확성 검증</strong>
                <span className="muted-text">
                  {fetched.verification.charCount.toLocaleString()}자 · {fetched.verification.lineCount}행 ·{' '}
                  {fetched.verification.stanzaCount}연/문단 (자동 수정 없음)
                </span>
              </div>
              {fetched.verification.issues.length === 0 ? (
                <div className="verify-ok">
                  <CheckCircle2 size={14} /> 인코딩·누락·메뉴 혼입·중복 이상이 감지되지 않았습니다.
                </div>
              ) : (
                <ul className="verify-issues">
                  {fetched.verification.issues.map((iss, idx) => (
                    <li key={idx} className={`sev-${iss.severity}`}>
                      <b>[{iss.severity === 'error' ? '오류' : iss.severity === 'warning' ? '주의' : '참고'}]</b>{' '}
                      {iss.message}
                      {iss.suggestion && <small> — {iss.suggestion}</small>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 판본 대조 결과 */}
          {fetched.ok && comparison && (
            <div className="compare-box">
              <div className="rights-box-head">
                <strong>
                  <GitCompare size={14} /> 판본 대조
                </strong>
                <Tag tone={comparison.compared ? 'accent' : 'muted'}>
                  {comparison.compared ? `일치율 ${Math.round((comparison.similarityRatio ?? 0) * 100)}%` : '단일 판본'}
                </Tag>
              </div>
              <p className="muted-text">{comparison.message}</p>
              {comparison.compared && comparison.editionNotes && (
                <ul className="rights-evidence-list">
                  {comparison.editionNotes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {comparison.compared && comparison.diffs && comparison.diffs.some(d => d.kind !== 'same') && (
                <details className="compare-details">
                  <summary>차이 있는 행 보기 ({comparison.diffs.filter(d => d.kind !== 'same').length}건)</summary>
                  <div className="compare-diff-list">
                    {comparison.diffs
                      .filter(d => d.kind !== 'same')
                      .slice(0, 40)
                      .map(d => (
                        <div key={d.lineIndex} className="compare-diff-row">
                          <span className="micro">{d.lineIndex}행</span>
                          <div>
                            <div className="diff-a">기준: {d.primaryLine || '(없음)'}</div>
                            <div className="diff-b">대조: {d.secondaryLine || '(없음)'}</div>
                          </div>
                        </div>
                      ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* 원문 전체 미리보기 (시 줄바꿈·연 구분 보존) */}
          {fetched.ok && fetched.originalText && (
            <div className="original-preview-wrap">
              <div className="rights-box-head">
                <strong>원문 전체 미리보기 (줄바꿈·연 구분 원형 보존)</strong>
                <span className="muted-text">확정 후에는 AI가 임의로 수정하지 않도록 보호됩니다</span>
              </div>
              <pre className="original-preview-text">{fetched.originalText}</pre>
            </div>
          )}

          {/* 확정 버튼 */}
          {fetched.ok && fetched.originalText && (
            <div className="source-approve-bar">
              <div className="source-approve-note">
                {approvalCheck.allowed ? (
                  <span>
                    <CheckCircle2 size={14} /> 원문과 출처·저작권 검토를 확인했습니다. AI 기획 시작 시 확정 원문이 외부 Gemini로 전송됩니다.
                  </span>
                ) : (
                  <span className="warn-text">
                    <ShieldAlert size={14} /> {approvalCheck.reason}
                  </span>
                )}
              </div>
              <Button type="button" onClick={handleConfirmApproval} disabled={!approvalCheck.allowed}>
                <Check size={16} /> 이 원문을 기준 원문으로 확정
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
