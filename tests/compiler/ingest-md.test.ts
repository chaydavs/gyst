import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../../src/store/database.js';
import { ingestMdFile, scanMdFiles } from '../../src/compiler/ingest-md.js';

const TEST_DB = '/tmp/gyst-test-ingest-md.db';
const TEST_DIR = '/tmp/gyst-md-test-dir';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('ingestMdFile', () => {
  test('creates a md_doc entry from a markdown file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'TEST.md');
    writeFileSync(filePath, '# Test Doc\n\nThis is content.\n\n## Section\nDetails.');
    const db = initDatabase(TEST_DB);

    const result = ingestMdFile(db, filePath, TEST_DIR);

    expect(result.created).toBe(true);
    const row = db.query<{ type: string; title: string; confidence: number; source_file_hash: string | null }, []>(
      "SELECT type, title, confidence, source_file_hash FROM entries WHERE type='md_doc' LIMIT 1"
    ).get();
    expect(row?.type).toBe('md_doc');
    expect(row?.title).toBe('Test Doc');
    expect(row?.confidence).toBeCloseTo(0.9);
    expect(row?.source_file_hash).toBeTruthy();
    db.close();
    unlinkSync(filePath);
  });

  test('skips unchanged files on second ingest', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'UNCHANGED.md');
    writeFileSync(filePath, '# Unchanged\nSame content.');
    const db = initDatabase(TEST_DB);

    const first = ingestMdFile(db, filePath, TEST_DIR);
    const second = ingestMdFile(db, filePath, TEST_DIR);

    expect(first.created).toBe(true);
    expect(second.skipped).toBe(true);
    db.close();
    unlinkSync(filePath);
  });

  test('reingest when file content changes', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'CHANGING.md');
    writeFileSync(filePath, '# Original\nFirst version.');
    const db = initDatabase(TEST_DB);

    ingestMdFile(db, filePath, TEST_DIR);
    writeFileSync(filePath, '# Updated\nSecond version.');
    const result = ingestMdFile(db, filePath, TEST_DIR);

    expect(result.updated).toBe(true);
    const row = db.query<{ title: string }, []>(
      "SELECT title FROM entries WHERE type='md_doc' LIMIT 1"
    ).get();
    expect(row?.title).toBe('Updated');
    db.close();
    unlinkSync(filePath);
  });
});

describe('scanMdFiles', () => {
  test('returns md files and excludes non-md', () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'README.md'), '# Readme');
    writeFileSync(join(TEST_DIR, 'docs', 'arch.md'), '# Arch');

    const files = scanMdFiles(TEST_DIR);
    const names = files.map(f => f.split('/').pop());
    expect(names).toContain('README.md');
    expect(names).toContain('arch.md');
  });
});
