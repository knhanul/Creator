/**
 * 「Gemini로 원문 찾기」 순수 로직 (main·renderer·테스트 공용).
 * - 제목·저자로 Gemini에 원문 전문을 요청하는 프롬프트 (creator.source.v1)
 * - 응답 JSON을 기존 원문 검토 카드가 쓰는 OriginalFetchResult로 변환
 *
 * Gemini가 옮겨 적은 원문은 자동 확정하지 않습니다. 저작권은 사망연도가 Gemini가 알려준 값이므로
 * 보호기간 만료로 계산되어도 REVIEW_REQUIRED(확인 체크 필요)로 낮추고, 원문은 검토 경고를 붙입니다.
 */
import type { Genre } from './types';
import type { OriginalFetchResult, TextVerificationIssue } from './source-types';
import { GENRES } from './workflow';
import { bibleTranslationLabel, normalizeBibleTranslationId } from './bible-catalog';
import { evaluateRightsEvidence } from './copyright';
import { compareEditions, verifyOriginalText } from './text-verify';

export const SOURCE_SCHEMA = 'creator.source.v1';
export const GEMINI_SOURCE_ID = 'gemini';
export const GEMINI_SOURCE_NAME = 'Gemini 원문 찾기';

export interface SourceLookupQuery { title: string; author?: string; genre?: Genre | 'all'; bibleTranslation?: string; }

export function normalizeSourceQuery(q: SourceLookupQuery): SourceLookupQuery {
  const genre = q.genre && q.genre !== 'all' && q.genre in GENRES ? q.genre : 'all';
  const out: SourceLookupQuery = { title: String(q.title || '').trim().slice(0, 200), author: String(q.author || '').trim().slice(0, 100), genre };
  if (genre === 'bible') out.bibleTranslation = normalizeBibleTranslationId(q.bibleTranslation);
  return out;
}

export function makeSourceLookupPrompt(input: SourceLookupQuery): string {
  const q = normalizeSourceQuery(input);
  if (q.genre === 'bible') return makeBibleSourceLookupPrompt(q);
  const genreLabel = q.genre && q.genre !== 'all' ? GENRES[q.genre] : '';
  return [
    '당신은 문학 원문을 정확히 옮겨 적는 편집자입니다. 아래 작품의 원문 전문을 찾아 주세요.',
    '',
    `- 작품 제목: ${q.title}`,
    `- 저자: ${q.author || '(모름 — 제목으로 가장 널리 알려진 작품)'}`,
    ...(genreLabel ? [`- 갈래: ${genreLabel}`] : []),
    '',
    '규칙',
    '1. 가능하면 Google 검색으로 위키문헌·공유마당·국립중앙도서관 등 공개 원문을 확인한 뒤 그 원문을 그대로 옮겨 주세요.',
    '2. 원문을 한 글자도 바꾸지 마세요. 요약·발췌·현대어 풀이·맞춤법 교정·번역 금지. 처음부터 끝까지 전문을 적습니다.',
    '3. 행 바꿈은 원문 그대로, 연(문단) 사이는 빈 줄 하나로 구분합니다. 제목·저자명·설명·주석은 originalText에 넣지 않습니다.',
    '4. 같은 제목의 다른 작품과 섞지 마세요. 저자가 주어졌으면 그 저자의 작품만 적습니다.',
    '5. 원문을 확실히 알지 못하면 지어내지 말고 found를 false로, 이유를 note에 적습니다.',
    '6. 너무 길어 전문을 다 적을 수 없으면 앞에서부터 적고 truncated를 true로 표시합니다.',
    '',
    '답변은 아래 형식의 JSON 코드 블록 하나만 출력하세요. 문자열 안의 줄바꿈은 \\n 으로 적습니다.',
    '```json',
    '{',
    `  "schema": "${SOURCE_SCHEMA}",`,
    '  "found": true,',
    '  "title": "작품 제목",',
    '  "author": "저자",',
    '  "translator": "",',
    '  "edition": "수록 시집·판본 (예: 『님의 침묵』, 회동서관, 1926)",',
    '  "publishedYear": "1926",',
    '  "authorDeathYear": 1944,',
    '  "isTranslation": false,',
    '  "isForeignWork": false,',
    '  "sourceUrl": "원문을 확인한 공개 페이지 https 주소 (없으면 빈 문자열)",',
    '  "truncated": false,',
    '  "note": "",',
    '  "originalText": "1행\\n2행\\n\\n2연 1행"',
    '}',
    '```'
  ].join('\n');
}


