/**
 * 원문 자동 검색·가져오기·저작권 검증·성경·프로젝트 버전 관리 자동 테스트.
 * 외부 네트워크에 의존하지 않도록 MockSourceProvider 및 MockHttpClient를 사용한다.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { loadTS } from './load-ts.mjs';

const root = resolve(import.meta.dirname, '..');
const copyright = loadTS(join(root, 'src/shared/copyright.ts'));
const textVerify = loadTS(join(root, 'src/shared/text-verify.ts'));
const bibleCatalog = loadTS(join(root, 'src/shared/bible-catalog.ts'));
const versioning = loadTS(join(root, 'src/shared/original-versioning.ts'));
const workflow = loadTS(join(root, 'src/shared/workflow.ts'));
const prompts = loadTS(join(root, 'src/shared/prompts.ts'));
const originalFetch = loadTS(join(root, 'src/shared/original-fetch.ts'));
const htmlExtract = loadTS(join(root, 'src/main/sources/html-extract.ts'));
const httpClient = loadTS(join(root, 'src/main/sources/http-client.ts'));
const wikisourceMod = loadTS(join(root, 'src/main/sources/wikisource-provider.ts'));
const gonguMod = loadTS(join(root, 'src/main/sources/gongu-provider.ts'));
const bibleMod = loadTS(join(root, 'src/main/sources/bible-provider.ts'));
const urlMod = loadTS(join(root, 'src/main/sources/url-importer.ts'));
const fileMod = loadTS(join(root, 'src/main/sources/file-importer.ts'));
const serviceMod = loadTS(join(root, 'src/main/sources/source-service.ts'));

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', label);
  } catch (err) {
    failed++;
    console.error('FAIL', label, err);
    process.exitCode = 1;
  }
}

const SEOSI_TEXT = [
  '죽는 날까지 하늘을 우르러',
  '한점 부끄럼이 없기를,',
  '잎새에 이는 바람에도',
  '나는 괴로워했다.',
  '별을 노래하는 마음으로',
  '모든 죽어가는것을 사랑해야지',
  '그리고 나한테 주어진 길을',
  '걸어가야겠다.',
  '',
  '오늘 밤에도 별이 바람에 스치운다.'
].join('\n');

const SEOSI_EDITION_2 = SEOSI_TEXT.replace('우르러', '우러러');

/** 외부 네트워크 없는 MockSourceProvider */
function createMockProvider() {
  const catalog = [
    {
      sourceId: 'mock-lit',
      sourceName: '모의 위키문헌',
      workId: 'seosi-1948',
      title: '서시',
      author: '윤동주',
      edition: '초판본 (1948)',
      publishedYear: '1948',
      sourceUrl: 'https://ko.wikisource.org/wiki/seosi_1948',
      autoFetchSupported: true,
      textFetched: false,
      preliminaryRightsStatus: 'PUBLIC_DOMAIN_VERIFIED',
      _text: SEOSI_TEXT,
      _deathYear: 1945
    },
    {
      sourceId: 'mock-lit',
      sourceName: '모의 위키문헌',
      workId: 'seosi-1955',
      title: '서시',
      author: '윤동주',
      edition: '증보판 (1955)',
      publishedYear: '1955',
      sourceUrl: 'https://ko.wikisource.org/wiki/seosi_1955',
      autoFetchSupported: true,
      textFetched: false,
      preliminaryRightsStatus: 'PUBLIC_DOMAIN_VERIFIED',
      _text: SEOSI_EDITION_2,
      _deathYear: 1945
    },
    {
      sourceId: 'mock-lit',
      sourceName: '모의 위키문헌',
      workId: 'seosi-other',
      title: '서시',
      author: '김영랑',
      edition: '영랑시집 (1935)',
      publishedYear: '1935',
      sourceUrl: 'https://ko.wikisource.org/wiki/seosi_youngrang',
      autoFetchSupported: true,
      textFetched: false,
      preliminaryRightsStatus: 'PUBLIC_DOMAIN_VERIFIED',
      _text: '내 마음을 아실 이\n내 혼자 마음 날같이 아실 이',
      _deathYear: 1950
    },
    {
      sourceId: 'mock-lit',
      sourceName: '모의 위키문헌',
      workId: 'fail-download',
      title: '다운로드실패테스트',
      author: '홍길동',
      edition: '오류판',
      sourceUrl: 'https://example.org/fail',
      autoFetchSupported: true,
      textFetched: false,
      preliminaryRightsStatus: 'UNKNOWN',
      _fail: true
    }
  ];

  return {
    id: 'mock-lit',
    name: '모의 문학 제공처',
    description: '테스트용 모의 제공처',
    officialUrl: 'https://example.org/',
    autoFetchSupported: true,
    kinds: ['literature'],
    async search(q) {
      const needle = (q.query || '').trim();
      const authorNeedle = (q.author || '').trim();
      return catalog
        .filter(item => (!needle || item.title.includes(needle)) && (!authorNeedle || item.author.includes(authorNeedle)))
        .map(({ _text, _deathYear, _fail, ...cand }) => cand);
    },
    async getRightsInfo(candidate) {
      const item = catalog.find(x => x.workId === candidate.workId);
      return copyright.evaluateRightsEvidence({
        authorDeathYear: item?._deathYear ?? null,
        providerEvidenceStatus: item?._deathYear ? 'PUBLIC_DOMAIN_VERIFIED' : 'UNKNOWN',
        providerEvidenceItems: ['모의 출처 확인']
      });
    },
    async fetchOriginal(candidate) {
      const item = catalog.find(x => x.workId === candidate.workId);
      if (!item || item._fail) {
        return {
          ok: false,
          sourceId: candidate.sourceId,
          sourceName: candidate.sourceName,
          workId: candidate.workId,
          title: candidate.title,
          author: candidate.author,
          edition: candidate.edition,
          sourceUrl: candidate.sourceUrl,
          rights: copyright.evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
          fetchedAt: new Date().toISOString(),
          inputMethod: 'search',
          errorCode: 'DOWNLOAD_FAILED',
          errorMessage: '원문 다운로드에 실패했습니다.'
        };
      }
      const rights = await this.getRightsInfo(candidate);
      return {
        ok: true,
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
        workId: item.workId,
        title: item.title,
        author: item.author,
        edition: item.edition,
        publishedYear: item.publishedYear,
        sourceUrl: item.sourceUrl,
        originalText: item._text,
        rights,
        verification: textVerify.verifyOriginalText({ text: item._text, genre: 'poetry', expectedTitle: item.title, actualTitle: item.title }),
        fetchedAt: new Date().toISOString(),
        inputMethod: 'search'
      };
    }
  };
}

