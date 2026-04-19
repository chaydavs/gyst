import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';
import { runSelfDocumentPhase1, runSelfDocumentPhase2 } from '../../src/cli/commands/self-document.js';

const TEST_DB = '/tmp/gyst-test-self-doc.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('runSelfDocumentPhase1', () => {
  test('creates structural entries and returns counts', async () => {
    const db = initDatabase(TEST_DB);
    const result = await runSelfDocumentPhase1(db, process.cwd());
    expect(typeof result.created).toBe('number');
    expect(typeof result.updated).toBe('number');
    expect(result.created).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe('runSelfDocumentPhase2', () => {
  test('ingests MD files and returns counts', async () => {
    const db = initDatabase(TEST_DB);
    const result = await runSelfDocumentPhase2(db, process.cwd());
    expect(typeof result.created).toBe('number');
    expect(result.created + result.updated + result.skipped).toBeGreaterThan(0);
    db.close();
  });
});