function makeBibleSourceLookupPrompt(q: SourceLookupQuery): string {
  const translation = bibleTranslationLabel(q.bibleTranslation);
  return [
    '당신은 성경 본문을 정확히 옮겨 적는 편집자입니다. 아래 범위의 성경 본문을 지정한 번역본 그대로 찾아 주세요.',
    '',
    `- 본문: ${q.title}`,
    `- 번역본: ${translation}`,
    '- 갈래: 성경',
    '',
    '규칙',
    '1. 반드시 위에서 지정한 번역본의 본문만 옮겨 적으세요. 다른 번역본과 섞거나 임의로 번역하지 마세요.',
    '2. 원문을 한 글자도 바꾸지 마세요. 요약·발췌·해설·현대어 풀이·맞춤법 교정·절 추가·절 생략 금지. 지정한 범위의 처음부터 끝까지 적습니다.',
    '3. 절 번호를 유지하세요. 각 절은 새 줄로 시작하고, 절 번호와 본문을 함께 적습니다.',
    '4. 제목·번역본 이름·설명·주석은 originalText에 넣지 않습니다.',
    '5. 본문을 확실히 알지 못하면 지어내지 말고 found를 false로, 이유를 note에 적습니다.',
    '6. 너무 길어 전문을 다 적을 수 없으면 앞에서부터 적고 truncated를 true로 표시합니다.',
    '',
    '답변은 아래 형식의 JSON 코드 블록 하나만 출력하세요. 문자열 안의 줄바꿈은 \\n 으로 적습니다.',
    '```json',
    '{',
    `  "schema": "${SOURCE_SCHEMA}",`,
    '  "found": true,',
    '  "title": "본문 제목 (예: 시편 23편 1~6절)",',
    '  "author": "",',
    '  "translator": "번역본 이름",',
    '  "edition": "번역본 이름",',
    '  "publishedYear": "",',
    '  "authorDeathYear": null,',
    '  "isTranslation": true,',
    '  "isForeignWork": false,',
    '  "sourceUrl": "원문을 확인한 공개 페이지 https 주소 (없으면 빈 문자열)",',
    '  "truncated": false,',
    '  "note": "",',
    '  "originalText": "1 본문 첫째 절\\n2 본문 둘째 절"',
    '}',
    '```'
  ].join('\n');
}

/** Gemini가 문자열 안에 줄바꿈을 그대로 넣은 JSON도 읽도록, 따옴표 안의 제어 문자를 이스케이프 */
function escapeControlCharsInStrings(src: string): string {
  let out = ''; let quote = false; let esc = false;
  for (const c of src) {
    if (quote) {
      if (esc) { esc = false; out += c; continue; }
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"') { quote = false; out += c; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') continue;
      if (c === '\t') { out += '\\t'; continue; }
      out += c; continue;
    }
    if (c === '"') quote = true;
    out += c;
  }
  return out;
}

function parseObject(text: string): Record<string, unknown> | null {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const slice = body.slice(first, last + 1);
  for (const s of [slice, escapeControlCharsInStrings(slice)]) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* next */ }
  }
  return null;
}

/** 코드 블록(schema 표기 우선) → 전체 텍스트 순으로 creator.source.v1 객체를 찾음 */
export function extractSourceJson(text: string | undefined, codeBlocks: string[] | undefined): Record<string, unknown> | null {
  const blocks = (codeBlocks || []).filter(b => b.includes('{'));
  const ordered = [...blocks.filter(b => b.includes(SOURCE_SCHEMA)).reverse(), ...blocks.slice().reverse(), text || ''];
  let fallback: Record<string, unknown> | null = null;
  for (const c of ordered) {
    const o = parseObject(c);
    if (!o) continue;
    if (o.schema === SOURCE_SCHEMA) return o;
    if (!fallback && typeof o.originalText === 'string') fallback = o;
  }
  return fallback;
}

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const year = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseInt(s(v), 10);
  return Number.isInteger(n) && n > 500 && n <= new Date().getFullYear() ? n : null;
};