/** 테스트용 모의 HTTP 클라이언트 */
function createMockHttp(handlers) {
  return {
    async isRobotsAllowed(url) {
      if (handlers.robots) return handlers.robots(url);
      return { allowed: true };
    },
    async fetchText(url, opts = {}) {
      if (opts.checkRobots) {
        const r = await this.isRobotsAllowed(url);
        if (!r.allowed) throw new httpClient.SourceNetworkError('ROBOTS_DISALLOWED', r.reason || 'robots.txt 차단');
      }
      return handlers.fetch(url, opts);
    }
  };
}

/** 테스트용 최소 유효 DOCX(ZIP) 버퍼 생성 (무압축/DEFLATE 모두 지원) */
function makeMinimalDocxBuffer(paragraphs) {
  const xmlBody = paragraphs
    .map(p => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlBody}</w:body></w:document>`;
  const nameBuf = Buffer.from('word/document.xml', 'utf8');
  const rawBuf = Buffer.from(xml, 'utf8');
  const compBuf = deflateRawSync(rawBuf);

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(compBuf.length, 18);
  localHeader.writeUInt32LE(rawBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(localHeader, 30);

  const cdHeader = Buffer.alloc(46 + nameBuf.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(compBuf.length, 20);
  cdHeader.writeUInt32LE(rawBuf.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt32LE(0, 42);
  nameBuf.copy(cdHeader, 46);

  const cdOffset = localHeader.length + compBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdHeader.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, compBuf, cdHeader, eocd]);
}

const mockProvider = createMockProvider();
const gonguProvider = gonguMod.createGonguProvider();

const mockBibleVerses = {
  'KRV:19:23': [
    { verse: 1, text: '여호와는 나의 목자시니 내가 부족함이 없으리로다', translationId: 'KRV' },
    { verse: 2, text: '그가 나를 푸른 초장에 누이시며 쉴만한 물 가으로 인도하시는도다', translationId: 'KRV' },
    { verse: 3, text: '내 영혼을 소생시키시고 자기 이름을 위하여 의의 길로 인도하시는도다', translationId: 'KRV' },
    { verse: 4, text: '내가 사망의 음침한 골짜기로 다닐찌라도 해를 두려워하지 않을 것은 주께서 나와 함께 하심이라 주의 지팡이와 막대기가 나를 안위하시나이다', translationId: 'KRV' },
    { verse: 5, text: '주께서 내 원수의 목전에서 내게 상을 베푸시고 기름으로 내 머리에 바르셨으니 내 잔이 넘치나이다', translationId: 'KRV' },
    { verse: 6, text: '나의 평생에 선하심과 인자하심이 정녕 나를 따르리니 내가 여호와의 집에 영원히 거하리로다', translationId: 'KRV' },
    { verse: 7, text: '요청하지 않은 추가 절 테스트', translationId: 'KRV' }
  ],
  'KRV:19:24': [
    { verse: 1, text: '땅과 거기 충만한 것과 세계와 그 중에 거하는 자가 다 여호와의 것이로다', translationId: 'KRV' },
    { verse: 2, text: '여호와께서 그 터를 바다 위에 세우심이여 강들 위에 건설하셨도다', translationId: 'KRV' },
    // 3절 의도적 누락
    { verse: 4, text: '곧 손이 깨끗하며 마음이 청결하며 뜻을 허탄한데 두지 아니하며 거짓 맹세치 아니하는 자로다', translationId: 'KRV' }
  ],
  'KRV:19:25': [
    { verse: 1, text: '여호와여 나의 영혼이 주를 우러러 보나이다', translationId: 'KRV' },
    { verse: 2, text: '혼합 번역본 테스트 절', translationId: 'NKRV' }
  ]
};

const mockBibleAdapter = bibleMod.createBibleSourceAdapter({
  async fetchChapter(code, bookId, chapter) {
    const key = `${code}:${bookId}:${chapter}`;
    const verses = mockBibleVerses[key] || [];
    return { verses, sourceUrl: `https://bolls.life/get-text/${code}/${bookId}/${chapter}/`, sourceNote: '모의 성경 데이터' };
  }
});

