/**
 * 장르·저자·제목으로 Gemini에서 원문을 가져올 때 쓰는 프롬프트와 응답 추출.
 * 확장 프로그램은 기존 텍스트 작업(기획 분석 등)과 같은 경로로 응답을 수집한다.
 */
import type { Genre } from './types';
import { GENRES } from './workflow';

export function makeOriginalTextPrompt(input: { title: string; author?: string; genre: Genre }): string {
  const title = input.title.trim();
  const author = input.author?.trim() || '미입력';
  const genre = GENRES[input.genre] || input.genre;
  return `당신은 문학·성경 원문을 정확하게 제공하는 도우미입니다. 해설·감상·현대어 의역을 하지 말고, 요청한 작품의 원문만 제공합니다.

장르: ${genre}
제목: ${title}
저자: ${author}

규칙:
- 원문을 요약하거나 각색하거나 현대어로 바꾸지 마세요.
- 시·성경·대본은 줄바꿈과 연(문단) 구분을 그대로 유지하세요.
- 머리말, 작품 해설, 출처 설명, 번역 주석을 본문에 넣지 마세요.
- 원문 전체를 제공할 수 있으면 아래 형식으로만 답하세요.
- 원문을 제공할 수 없으면(기억에 없거나 제공할 수 없는 경우) 첫 줄에 UNAVAILABLE: 뒤에 짧은 이유를 쓰고, 원문 블록은 쓰지 마세요.
- 존재하지 않는 작품을 지어내지 마세요.

출력 형식:
<<<ORIGINAL_TEXT
(작품 원문 전체)
ORIGINAL_TEXT`;
}

const MARKER_RE = /<<<ORIGINAL_TEXT\s*\r?\n([\s\S]*?)\r?\nORIGINAL_TEXT/;
const UNAVAILABLE_RE = /^\s*UNAVAILABLE\s*:\s*(.+)$/im;

function cleanExtracted(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function extractMarked(source: string): string | null {
  const m = source.match(MARKER_RE);
  return m ? m[1] : null;
}

function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  if (UNAVAILABLE_RE.test(t)) return true;
  return /원문을\s*제공할\s*수\s*없|전문을\s*제공(?:할|하지)\s*수\s*없|제공할\s*수\s*없습니다|I\s*(?:can't|cannot|am unable to)\s+(?:provide|share|reproduce|quote)|(?:sorry|apologize).{0,40}(?:can't|cannot)\s+(?:provide|share)|copyright(?:ed)?\s+(?:material|text).{0,40}(?:can't|cannot|unable)/i.test(t);
}

function unavailableReason(sources: string[]): string | null {
  for (const s of sources) {
    const m = s.match(UNAVAILABLE_RE);
    if (m) return m[1].trim();
    if (looksLikeRefusal(s) && s.length < 800) {
      const line = s.split(/\n/).map(x => x.trim()).find(Boolean) || s.trim();
      return line.slice(0, 240);
    }
  }
  return null;
}

export type OriginalExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** Gemini 텍스트 응답(및 코드 블록)에서 원문만 골라낸다. */
export function extractOriginalText(text?: string, codeBlocks?: string[]): OriginalExtractResult {
  const raw = (text || '').trim();
  const blocks = (codeBlocks || []).map(b => String(b).trim()).filter(Boolean);
  const refused = unavailableReason([raw, ...blocks]);
  const marked = extractMarked(raw) || blocks.map(extractMarked).find((x): x is string => !!x);
  if (marked && cleanExtracted(marked)) {
    return { ok: true, text: cleanExtracted(marked) };
  }
  if (refused) {
    return { ok: false, reason: refused };
  }
  const longest = [...blocks].sort((a, b) => b.length - a.length)[0];
  // 시는 짧은 코드 블록일 수 있으므로, 블록이 있으면 짧게라도 본문으로 본다.
  if (longest && cleanExtracted(longest).length >= 2 && !looksLikeRefusal(longest)) {
    return { ok: true, text: cleanExtracted(longest) };
  }
  if (raw.length >= 20 && !looksLikeRefusal(raw)) {
    const stripped = cleanExtracted(
      raw
        .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
    );
    if (stripped.length >= 20) return { ok: true, text: stripped };
  }
  if (!raw && blocks.length === 0) {
    return { ok: false, reason: '제미나이 응답이 비어 있습니다. Gemini 탭을 확인한 뒤 다시 시도해 주세요.' };
  }
  return { ok: false, reason: '제미나이 응답에서 원문을 찾지 못했습니다. 응답을 확인한 뒤 직접 붙여넣거나 다시 시도해 주세요.' };
}

/** 파일 첨부·드래그앤드랍으로 지원하는 확장자 (점 없음, 소문자) */
export const ORIGINAL_FILE_EXTENSIONS = ['txt', 'md', 'srt', 'html', 'htm', 'docx'] as const;
export type OriginalFileExtension = (typeof ORIGINAL_FILE_EXTENSIONS)[number];

export const ORIGINAL_FILE_LABEL = 'TXT, MD, SRT, HTML, DOCX';
export const ORIGINAL_FILE_ACCEPT = ORIGINAL_FILE_EXTENSIONS.map(ext => `.${ext}`).join(',');
export const ORIGINAL_FILE_HINT = `${ORIGINAL_FILE_LABEL} 파일을 첨부하거나 여기에 끌어다 놓으세요. UTF-8 · UTF-16 · EUC-KR(CP949) 텍스트를 지원합니다. PDF는 지원하지 않습니다.`;

export function isSupportedOriginalFileName(name: string): boolean {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return (ORIGINAL_FILE_EXTENSIONS as readonly string[]).includes(ext);
}
