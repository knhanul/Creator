/**
 * 로컬 파일에서 원문 가져오기.
 *
 * 지원: TXT / MD / SRT / HTML / HTM (UTF-8, UTF-16, EUC-KR/CP949) 및 DOCX(word/document.xml).
 * PDF는 OCR·다단·줄바꿈 손실 위험 때문에 자동 추출하지 않고 안내만 표시한다.
 * 무거운 외부 라이브러리 없이 Node 표준 모듈(fs, zlib)만 사용한다.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { OriginalFetchResult, TextVerificationIssue } from '../../shared/source-types';
import { ORIGINAL_FILE_EXTENSIONS, ORIGINAL_FILE_LABEL } from '../../shared/original-fetch';
import { evaluateRightsEvidence } from '../../shared/copyright';
import { verifyOriginalText } from '../../shared/text-verify';
import { decodeHtmlEntities, extractWebArticle } from './html-extract';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** 텍스트 버퍼를 BOM / UTF-8(fatal) / EUC-KR 순으로 안전하게 디코딩 */
export function decodeTextBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16LE' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16BE' };
  }
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: utf8, encoding: 'UTF-8' };
  } catch {
    try {
      const euckr = new TextDecoder('euc-kr').decode(buf);
      return { text: euckr, encoding: 'EUC-KR (자동 감지)' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'UTF-8 (손상 가능)' };
    }
  }
}


/** SRT 자막에서 번호·타임코드를 빼고 대사만 순서대로 추출 */
export function extractSrtText(text: string): string {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const lines: string[] = [];
  for (const block of blocks) {
    const parts = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
    if (!parts.length) continue;
    let start = 0;
    if (/^\d+$/.test(parts[0].trim())) start = 1;
    const rest = parts.slice(start).filter(l => !/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*/.test(l.trim()));
    if (rest.length) lines.push(rest.join('\n'));
  }
  return lines.join('\n\n').trim();
}

/**
 * 순수 Node ZIP 파서로 DOCX 안의 `word/document.xml`을 읽어 문단·줄바꿈을 보존한 텍스트 추출.
 */
export function extractDocxTextFromBuffer(buf: Buffer): string {
  // End of Central Directory (EOCD) signature: 0x06054b50
  let eocd = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('올바른 DOCX(ZIP) 파일 형식이 아닙니다.');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let pos = cdOffset;
  let xmlBuf: Buffer | null = null;

  for (let idx = 0; idx < cdEntries && pos + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (name === 'word/document.xml') {
      if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('DOCX 내부 헤더가 손상되었습니다.');
      }
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) xmlBuf = compressed;
      else if (method === 8) xmlBuf = inflateRawSync(compressed);
      else throw new Error(`지원하지 않는 DOCX 압축 방식(${method})입니다.`);
      break;
    }
  }

  if (!xmlBuf) throw new Error('DOCX 파일 안에서 본문(word/document.xml)을 찾지 못했습니다.');

  const xml = xmlBuf.toString('utf8');
  // 문단(<w:p>)과 강제 줄바꿈(<w:br/>), 탭(<w:tab/>)을 보존
  const paragraphs = xml.split(/<\/w:p>/i).slice(0, -1);
  const lines = paragraphs.map(p => {
    const withBreaks = p
      .replace(/<w:br\b[^>]*\/>/gi, '\n')
      .replace(/<w:tab\b[^>]*\/>/gi, '\t');
    const chunks: string[] = [];
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(withBreaks)) !== null) {
      chunks.push(decodeHtmlEntities(m[1]));
    }
    return chunks.join('');
  });

  return lines.join('\n').replace(/\r\n?/g, '\n').trim();
}