const mockHttp = createMockHttp({
  robots(url) {
    if (url.includes('/blocked-path')) return { allowed: false, reason: 'robots.txt에 의해 자동 접근 차단됨' };
    return { allowed: true };
  },
  async fetch(url) {
    if (url.includes('network-down.example')) {
      throw new httpClient.SourceNetworkError('NETWORK_ERROR', '인터넷 연결을 확인하거나 잠시 후 다시 시도해 주세요.');
    }
    if (url.includes('poem-page.example')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: 'text/html; charset=utf-8',
        bytes: 600,
        text: `<!doctype html><html><head><title>진달래꽃 - 김소월</title><meta name="author" content="김소월"><script>alert("xss")</script></head><body>
          <header><nav class="navbar"><a href="/login">로그인</a><a href="/signup">회원가입</a></nav></header>
          <aside class="sidebar">추천 작품 광고 배너</aside>
          <article><div class="poem"><p>나 보기가 역겨워<br/>가실 때에는<br/>말없이 고이 보내 드리우리다</p><p>영변에 약산<br/>진달래꽃<br/>아름 따다 가실 길에 뿌리우리다</p></div></article>
          <footer>All rights reserved · 개인정보 처리방침</footer>
        </body></html>`
      };
    }
    return { ok: false, status: 404, finalUrl: url, contentType: 'text/plain', bytes: 0, text: '' };
  }
});

const mockWiki = wikisourceMod.createWikisourceProvider(mockHttp, { lang: 'ko' });
const urlImporter = urlMod.createUrlImporter({ http: mockHttp, wikisourceKo: mockWiki, wikisourceEn: mockWiki });
const service = serviceMod.createSourceService({
  providers: [mockProvider, gonguProvider],
  bibleAdapter: mockBibleAdapter,
  urlImporter
});

// ── 검색 및 가져오기 (1~10) ──
await test('1. 정상 작품 검색 (검색 결과와 원문 확보 분리)', async () => {
  const res = await service.search({ query: '서시', author: '윤동주' });
  assert.equal(res.candidates.length, 2);
  assert.equal(res.candidates[0].textFetched, false);
  assert.equal(res.candidates[0].author, '윤동주');
});

await test('2. 검색 결과 없음 (가짜 작품 생성 금지)', async () => {
  const res = await service.search({ query: '존재하지않는미지의작품9999' });
  assert.equal(res.candidates.length, 0);
});

await test('3. 동일 제목의 다른 작가 구분', async () => {
  const res = await service.search({ query: '서시' });
  const authors = new Set(res.candidates.map(c => c.author));
  assert.ok(authors.has('윤동주') && authors.has('김영랑'));
  assert.ok(res.disambiguationNote && res.disambiguationNote.includes('작가'));
});

await test('4. 여러 판본 검색 및 두 판본 대조', async () => {
  const res = await service.search({ query: '서시', author: '윤동주' });
  assert.equal(res.candidates.length, 2);
  const f1 = await service.fetchOriginal(res.candidates[0]);
  const f2 = await service.fetchOriginal(res.candidates[1]);
  assert.equal(f1.ok, true);
  assert.equal(f2.ok, true);
  assert.equal(f1.comparison.compared, false);
  assert.equal(f1.comparison.message, '다른 판본과 대조하지 못함');
  const diff = await service.compare(
    { label: f1.edition, text: f1.originalText },
    { label: f2.edition, text: f2.originalText }
  );
  assert.equal(diff.compared, true);
  assert.equal(diff.differentCount, 1);
  assert.ok(diff.sameCount >= 8);
});

await test('5. 원문 다운로드 실패 처리', async () => {
  const res = await service.search({ query: '다운로드실패테스트' });
  assert.equal(res.candidates.length, 1);
  const fetched = await service.fetchOriginal(res.candidates[0]);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.errorCode, 'DOWNLOAD_FAILED');
  assert.equal(fetched.originalText, undefined);
});

