import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';

const TEST_DB = '/tmp/gyst-test-md-doc.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('md_doc type migration', () => {
  test('allows inserting md_doc entries', () => {
    const db = initDatabase(TEST_DB);
    const now = new Date().toISOString();
    expect(() => {
      db.run(
        `INSERT INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['test-md-1', 'md_doc', 'README.md', 'content', 0.9, 1, now, now, 'active', 'team']
      );
    }).not.toThrow();
    db.close();
  });

  test('entries table has source_file_hash column', () => {
    const db = initDatabase(TEST_DB);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(entries)').all();
    expect(cols.map(c => c.name)).toContain('source_file_hash');
    db.close();
  });
});
