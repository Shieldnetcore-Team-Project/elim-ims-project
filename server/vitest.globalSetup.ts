import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(dirname, '.vitest-tmp');

// Runs once before the whole suite, in its own process — gives every test run
// a clean throwaway database instead of accumulating rows run over run.
export default function setup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
}