await test('6. 잘못된 URL 및 localhost/사설 IP 보안 차단', async () => {
  const bad1 = await service.importUrl('not-a-url');
  assert.equal(bad1.ok, false);
  assert.equal(bad1.errorCode, 'INVALID_URL');

  const bad2 = await service.importUrl('file:///C:/Windows/win.ini');
  assert.equal(bad2.ok, false);
  assert.equal(bad2.errorCode, 'UNSUPPORTED_PROTOCOL');

  const bad3 = await service.importUrl('http://localhost:3000/secret');
  assert.equal(bad3.ok, false);
  assert.equal(bad3.errorCode, 'BLOCKED_LOCAL_HOST');

  const bad4 = await service.importUrl('http://192.168.0.10/admin');
  assert.equal(bad4.ok, false);
  assert.equal(bad4.errorCode, 'BLOCKED_PRIVATE_IP');
});

await test('7. 인터넷 연결 실패 안내', async () => {
  const res = await service.importUrl('https://network-down.example/work');
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'NETWORK_ERROR');
  assert.ok(res.errorMessage.includes('인터넷 연결'));
});

await test('8. 미지원 사이트 및 robots.txt 차단 경로 거부', async () => {
  const unsup = await service.importUrl('https://www.ridibooks.com/books/123');
  assert.equal(unsup.ok, false);
  assert.equal(unsup.errorCode, 'UNSUPPORTED_SITE');

  const robotsBlocked = await service.importUrl('https://public-site.example/blocked-path/doc.html');
  assert.equal(robotsBlocked.ok, false);
  assert.equal(robotsBlocked.errorCode, 'ROBOTS_DISALLOWED');
});

await test('9. HTML 본문에서 메뉴·사이드바·스크립트·푸터 제거', async () => {
  const res = await service.importUrl('https://poem-page.example/jindallae');
  assert.equal(res.ok, true);
  assert.equal(res.author, '김소월');
  assert.ok(!res.originalText.includes('로그인'));
  assert.ok(!res.originalText.includes('alert("xss")'));
  assert.ok(!res.originalText.includes('광고 배너'));
  assert.ok(!res.originalText.includes('All rights reserved'));
  assert.ok(res.originalText.includes('나 보기가 역겨워'));
  // 일반 웹사이트는 절대 PUBLIC_DOMAIN_VERIFIED로 자동 판정하지 않음
  assert.equal(res.rights.status, 'UNKNOWN');
});

await test('10. 시 원문 행·연 구분 유지 (고어·띄어쓰기 자동 교정 없음)', async () => {
  const res = await service.importUrl('https://poem-page.example/jindallae');
  assert.ok(res.originalText.includes('나 보기가 역겨워\n가실 때에는\n말없이 고이 보내 드리우리다\n\n영변에 약산\n진달래꽃'));
  // 윤동주 초판본 고어 표기("우르러", "죽어가는것을") 원형 보존 확인
  const seosi = await service.fetchOriginal((await service.search({ query: '서시', author: '윤동주' })).candidates[0]);
  assert.ok(seosi.originalText.includes('우르러'));
  assert.ok(seosi.originalText.includes('모든 죽어가는것을'));
  assert.ok(seosi.originalText.includes('\n\n오늘 밤에도 별이 바람에 스치운다.'));
});

// ── 저작권 검증 (11~16) ──
await test('11. 저작권 보호기간 만료 근거 확인 (한국 저작권법 제39조·제44조)', () => {
  const r = copyright.evaluateRightsEvidence({
    authorDeathYear: 1945,
    providerEvidenceStatus: 'PUBLIC_DOMAIN_VERIFIED',
    providerEvidenceItems: ['윤동주(1917~1945)'],
    referenceYear: 2026
  });
  assert.equal(r.status, 'PUBLIC_DOMAIN_VERIFIED');
  assert.equal(r.protectionCalculation.expired, true);
  assert.equal(r.protectionCalculation.expiryYear, 1995);
  assert.ok(r.evidenceItems.some(e => e.includes('1945년')));
});

await test('12. 작가 사망연도 누락 시 임의 추정 금지', () => {
  const r = copyright.evaluateRightsEvidence({
    authorDeathYear: null,
    providerEvidenceStatus: 'UNKNOWN'
  });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.protectionCalculation.calculated, false);
  assert.equal(r.protectionCalculation.autoConclusive, false);
  assert.ok(r.reviewItems.some(x => x.includes('사망연도')));
});

await test('13. 번역 저작물의 별도 권리 검토 (자동 확정 차단)', () => {
  const r = copyright.evaluateRightsEvidence({
    authorDeathYear: 1817,
    isTranslation: true,
    translatorName: '홍길동',
    translatorDeathYear: null,
    providerEvidenceStatus: 'PUBLIC_DOMAIN_VERIFIED'
  });
  assert.equal(r.status, 'REVIEW_REQUIRED');
  assert.equal(r.protectionCalculation.autoConclusive, false);
  assert.ok(r.reviewItems.some(x => x.includes('번역')));
});

