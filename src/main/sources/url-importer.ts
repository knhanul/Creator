/**
 * URL에서 원문 가져오기 모듈.
 *
 * 보안·권리 원칙:
 * - URL 형식/프로토콜(HTTPS 우선)/사설 IP/localhost/리다이렉트/robots.txt/크기·시간 제한 검증
 * - 허용된 제공처(ko.wikisource.org, en.wikisource.org, gutenberg.org)는 전용 파서로 정확히 추출
 * - gongu.copyright.or.kr 다운로드 경로 등 robots.txt 차단 경로는 절대 우회하지 않음
 * - 일반 웹사이트는 안전하게 HTML 메뉴·광고·스크립트를 제거한 뒤 순수 텍스트로 추출하며,
 *   저작권 근거가 불분명하면 절대 PUBLIC_DOMAIN_VERIFIED로 판정하지 않고 UNKNOWN / REVIEW_REQUIRED로 표시한다.
 */
import type { OriginalFetchResult } from '../../shared/source-types';
import { evaluateRightsEvidence } from '../../shared/copyright';
import { verifyOriginalText } from '../../shared/text-verify';
import { extractWebArticle } from './html-extract';
import { SourceNetworkError, validateSafeUrl } from './http-client';
import { stripGutenbergBoilerplate } from './gutenberg-provider';
import type { OriginalSourceProvider, SafeHttpClient } from './types';

/** 명시적으로 차단하거나 지원하지 않는 로그인/폐쇄형/동영상 플랫폼 도메인 */
const UNSUPPORTED_HOST_RE = /(?:^|\.)(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|tiktok\.com|netflix\.com|ridibooks\.com|millie\.co\.kr|kyobobook\.co\.kr)$/i;

