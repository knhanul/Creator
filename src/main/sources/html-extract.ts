/**
 * 안전한 HTML 본문 추출 및 무해화 모듈 (스크립트 실행 없음, 순수 문자열/정규식 기반).
 *
 * 원칙:
 * - 외부 HTML을 Electron Renderer에 신뢰된 마크업으로 넘기지 않고 순수 텍스트로 추출한다.
 * - <script>, <style>, <nav>, <header>, <footer>, <aside>, <form>, 광고·메뉴·편집 링크를 제거한다.
 * - 시(poem) 및 문학 작품의 줄바꿈(<br>)과 연 구분(<p>…</p>)은 그대로 보존한다.
 * - 원문의 맞춤법·띄어쓰기·고어 표기는 절대 자동 수정하지 않는다.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®'
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** 중첩 태그(div/section/nav/aside 등)를 안전하게 제거하는 도우미 */
function stripTagBlocks(html: string, tagNames: string[]): string {
  let out = html;
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    // 중첩 대응 최대 4회 반복
    for (let i = 0; i < 4; i++) {
      const next = out.replace(re, '');
      if (next === out) break;
      out = next;
    }
  }
  return out;
}

/** 특정 class 이름을 가진 div/span/table 블록 제거 (균형 카운트 기반) */
function stripBlocksByClass(html: string, classPattern: RegExp): string {
  const openTagRe = /<(div|span|table|section|nav|aside|header|footer)\b([^>]*)>/gi;
  let result = html;
  let guard = 0;
  while (guard++ < 120) {
    openTagRe.lastIndex = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = openTagRe.exec(result)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] || '';
      const clsMatch = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const cls = clsMatch ? clsMatch[1] || clsMatch[2] || '' : '';
      if (!classPattern.test(cls)) continue;

      // 균형 맞는 닫는 태그 위치 탐색
      const start = m.index;
      const tagScan = new RegExp(`<(\\/?)${tag}\\b[^>]*>`, 'gi');
      tagScan.lastIndex = start;
      let depth = 0;
      let end = -1;
      let tm: RegExpExecArray | null;
      while ((tm = tagScan.exec(result)) !== null) {
        if (tm[1] === '/') {
          depth--;
          if (depth === 0) {
            end = tagScan.lastIndex;
            break;
          }
        } else if (!tm[0].endsWith('/>')) {
          depth++;
        }
      }
      if (end > start) {
        result = result.slice(0, start) + result.slice(end);
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  return result;
}

/** HTML 조각을 줄바꿈·연 구분을 보존한 순수 텍스트로 변환 */
export function htmlFragmentToText(fragment: string): string {
  let s = fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>\s*\n?/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<\/(?:div|blockquote|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  s = decodeHtmlEntities(s);
  // Zero-width space / BOM 등 비가시 제어 문자 정리 (실제 텍스트 내용·띄어쓰기는 유지)
  s = s.replace(/[\u200B\uFEFF]/g, '');
  s = s.replace(/\r\n?/g, '\n');

  // 각 행의 끝 공백만 정리하되 행 구분과 빈 행(연 구분)은 보존
  const lines = s.split('\n').map(l => l.replace(/[ \t]+$/g, ''));
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 한국어/영어 위키문헌 MediaWiki `action=parse` HTML에서 순수 작품 원문만 추출.
 * - 머리말(wst-header), 비출력 요소(ws-noexport), 페이지번호(pagenum), 편집 링크(mw-editsection),
 *   라이선스 상자(licenseContainer) 및 라이선스 섹션 이하를 제거한다.
 * - 시(<div class="poem">)의 행·연 구분을 정확히 보존한다.
 */
export function extractWikisourceText(parsedHtml: string): string {
  let html = parsedHtml;
  html = stripTagBlocks(html, ['script', 'style', 'noscript']);

  // "라이선스" / "License" / "저작권" 헤딩 이후는 본문이 아니므로 잘라냄
  const licenseHeadingIdx = html.search(/<div[^>]*class="[^"]*mw-heading[^"]*"[^>]*>[\s\S]{0,200}?(?:라이선스|저작권|License|Licensing)/i);
  if (licenseHeadingIdx > 0) {
    html = html.slice(0, licenseHeadingIdx);
  }

  // 위키문헌 비본문 UI/크롬 제거
  html = stripBlocksByClass(
    html,
    /\b(?:ws-noexport|wst-header|licenseContainer|licenseBanner|mw-editsection|pagenum|ws-pagenum|toc|navbox|sisterproject|plainlinks|printfooter|catlinks|ws-summary)\b/i
  );

  // 시/교정 본문(.prp-pages-output 또는 .poem)이 있으면 우선적으로 활용
  const prpMatch = html.match(/<div\b[^>]*class="[^"]*prp-pages-output[^"]*"[^>]*>([\s\S]*)<\/div>/i);
  if (prpMatch) {
    html = prpMatch[1];
  }

  return htmlFragmentToText(html);
}

export interface ExtractedWebArticle {
  title: string;
  author: string;
  text: string;
  licenseUrl?: string;
  licenseName?: string;
  siteName?: string;
}

function readMeta(html: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m?.[1]?.trim()) return decodeHtmlEntities(m[1].trim());
  }
  return '';
}

/**
 * 일반 웹페이지 HTML에서 제목·저자·라이선스 단서·순수 본문 추출.
 * - <nav>, <header>, <footer>, <aside>, <script>, <style>, 메뉴/광고 영역을 제거한다.
 * - 시·문학 본문의 줄바꿈과 연 구분을 보존한다.
 */
export function extractWebArticle(html: string): ExtractedWebArticle {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const ogTitle = readMeta(html, ['og:title', 'citation_title', 'DC.title']);
  const title = decodeHtmlEntities((ogTitle || titleTag).replace(/\s+/g, ' ').trim());
  const author = readMeta(html, ['author', 'citation_author', 'DC.creator', 'article:author']);
  const siteName = readMeta(html, ['og:site_name']);

  // 명시적 Creative Commons / KOGL 라이선스 링크 감지
  const ccMatch = html.match(/https?:\/\/creativecommons\.org\/(?:licenses|publicdomain)\/[a-z0-9\-/.]+/i);
  const licenseUrl = ccMatch?.[0];
  let licenseName: string | undefined;
  if (licenseUrl) {
    if (/publicdomain\/zero/i.test(licenseUrl)) licenseName = 'CC0 1.0 (퍼블릭 도메인 기증)';
    else if (/publicdomain\/mark/i.test(licenseUrl)) licenseName = 'Public Domain Mark';
    else {
      const m = licenseUrl.match(/licenses\/([a-z-]+)\/([0-9.]+)/i);
      if (m) licenseName = `CC ${m[1].toUpperCase()} ${m[2]}`;
    }
  }

  let body = html;
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  // 비본문 태그 완전 제거
  body = stripTagBlocks(body, ['script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'button']);

  // 메뉴·사이드바·광고·댓글 등 비본문 클래스 블록 제거
  body = stripBlocksByClass(
    body,
    /\b(?:nav|navbar|navigation|menu|sidebar|side-bar|breadcrumb|footer|header|banner|cookie|popup|modal|ad|ads|advert|share|social|comment|comments|related|recommend|pagination|login|signup)\b/i
  );

  // <article> 또는 <main>이 있으면 우선 본문 영역으로 사용
  const articleMatch = body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const contentHtml = articleMatch?.[1] || mainMatch?.[1] || body;

  const text = htmlFragmentToText(contentHtml);
  return { title, author, text, licenseUrl, licenseName, siteName };
}