await test('14. 이용허락 조건 표시 (CC BY-NC-SA 용도별 매트릭스)', () => {
  const r = copyright.evaluateRightsEvidence({
    providerEvidenceStatus: 'LICENSE_VERIFIED',
    licenseName: 'CC BY-NC-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    licenseAllowsCommercial: false,
    licenseAllowsDerivatives: true,
    licenseRequiresAttribution: true,
    licenseShareAlike: true
  });
  assert.equal(r.status, 'LICENSE_VERIFIED');
  assert.equal(r.usage.monetization, 'restricted');
  assert.equal(r.usage.storage, 'allowed');
  assert.equal(r.attributionRequired, true);
  assert.ok(r.reviewItems.some(x => x.includes('비영리')));
});

await test('15. 권리 상태 불명확 및 사용자 직접 신고와 시스템 검증 구분', () => {
  const unknown = copyright.evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(copyright.RIGHTS_STATUS_META[unknown.status].systemVerified, false);

  const declared = copyright.applyUserRightsDeclaration(unknown, '저작권자에게 직접 영상 제작 서면 허락을 받음');
  assert.equal(declared.status, 'USER_RIGHTS_DECLARED');
  assert.equal(copyright.RIGHTS_STATUS_META[declared.status].systemVerified, false);
  assert.notEqual(declared.status, 'PUBLIC_DOMAIN_VERIFIED');
  assert.notEqual(declared.status, 'LICENSE_VERIFIED');
});

await test('16. 권리 상태 미확인 시 자동 승인 방지', () => {
  const unknown = copyright.evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' });
  assert.equal(copyright.canApproveOriginalRights(unknown).allowed, false);

  const reviewReq = copyright.evaluateRightsEvidence({
    authorDeathYear: 1920,
    isJointWork: true,
    providerEvidenceStatus: 'PUBLIC_DOMAIN_VERIFIED'
  });
  assert.equal(reviewReq.status, 'REVIEW_REQUIRED');
  assert.equal(copyright.canApproveOriginalRights(reviewReq).allowed, false);

  const restricted = copyright.evaluateRightsEvidence({ providerEvidenceStatus: 'RESTRICTED' });
  assert.equal(copyright.canApproveOriginalRights(restricted).allowed, false);
});

// ── 성경 (17~20) ──
await test('17. 성경 장·절 범위 가져오기 (시편 23편 1~6절, 요청 밖 7절 자동 제외)', async () => {
  const res = await service.fetchBible({
    translationId: 'KRV',
    bookId: 19,
    chapter: 23,
    startVerse: 1,
    endVerse: 6
  });
  assert.equal(res.ok, true);
  assert.equal(res.title, '시편 23편 1~6절');
  assert.equal(res.rights.status, 'PUBLIC_DOMAIN_VERIFIED');
  const lines = res.originalText.split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines[0].startsWith('1 여호와는 나의 목자시니'));
  assert.ok(lines[5].startsWith('6 나의 평생에'));
  assert.ok(!res.originalText.includes('요청하지 않은 추가 절'));
});