export async function importOriginalFromFilePath(filePath: string): Promise<OriginalFetchResult> {
  const fetchedAt = new Date().toISOString();
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const titleGuess = fileName.replace(/\.[^.]+$/, '');
  let resolvedTitle = titleGuess;

  if (ext === '.pdf') {
    return {
      ok: false,
      sourceId: 'local-file',
      sourceName: '로컬 파일 가져오기',
      workId: fileName,
      title: titleGuess,
      author: '',
      edition: `PDF 파일 (${fileName})`,
      sourceUrl: '',
      rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
      fetchedAt,
      inputMethod: 'file',
      errorCode: 'PDF_UNSUPPORTED',
      errorMessage:
        'PDF 파일은 다단 편집·OCR 오인식·줄바꿈 손실 위험이 있어 자동 원문 추출을 비활성화했습니다. TXT(UTF-8) 또는 DOCX로 변환하거나 원문을 복사해 직접 입력해 주세요.'
    };
  }

  const extNoDot = ext.replace(/^\./, '');
  const supported = (ORIGINAL_FILE_EXTENSIONS as readonly string[]).includes(extNoDot);
  if (!supported) {
    return {
      ok: false,
      sourceId: 'local-file',
      sourceName: '로컬 파일 가져오기',
      workId: fileName,
      title: titleGuess,
      author: '',
      edition: `로컬 파일 (${fileName})`,
      sourceUrl: '',
      rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
      fetchedAt,
      inputMethod: 'file',
      errorCode: 'UNSUPPORTED_FILE_TYPE',
      errorMessage: `지원하지 않는 파일 형식(${ext || '없음'})입니다. ${ORIGINAL_FILE_LABEL} 파일을 선택해 주세요.`
    };
  }

  try {
    const buf = await readFile(filePath);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return {
        ok: false,
        sourceId: 'local-file',
        sourceName: '로컬 파일 가져오기',
        workId: fileName,
        title: titleGuess,
        author: '',
        edition: fileName,
        sourceUrl: '',
        rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
        fetchedAt,
        inputMethod: 'file',
        errorCode: 'FILE_TOO_LARGE',
        errorMessage: '파일 크기가 10 MB를 초과하여 불러올 수 없습니다.'
      };
    }

    const extraIssues: TextVerificationIssue[] = [];
    let originalText = '';
    let encodingLabel = 'UTF-8';

    if (ext === '.docx') {
      originalText = extractDocxTextFromBuffer(buf);
      encodingLabel = 'DOCX (word/document.xml)';
      extraIssues.push({
        code: 'FILE_EXTRACTION_NOTICE',
        severity: 'info',
        message: 'DOCX 파일에서 본문 문단을 추출했습니다. 머리글·꼬리글·각주·표 안의 일부 내용이 누락되었을 수 있으므로 원문 전체를 확인해 주세요.'
      });
    } else {
      const decoded = decodeTextBuffer(buf);
      encodingLabel = decoded.encoding;
      const normalized = decoded.text.replace(/\r\n?/g, '\n');
      if (ext === '.srt') {
        originalText = extractSrtText(normalized);
        extraIssues.push({
          code: 'FILE_EXTRACTION_NOTICE',
          severity: 'info',
          message: 'SRT 자막에서 번호와 시간 코드를 빼고 대사만 본문으로 넣었습니다. 원본과 다르면 직접 고쳐 주세요.'
        });
      } else if (ext === '.html' || ext === '.htm') {
        const article = extractWebArticle(normalized);
        originalText = article.text;
        encodingLabel = `${decoded.encoding} · HTML 본문 추출`;
        if (article.title.trim()) resolvedTitle = article.title.trim();
        extraIssues.push({
          code: 'FILE_EXTRACTION_NOTICE',
          severity: 'info',
          message: 'HTML에서 메뉴·스크립트를 제거하고 본문 텍스트만 추출했습니다. 빠진 문단이 없는지 확인해 주세요.'
        });
      } else {
        originalText = normalized;
      }
      if (decoded.encoding !== 'UTF-8' && decoded.encoding !== 'UTF-8 (BOM)') {
        extraIssues.push({
          code: 'FILE_EXTRACTION_NOTICE',
          severity: 'info',
          message: `파일 인코딩을 ${decoded.encoding}(으)로 읽었습니다. 한글 깨짐이 없는지 확인해 주세요.`
        });
      }
    }

    const verification = verifyOriginalText({ text: originalText, extraIssues });
    const rights = evaluateRightsEvidence({
      providerEvidenceStatus: 'UNKNOWN',
      providerEvidenceItems: [
        `로컬 파일에서 본문을 불러왔습니다: ${fileName} (${encodingLabel})`
      ]
    });

    return {
      ok: Boolean(originalText.trim()),
      sourceId: 'local-file',
      sourceName: '로컬 파일 가져오기',
      workId: fileName,
      title: resolvedTitle,
      author: '',
      edition: `로컬 파일 (${fileName}, ${encodingLabel})`,
      sourceUrl: '',
      originalText: originalText.trim() ? originalText : undefined,
      rights,
      verification,
      fetchedAt,
      inputMethod: 'file',
      errorCode: originalText.trim() ? undefined : 'EMPTY_FILE',
      errorMessage: originalText.trim() ? undefined : '파일 내용이 비어 있습니다.'
    };
  } catch (err) {
    return {
      ok: false,
      sourceId: 'local-file',
      sourceName: '로컬 파일 가져오기',
      workId: fileName,
      title: titleGuess,
      author: '',
      edition: fileName,
      sourceUrl: '',
      rights: evaluateRightsEvidence({ providerEvidenceStatus: 'UNKNOWN' }),
      fetchedAt,
      inputMethod: 'file',
      errorCode: 'FILE_READ_FAILED',
      errorMessage: err instanceof Error ? err.message : '파일을 읽는 중 오류가 발생했습니다.'
    };
  }
}
