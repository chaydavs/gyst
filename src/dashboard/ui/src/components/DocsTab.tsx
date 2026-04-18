import { useState, useEffect } from 'react';
import { api } from '../api';
import type { DocEntry } from '../types';

/** DocsTab — file list on the left, markdown preview on the right for md_doc entries. */
export default function DocsTab() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selected, setSelected] = useState<DocEntry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDocs()
      .then(setDocs)
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const selectDoc = async (id: string) => {
    const doc = await api.getDoc(id).catch(() => null);
    if (doc) setSelected(doc);
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', fontFamily: 'var(--font-mono)', color: '#bbb', fontSize: '12px' }}>
        Loading docs…
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div style={{ padding: '40px', fontFamily: 'var(--font-mono)', color: '#bbb', fontSize: '12px' }}>
        No markdown documents ingested yet. Run <code>gyst self-document</code> to bootstrap.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ width: '260px', flexShrink: 0, borderRight: '1px solid var(--line)', overflowY: 'auto', padding: '8px 0' }}>
        {docs.map(doc => (
          <button
            key={doc.id}
            onClick={() => void selectDoc(doc.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 16px', background: selected?.id === doc.id ? 'var(--sunken)' : 'transparent',
              border: 'none', borderLeft: selected?.id === doc.id ? '2px solid #0891b2' : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>
              {doc.title}
            </div>
            {doc.file_path && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '2px' }}>
                {doc.file_path}
              </div>
            )}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
        {selected ? (
          <>
            <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '18px', marginBottom: '4px' }}>
              {selected.title}
            </h2>
            {selected.file_path && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)', marginBottom: '20px' }}>
                {selected.file_path}
              </div>
            )}
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.6, color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {selected.content}
            </pre>
          </>
        ) : (
          <div style={{ color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
            Select a document to preview.
          </div>
        )}
      </div>
    </div>
  );
}