await test('18. 성경 장·절 누락 감지', async () => {
  const res = await service.fetchBible({
    translationId: 'KRV',
    bookId: 19,
    chapter: 24,
    startVerse: 1,
    endVerse: 4
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.meta.missingVerses, [3]);
  assert.ok(res.verification.issues.some(i => i.code === 'BIBLE_VERSE_MISSING' && i.message.includes('3절')));
});

await test('19. 성경 다른 번역본 혼합 방지', async () => {
  const res = await service.fetchBible({
    translationId: 'KRV',
    bookId: 19,
    chapter: 25,
    startVerse: 1,
    endVerse: 2
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'BIBLE_TRANSLATION_MIXED');
});

await test('20. 개역한글판과 개역개정판·현대 번역본 엄격 구분', async () => {
  const krv = bibleCatalog.getBibleTranslation('KRV');
  const nkrv = bibleCatalog.getBibleTranslation('NKRV');
  assert.equal(krv.rightsStatus, 'PUBLIC_DOMAIN_VERIFIED');
  assert.equal(nkrv.rightsStatus, 'RESTRICTED');

  const blocked = await service.fetchBible({
    translationId: 'NKRV',
    bookId: 19,
    chapter: 23,
    startVerse: 1,
    endVerse: 6
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'RIGHTS_RESTRICTED');
  assert.equal(blocked.rights.status, 'RESTRICTED');
});

// ── 프로젝트 저장·복원·변경 영향·호환성·AI 연동 (21~27) ──
const fixture = name => JSON.parse(readFileSync(join(root, 'fixtures', name), 'utf8'));
const baseBrief = {
  ...workflow.DEFAULT_BRIEF,
  genre: 'poetry',
  title: '서시',
  author: '윤동주',
  originalText: SEOSI_TEXT,
  rightsStatus: 'public-domain'
};

let projectV1 = workflow.makeProject('22222222-2222-2222-2222-222222222222', baseBrief);
const seosiFetched = await service.fetchOriginal((await service.search({ query: '서시', author: '윤동주' })).candidates[0]);

await test('21. 원문 확정 후 저장 (SHA-256·버전·출처·저작권 메타)', () => {
  projectV1 = versioning.approveOriginalInProject(projectV1, {
    briefPatch: {
      title: seosiFetched.title,
      author: seosiFetched.author,
      source: `${seosiFetched.sourceName} · ${seosiFetched.edition}`,
      sourceUrl: seosiFetched.sourceUrl,
      originalText: seosiFetched.originalText
    },
    meta: {
      inputMethod: 'search',
      providerId: seosiFetched.sourceId,
      providerName: seosiFetched.sourceName,
      workId: seosiFetched.workId,
      title: seosiFetched.title,
      author: seosiFetched.author,
      edition: seosiFetched.edition,
      sourceUrl: seosiFetched.sourceUrl,
      fetchedAt: seosiFetched.fetchedAt,
      rights: seosiFetched.rights,
      verification: seosiFetched.verification
    }
  });
  assert.equal(projectV1.brief.originalMeta.version, 1);
  assert.equal(projectV1.brief.originalMeta.sha256.length, 64);
  assert.equal(projectV1.brief.originalMeta.sha256, versioning.sha256Hex(SEOSI_TEXT));
  assert.equal(projectV1.brief.originalMeta.rights.status, 'PUBLIC_DOMAIN_VERIFIED');
  assert.equal(projectV1.brief.rightsStatus, 'public-domain');
});

await test('22. 앱 재시작 후 project.json 복원 (원문·메타·해시 유지)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gomo-src-test-'));
  try {
    const file = join(dir, 'project.json');
    writeFileSync(file, JSON.stringify(projectV1, null, 2), 'utf8');
    const restored = versioning.migrateProjectDocument(JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(restored.brief.originalText, SEOSI_TEXT);
    assert.equal(restored.brief.originalMeta.sha256, projectV1.brief.originalMeta.sha256);
    assert.equal(restored.brief.originalMeta.sourceUrl, seosiFetched.sourceUrl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 기획 분석 + 장면 + 미디어 파일이 이미 있는 상태 구성
let projectWithWork = workflow.applyAIResponse(projectV1, 'analysis', JSON.stringify(fixture('ai-analysis.example.json')));
projectWithWork.selection = { styleId: 'warm-watercolor', directionId: 'gentle' };
projectWithWork.scenes = [
  {
    id: 'S01',
    title: '서시 첫 연',
    narration: '죽는 날까지 하늘을 우르러',
    visual: '밤하늘과 별',
    durationSec: 10,
    kind: 'image',
    imagePrompt: 'starry night sky watercolor',
    videoPrompt: '',
    negativePrompt: '',
    assetId: 'asset-img-1',
    status: 'complete'
  }
];
projectWithWork.assets = [
  {
    id: 'asset-img-1',
    kind: 'image',
    name: 'night-sky.png',
    relativePath: 'assets/image/asset-img-1_night-sky.png',
    bytes: 40960,
    importedAt: new Date().toISOString()
  }
];
projectWithWork.assembly.clips = [{ sceneId: 'S01', durationSec: 10, transition: 'fade' }];

await test('23. 원문 변경 시 사용자 경고 생성', () => {
  const impact = versioning.assessOriginalChangeImpact(projectWithWork, SEOSI_EDITION_2);
  assert.equal(impact.textChanged, true);
  assert.equal(impact.hasDownstreamWork, true);
  assert.ok(impact.warningMessage && impact.warningMessage.includes('일치하지 않을 수 있습니다'));
  assert.equal(impact.assetCountPreserved, 1);
});

let projectV2;
await test('24. 기존 기획·스토리보드·자막 재검토 상태 반영 + 기존 원문 이력 보존', () => {
  projectV2 = versioning.approveOriginalInProject(projectWithWork, {
    briefPatch: {
      title: '서시',
      author: '윤동주',
      source: '모의 위키문헌 · 증보판 (1955)',
      sourceUrl: 'https://ko.wikisource.org/wiki/seosi_1955',
      originalText: SEOSI_EDITION_2
    },
    meta: {
      ...projectWithWork.brief.originalMeta,
      edition: '증보판 (1955)',
      sourceUrl: 'https://ko.wikisource.org/wiki/seosi_1955'
    },
    reason: '증보판 원문으로 교체'
  });
  assert.equal(projectV2.brief.originalMeta.version, 2);
  assert.equal(projectV2.originalHistory.length, 1);
  assert.equal(projectV2.originalHistory[0].version, 1);
  assert.equal(projectV2.originalHistory[0].originalText, SEOSI_TEXT);
  assert.equal(projectV2.reviewNeeded.analysis, true);
  assert.equal(projectV2.reviewNeeded.storyboard, true);
  assert.equal(projectV2.reviewNeeded.subtitles, true);
  // 기획 분석을 새로 적용하면 analysis 재검토 플래그 해제 확인
  const reAnalyzed = workflow.applyAIResponse(projectV2, 'analysis', JSON.stringify(fixture('ai-analysis.example.json')));
  assert.equal(reAnalyzed.reviewNeeded?.analysis, undefined);
});

await test('25. 원문 변경 후에도 기존 미디어 파일(assets) 보존', () => {
  assert.equal(projectV2.assets.length, 1);
  assert.equal(projectV2.assets[0].id, 'asset-img-1');
  assert.equal(projectV2.assets[0].relativePath, 'assets/image/asset-img-1_night-sky.png');
});

await test('26. 구버전 project.json 하위 호환성 (originalMeta/originalHistory 없음)', () => {
  const legacy = {
    schema: 'creator.project.v1',
    id: '33333333-3333-3333-3333-333333333333',
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    brief: {
      genre: 'poetry',
      audience: 'adult',
      title: '구버전 작품',
      author: '작가',
      source: '',
      sourceUrl: '',
      originalText: '구버전 원문 내용입니다.',
      rightsStatus: 'reviewed',
      targetDuration: 60,
      aspectRatio: '16:9'
    },
    selection: { styleId: '', directionId: '' },
    analysis: null,
    scenes: [],
    assets: [],
    ai: {
      analysis: { status: 'idle', raw: '', updatedAt: null },
      storyboard: { status: 'idle', raw: '', updatedAt: null },
      prompt: { status: 'idle', raw: '', updatedAt: null },
      editplan: { status: 'idle', raw: '', updatedAt: null }
    },
    assembly: { clips: [], subtitleMode: 'original', transitionDefault: 'fade', bgmAssetId: null }
  };
  const migrated = versioning.migrateProjectDocument(legacy);
  assert.equal(migrated.brief.title, '구버전 작품');
  assert.deepEqual(migrated.originalHistory, []);
  assert.equal(workflow.stageComplete(migrated, 'brief'), true);
});

await test('27. 확정 원문과 AI 기획 분석 입력 프롬프트의 100% 동일성', () => {
  const promptText = prompts.makeAIPrompt(projectV1, 'analysis');
  const marker = `<<<ORIGINAL_TEXT\n${projectV1.brief.originalText}\nORIGINAL_TEXT`;
  assert.ok(promptText.includes(marker));
  assert.ok(promptText.includes('죽는 날까지 하늘을 우르러\n한점 부끄럼이 없기를,'));
});

// ── 추가 검증 (파일 가져오기 TXT/DOCX/PDF + 공유마당 robots.txt 파서) ──
await test('28. 파일 가져오기: UTF-8 TXT, DOCX(문단 보존+안내), PDF 비활성 안내', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gomo-file-test-'));
  try {
    const txtPath = join(dir, 'sample.txt');
    writeFileSync(txtPath, SEOSI_TEXT, 'utf8');
    const txtRes = await fileMod.importOriginalFromFilePath(txtPath);
    assert.equal(txtRes.ok, true);
    assert.equal(txtRes.originalText, SEOSI_TEXT);
    assert.equal(txtRes.rights.status, 'UNKNOWN');

    const docxPath = join(dir, 'sample.docx');
    writeFileSync(docxPath, makeMinimalDocxBuffer(['첫 번째 행입니다.', '두 번째 행입니다.']));
    const docxRes = await fileMod.importOriginalFromFilePath(docxPath);
    assert.equal(docxRes.ok, true);
    assert.equal(docxRes.originalText, '첫 번째 행입니다.\n두 번째 행입니다.');
    assert.ok(docxRes.verification.issues.some(i => i.code === 'FILE_EXTRACTION_NOTICE'));

    const pdfPath = join(dir, 'sample.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    const pdfRes = await fileMod.importOriginalFromFilePath(pdfPath);
    assert.equal(pdfRes.ok, false);
    assert.equal(pdfRes.errorCode, 'PDF_UNSUPPORTED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('29. 공유마당 robots.txt 규칙 준수 (파일 다운로드 차단 확인)', () => {
  const gonguRobots = `User-agent: *\nDisallow: /gongu/wrt/cmmn/wrtFileDownload.do\nDisallow: /gongu/cmmn/file/fileDown.do\n`;
  const rules = httpClient.parseRobotsDisallow(gonguRobots);
  assert.equal(httpClient.isPathDisallowedByRobots('/gongu/wrt/cmmn/wrtFileDownload.do', rules), true);
  assert.equal(httpClient.isPathDisallowedByRobots('/gongu/cmmn/file/fileDown.do', rules), true);
  assert.equal(httpClient.isPathDisallowedByRobots('/gongu/search/search/list.do', rules), false);
});

await test('30. 위키문헌 {{머리말}} 파싱 (빈 역자 필드 오인 방지 + 위키링크 저자 정제)', () => {
  const wt = `{{머리말\n| 제목 = [[../|하늘과 바람과 별과 시]]\n| 저자 = [[저자:윤동주|윤동주]]\n| 역자 = \n| 이전 = \n| 다음 = [[../자화상|자화상]]\n| 연도 = 1941\n}}`;
  const parsed = wikisourceMod.parseWikisourceHeader(wt);
  assert.equal(parsed.title, '하늘과 바람과 별과 시');
  assert.equal(parsed.author, '윤동주');
  assert.equal(parsed.translator, undefined);
  assert.equal(parsed.year, '1941');
});


await test('31. 파일 가져오기: SRT 대사 추출, HTML 본문 추출, EUC-KR 텍스트', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gomo-file-extra-'));
  try {
    const srtPath = join(dir, 'poem.srt');
    writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:04,000\n죽는 날까지 하늘을 우러러\n\n2\n00:00:04,500 --> 00:00:08,000\n한점 부끄럼이 없기를,\n', 'utf8');
    const srtRes = await fileMod.importOriginalFromFilePath(srtPath);
    assert.equal(srtRes.ok, true);
    assert.equal(srtRes.originalText, '죽는 날까지 하늘을 우러러\n\n한점 부끄럼이 없기를,');

    const htmlPath = join(dir, 'work.html');
    writeFileSync(htmlPath, '<html><head><title>진달래꽃</title></head><body><nav>메뉴</nav><article><p>나 보기가 역겨워</p><p>가실 때에는</p></article></body></html>', 'utf8');
    const htmlRes = await fileMod.importOriginalFromFilePath(htmlPath);
    assert.equal(htmlRes.ok, true);
    assert.match(htmlRes.originalText, /나 보기가 역겨워/);
    assert.doesNotMatch(htmlRes.originalText, /메뉴/);
    assert.equal(htmlRes.title, '진달래꽃');

    const eucPath = join(dir, 'seosi.txt');
    writeFileSync(eucPath, Buffer.from([193, 215, 180, 194, 32, 179, 175, 177, 238, 193, 246, 32, 199, 207, 180, 195, 192, 187, 32, 191, 236, 183, 175, 183, 175]));
    const eucRes = await fileMod.importOriginalFromFilePath(eucPath);
    assert.equal(eucRes.ok, true);
    assert.equal(eucRes.originalText, '죽는 날까지 하늘을 우러러');
    assert.match(eucRes.edition, /EUC-KR|CP949|euc/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('32. Gemini 원문 프롬프트에 장르·저자·제목이 들어간다', () => {
  const prompt = originalFetch.makeOriginalTextPrompt({ title: '서시', author: '윤동주', genre: 'poetry' });
  assert.match(prompt, /서시/);
  assert.match(prompt, /윤동주/);
  assert.match(prompt, /시/);
  assert.match(prompt, /<<<ORIGINAL_TEXT/);
  assert.match(prompt, /UNAVAILABLE/);
});

await test('33. Gemini 원문 응답에서 마커·코드 블록·거절을 구분한다', () => {
  const marked = originalFetch.extractOriginalText('설명입니다.\n<<<ORIGINAL_TEXT\n죽는 날까지 하늘을 우러러\nORIGINAL_TEXT\n');
  assert.equal(marked.ok, true);
  assert.equal(marked.text, '죽는 날까지 하늘을 우러러');

  const blocked = originalFetch.extractOriginalText('아래와 같습니다.', ['나 보기가 역겨워\n가실 때에는']);
  assert.equal(blocked.ok, true);
  assert.equal(blocked.text, '나 보기가 역겨워\n가실 때에는');

  const no = originalFetch.extractOriginalText('UNAVAILABLE: 해당 작품의 전문을 제공할 수 없습니다.');
  assert.equal(no.ok, false);
  assert.match(no.reason, /제공할 수 없습니다/);

  const empty = originalFetch.extractOriginalText('');
  assert.equal(empty.ok, false);
});

await test('34. 편집실 전달 점검은 저작권 미확인만으로 막지 않는다', () => {
  const p = workflow.makeProject('handoff-rights', {
    ...workflow.DEFAULT_BRIEF,
    title: '서시',
    originalText: '죽는 날까지 하늘을 우러러',
    rightsStatus: 'unreviewed'
  });
  // 장면·미디어·편집안이 없어 다른 경고는 남지만, 저작권 경고는 없어야 한다
  const r = workflow.readyForHandoff(p);
  assert.equal(r.warnings.some(w => w.includes('저작권')), false);
});

console.log(`\n${passed} original-source tests passed${failed ? `, ${failed} failed` : ''}`);