/** 원문 텍스트 정리: 줄 끝 공백·앞뒤 빈 줄만 정리하고 내용은 바꾸지 않음 */
function tidyText(t: string): string {
  return t.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Gemini 응답 → 원문 검토 카드용 결과 */
export function sourceResultFromGemini(
  job: { resultText?: string; codeBlocks?: string[]; completedAt?: string },
  query: SourceLookupQuery
): OriginalFetchResult {
  const q = normalizeSourceQuery(query);
  const fetchedAt = job.completedAt || new Date().toISOString();
  const base = {
    sourceId: GEMINI_SOURCE_ID,
    sourceName: GEMINI_SOURCE_NAME,
    workId: `${q.title}::${q.author || ''}`,
    fetchedAt,
    inputMethod: 'search' as const
  };
  const o = extractSourceJson(job.resultText, job.codeBlocks);
  if (!o) {
    return {
      ...base, ok: false, title: q.title, author: q.author || '', edition: '', sourceUrl: '',
      rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
      errorCode: 'INVALID_JSON',
      errorMessage: 'Gemini 응답에서 원문 JSON을 찾지 못했습니다. 다시 찾거나 Gemini 화면의 답변을 직접 붙여넣어 주세요.'
    };
  }
  const title = s(o.title) || q.title;
  const author = s(o.author) || q.author || '';
  const translator = s(o.translator) || undefined;
  const edition = s(o.edition) || 'Gemini가 찾은 원문';
  const publishedYear = s(o.publishedYear) || undefined;
  const rawUrl = s(o.sourceUrl);
  const sourceUrl = /^https:\/\/[^\s]+$/i.test(rawUrl) ? rawUrl : '';
  const text = tidyText(s(o.originalText));
  const note = s(o.note);

  if (o.found === false || !text) {
    return {
      ...base, ok: false, title, author, translator, edition, sourceUrl,
      rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
      errorCode: 'NOT_FOUND',
      errorMessage: `Gemini가 이 작품의 원문을 확실히 찾지 못했습니다.${note ? ` (${note})` : ''} 제목·저자를 확인하거나 URL·파일로 가져와 주세요.`
    };
  }

  const authorDeathYear = year(o.authorDeathYear);
  const isTranslation = o.isTranslation === true || !!translator;
  const isForeignWork = o.isForeignWork === true;
  const evidence = [
    `Gemini가 찾아 옮겨 적은 원문 (${new Date(fetchedAt).toLocaleString('ko-KR')})`,
    ...(sourceUrl ? [`Gemini가 밝힌 확인 출처: ${sourceUrl}`] : ['Gemini가 출처 URL을 밝히지 않았습니다.']),
    ...(authorDeathYear ? [`저자 사망연도 ${authorDeathYear}년은 Gemini가 알려준 값입니다.`] : [])
  ];
  let rights = evaluateRightsEvidence({
    providerEvidenceStatus: 'REVIEW_REQUIRED',
    providerEvidenceItems: evidence,
    authorDeathYear,
    isTranslation,
    isForeignWork,
    translatorName: translator,
    sourceAccessNote: 'AI가 찾은 원문이므로 판본·저작권을 직접 확인해야 합니다.'
  });
  // AI가 알려준 사망연도만으로 '검증됨'으로 두지 않음 → 확인 체크 후 확정
  if (rights.status === 'PUBLIC_DOMAIN_VERIFIED') {
    rights = {
      ...rights,
      status: 'REVIEW_REQUIRED',
      basis: `Gemini가 알려준 저자 사망연도(${authorDeathYear}년) 기준으로는 보호기간이 지난 것으로 계산됩니다. 사망연도와 판본을 확인해 주세요.`,
      needsManualReview: true,
      reviewItems: [...rights.reviewItems, '저자 사망연도와 수록 판본이 맞는지 직접 확인하세요(AI가 알려준 값).']
    };
  }

  const extraIssues: TextVerificationIssue[] = [{
    code: 'MIXED_EDITION',
    severity: 'warning',
    message: 'Gemini가 옮겨 적은 원문입니다. 글자·행·연이 원본과 같은지 출처 판본과 대조해 확인해 주세요.',
    suggestion: sourceUrl ? '「출처 열기」로 원본 페이지를 열어 비교할 수 있습니다.' : undefined
  }];
  if (o.truncated === true) {
    extraIssues.push({ code: 'POSSIBLE_TRUNCATION', severity: 'error', message: 'Gemini가 원문이 길어 일부만 적었다고 표시했습니다.', suggestion: '나머지는 URL·파일로 가져오거나 직접 붙여넣어 주세요.' });
  }
  if (note) extraIssues.push({ code: 'FILE_EXTRACTION_NOTICE', severity: 'info', message: `Gemini 메모: ${note}` });

  const verification = verifyOriginalText({
    text,
    genre: q.genre && q.genre !== 'all' ? q.genre : undefined,
    expectedTitle: q.title,
    actualTitle: title,
    expectedAuthor: q.author || undefined,
    actualAuthor: author,
    extraIssues
  });

  return {
    ...base, ok: true, title, author, translator, edition, publishedYear, sourceUrl,
    originalText: text, rights, verification,
    comparison: compareEditions({ label: edition, text }, null),
    meta: { truncated: o.truncated === true }
  };
}
