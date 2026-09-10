import { readFile } from 'node:fs/promises';
import { database } from './database.js';

async function readSchema(): Promise<string> {
  const candidates = [
    new URL('./schema.sql', import.meta.url),
    new URL('../src/schema.sql', import.meta.url)
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('schema.sql was not found');
}

try {
  await database.query(await readSchema());
  console.log('Database schema is ready.');
} finally {
  await database.end();
}