export function createUrlImporter(deps: {
  http: SafeHttpClient;
  wikisourceKo: OriginalSourceProvider;
  wikisourceEn: OriginalSourceProvider;
}) {
  async function importFromUrl(rawUrl: string): Promise<OriginalFetchResult> {
    const fetchedAt = new Date().toISOString();
    let parsed: URL;
    try {
      parsed = validateSafeUrl(rawUrl, { requireHttps: false });
    } catch (err) {
      const code = err instanceof SourceNetworkError ? err.code : 'INVALID_URL';
      const msg = err instanceof Error ? err.message : '올바른 URL이 아닙니다.';
      return {
        ok: false,
        sourceId: 'url-import',
        sourceName: 'URL에서 가져오기',
        workId: rawUrl,
        title: '',
        author: '',
        edition: 'URL 가져오기',
        sourceUrl: rawUrl,
        rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
        fetchedAt,
        inputMethod: 'url',
        errorCode: code,
        errorMessage: msg
      };
    }

    const host = parsed.hostname.toLowerCase();

    if (UNSUPPORTED_HOST_RE.test(host)) {
      return {
        ok: false,
        sourceId: 'url-import',
        sourceName: 'URL에서 가져오기',
        workId: parsed.toString(),
        title: '',
        author: '',
        edition: host,
        sourceUrl: parsed.toString(),
        rights: evaluateRightsEvidence({
          providerEvidenceStatus: 'RESTRICTED',
          providerEvidenceItems: [`미지원 또는 유료·폐쇄형 사이트(${host})는 자동 원문 추출을 지원하지 않습니다.`]
        }),
        fetchedAt,
        inputMethod: 'url',
        errorCode: 'UNSUPPORTED_SITE',
        errorMessage: `지원하지 않는 사이트(${host})입니다. 인증이 필요하거나 유료·폐쇄형 플랫폼의 원문은 자동으로 가져오지 않습니다.`
      };
    }

    // 1) 한국어/영어 위키문헌 URL이면 공식 MediaWiki API로 위임 (더 정확한 저작권·판본·시 행 구분 확보)
    if ((host === 'ko.wikisource.org' || host === 'en.wikisource.org') && parsed.pathname.startsWith('/wiki/')) {
      const pageTitle = decodeURIComponent(parsed.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
      const provider = host === 'ko.wikisource.org' ? deps.wikisourceKo : deps.wikisourceEn;
      const result = await provider.fetchOriginal({
        sourceId: provider.id,
        sourceName: provider.name,
        workId: pageTitle,
        title: pageTitle.includes('/') ? pageTitle.split('/').pop() || pageTitle : pageTitle,
        author: '',
        edition: host,
        sourceUrl: parsed.toString(),
        autoFetchSupported: true,
        textFetched: false,
        preliminaryRightsStatus: 'REVIEW_REQUIRED',
        meta: { pageTitle, lang: host.startsWith('ko.') ? 'ko' : 'en' }
      });
      return { ...result, inputMethod: 'url' };
    }

    // 2) robots.txt 준수 확인 + 안전 HTTP 요청
    try {
      const res = await deps.http.fetchText(parsed.toString(), {
        checkRobots: true,
        timeoutMs: 12_000,
        maxBytes: 5 * 1024 * 1024
      });

      if (!res.ok) {
        return {
          ok: false,
          sourceId: 'url-import',
          sourceName: `URL (${host})`,
          workId: res.finalUrl,
          title: '',
          author: '',
          edition: host,
          sourceUrl: res.finalUrl,
          rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
          fetchedAt,
          inputMethod: 'url',
          errorCode: `HTTP_${res.status}`,
          errorMessage: `페이지에 접근하지 못했습니다(HTTP ${res.status}). 로그인이 필요하거나 접근이 제한된 페이지일 수 있습니다.`
        };
      }

      const ct = res.contentType.toLowerCase();
      // 일반 텍스트(.txt) 처리
      if (ct.includes('text/plain') || parsed.pathname.toLowerCase().endsWith('.txt')) {
        const isGutenberg = host.endsWith('gutenberg.org');
        const originalText = isGutenberg ? stripGutenbergBoilerplate(res.text) : res.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
        const verification = verifyOriginalText({ text: originalText });
        const rights = evaluateRightsEvidence({
          providerEvidenceStatus: isGutenberg ? 'REVIEW_REQUIRED' : 'UNKNOWN',
          providerEvidenceItems: [
            `직접 URL에서 텍스트 파일 조회: ${res.finalUrl}`,
            ...(isGutenberg ? ['Project Gutenberg 텍스트 파일 — 한국 내 저작권 보호기간을 별도 확인하세요.'] : ['텍스트 파일만으로는 저작권 상태를 자동 확정할 수 없습니다.'])
          ],
          isForeignWork: isGutenberg,
          sourceAccessNote: 'robots.txt 확인 후 HTTPS/HTTP로 가져온 일반 텍스트입니다.'
        });
        return {
          ok: Boolean(originalText.trim()),
          sourceId: 'url-import',
          sourceName: `URL (${host})`,
          workId: res.finalUrl,
          title: decodeURIComponent(parsed.pathname.split('/').pop() || host).replace(/\.txt$/i, ''),
          author: '',
          edition: `${host} 텍스트`,
          sourceUrl: res.finalUrl,
          originalText: originalText || undefined,
          rights,
          verification,
          fetchedAt,
          inputMethod: 'url',
          errorCode: originalText.trim() ? undefined : 'EMPTY_BODY',
          errorMessage: originalText.trim() ? undefined : '가져온 텍스트가 비어 있습니다.'
        };
      }

      if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
        return {
          ok: false,
          sourceId: 'url-import',
          sourceName: `URL (${host})`,
          workId: res.finalUrl,
          title: '',
          author: '',
          edition: host,
          sourceUrl: res.finalUrl,
          rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
          fetchedAt,
          inputMethod: 'url',
          errorCode: 'UNSUPPORTED_CONTENT_TYPE',
          errorMessage: `지원하지 않는 콘텐츠 형식(${ct || '알 수 없음'})입니다. HTML 웹페이지 또는 UTF-8 텍스트 URL만 지원합니다.`
        };
      }

      const extracted = extractWebArticle(res.text);
      const verification = verifyOriginalText({ text: extracted.text });

      // 명시적 CC 라이선스 링크가 있는 경우에만 LICENSE_VERIFIED 후보로 검토 (단, 여전히 수동 검토 권장)
      const hasCc = Boolean(extracted.licenseName && extracted.licenseUrl);
      const rights = evaluateRightsEvidence({
        providerEvidenceStatus: hasCc ? 'LICENSE_VERIFIED' : 'UNKNOWN',
        providerEvidenceItems: [
          `웹페이지 URL에서 추출: ${res.finalUrl}`,
          ...(hasCc
            ? [`페이지 내 라이선스 링크 감지: ${extracted.licenseName} (${extracted.licenseUrl})`]
            : ['페이지에서 검증 가능한 저작권·이용허락 표시를 찾지 못했습니다.'])
        ],
        licenseName: extracted.licenseName,
        licenseUrl: extracted.licenseUrl,
        licenseAllowsCommercial: extracted.licenseName ? !/NC/i.test(extracted.licenseName) : undefined,
        licenseAllowsDerivatives: extracted.licenseName ? !/ND/i.test(extracted.licenseName) : undefined,
        licenseRequiresAttribution: extracted.licenseName ? /BY/i.test(extracted.licenseName) : undefined,
        licenseShareAlike: extracted.licenseName ? /SA/i.test(extracted.licenseName) : undefined,
        sourceAccessNote:
          'HTML에서 스크립트·메뉴·내비게이션을 제거해 추출했습니다. 원문 누락과 해당 페이지의 이용 조건을 반드시 직접 확인하세요.'
      });
      // 일반 웹페이지는 항상 사용자 확인이 필요
      rights.needsManualReview = true;

      if (!extracted.text.trim()) {
        return {
          ok: false,
          sourceId: 'url-import',
          sourceName: extracted.siteName || `URL (${host})`,
          workId: res.finalUrl,
          title: extracted.title,
          author: extracted.author,
          edition: extracted.siteName || host,
          sourceUrl: res.finalUrl,
          rights,
          verification,
          fetchedAt,
          inputMethod: 'url',
          errorCode: 'EMPTY_BODY',
          errorMessage: '페이지에서 본문 텍스트를 추출하지 못했습니다. 자바스크립트 동적 렌더링 페이지이거나 로그인이 필요할 수 있습니다.'
        };
      }

      return {
        ok: true,
        sourceId: 'url-import',
        sourceName: extracted.siteName || `URL (${host})`,
        workId: res.finalUrl,
        title: extracted.title || host,
        author: extracted.author,
        edition: extracted.siteName ? `${extracted.siteName} 웹페이지` : `${host} 웹페이지`,
        sourceUrl: res.finalUrl,
        originalText: extracted.text,
        rights,
        verification,
        fetchedAt,
        inputMethod: 'url'
      };
    } catch (err) {
      const code = err instanceof SourceNetworkError ? err.code : 'FETCH_FAILED';
      const msg = err instanceof Error ? err.message : 'URL에서 원문을 가져오지 못했습니다.';
      return {
        ok: false,
        sourceId: 'url-import',
        sourceName: `URL (${host})`,
        workId: parsed.toString(),
        title: '',
        author: '',
        edition: host,
        sourceUrl: parsed.toString(),
        rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
        fetchedAt,
        inputMethod: 'url',
        errorCode: code,
        errorMessage: msg
      };
    }
  }

  return { importFromUrl };
}
