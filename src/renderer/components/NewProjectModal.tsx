import { useState } from 'react';
import { FilePlus2, PenLine, Search, X } from 'lucide-react';
import type { Audience, Brief, Genre } from '../../shared/types';
import { AUDIENCES, DEFAULT_BRIEF, GENRES } from '../../shared/workflow';
import { sha256Hex } from '../../shared/original-versioning';
import { toLegacyRightsStatus } from '../../shared/copyright';
import { OriginalSourcePanel, type ApprovedOriginalPayload } from './OriginalSourcePanel';
import { Button, Field, Tag } from './UI';

export function NewProjectModal({
  onClose,
  onCreate,
  busy
}: {
  onClose: () => void;
  onCreate: (b: Brief) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<'source' | 'manual'>('source');
  const [draft, setDraft] = useState<Brief>({ ...DEFAULT_BRIEF, genre: 'poetry' });
  const set = <K extends keyof Brief>(key: K, value: Brief[K]) => setDraft(v => ({ ...v, [key]: value }));

  const handleApprovedSource = (payload: ApprovedOriginalPayload) => {
    const now = new Date().toISOString();
    const nextBrief: Brief = {
      ...draft,
      genre: payload.genre ?? draft.genre,
      title: payload.title,
      author: payload.author,
      source: payload.source,
      sourceUrl: payload.sourceUrl,
      originalText: payload.originalText,
      rightsStatus: toLegacyRightsStatus(payload.meta.rights.status),
      originalMeta: {
        ...payload.meta,
        approvedAt: now,
        sha256: sha256Hex(payload.originalText),
        version: 1
      }
    };
    setDraft(nextBrief);
    setMode('manual');
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal new-modal new-modal-wide" role="dialog" aria-modal="true" aria-label="새 작품 만들기">
        <div className="modal-head">
          <div className="modal-head-icon">
            <FilePlus2 size={20} />
          </div>
          <div>
            <div className="eyebrow">NEW PROJECT</div>
            <h2>새 작품 만들기</h2>
            <p>제목 검색·성경 본문·URL·파일에서 원문을 검증해 가져오거나 직접 입력할 수 있습니다.</p>
          </div>
          <button className="icon-btn" onClick={onClose} type="button" aria-label="닫기">
            <X size={20} />
          </button>
        </div>

        <div className="new-modal-switcher">
          <button
            type="button"
            className={`source-tab ${mode === 'source' ? 'active' : ''}`}
            onClick={() => setMode('source')}
          >
            <Search size={14} /> 원문 자동 검색 · 가져오기
          </button>
          <button
            type="button"
            className={`source-tab ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
          >
            <PenLine size={14} /> 작품 정보 확인 · 직접 입력
          </button>
          {draft.originalMeta && (
            <Tag tone="success">기준 원문 확정됨 · v{draft.originalMeta.version}</Tag>
          )}
        </div>

        {mode === 'source' ? (
          <div className="modal-form">
            <OriginalSourcePanel
              defaultGenre={draft.genre}
              initialQuery={draft.title}
              initialAuthor={draft.author}
              onApprove={handleApprovedSource}
              onSwitchManual={() => setMode('manual')}
              compact
            />
          </div>
        ) : (
          <form
            className="modal-form"
            onSubmit={e => {
              e.preventDefault();
              if (draft.title.trim() && draft.originalText.trim()) onCreate(draft);
            }}
          >
            <div className="form-row">
              <Field label="작품 장르">
                <select value={draft.genre} onChange={e => set('genre', e.target.value as Genre)}>
                  {Object.entries(GENRES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="시청 대상">
                <select value={draft.audience} onChange={e => set('audience', e.target.value as Audience)}>
                  {Object.entries(AUDIENCES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="작품 제목">
              <input
                required
                placeholder={draft.genre === 'bible' ? '예: 시편 23편 1~6절' : '작품 제목'}
                value={draft.title}
                onChange={e => set('title', e.target.value)}
              />
            </Field>
            <div className="form-row">
              <Field label="저자 · 기록자">
                <input placeholder="직접 입력" value={draft.author} onChange={e => set('author', e.target.value)} />
              </Field>
              <Field label="출처 · 역본">
                <input placeholder="예: 역본 / 출처 정보" value={draft.source} onChange={e => set('source', e.target.value)} />
              </Field>
            </div>
            <Field label="원문 출처 URL">
              <input
                placeholder="https:// (선택 사항)"
                value={draft.sourceUrl}
                onChange={e => set('sourceUrl', e.target.value)}
              />
            </Field>
            <Field
              label="확정 원문"
              description="원문 텍스트는 AI가 임의로 변경하지 않도록 유지합니다. 실제 출처와 이용 조건을 확인해 주세요."
            >
              <textarea
                required
                rows={7}
                placeholder="낭독할 원문을 붙여넣거나 상단의 '원문 자동 검색 · 가져오기' 탭에서 불러오세요."
                value={draft.originalText}
                onChange={e => set('originalText', e.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <Button kind="secondary" type="button" onClick={onClose}>
                취소
              </Button>
              <Button disabled={busy || !draft.title.trim() || !draft.originalText.trim()} type="submit">
                작품 만들기
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
