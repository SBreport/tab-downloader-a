#!/usr/bin/env node
// 배포용 zip 생성: dist/tab-downloader-a-v<version>.zip
// git archive HEAD 기반 — .git 제외, 커밋된 상태를 그대로 패키징(어제 릴리스 자산과 동일 구성).
// 의존성 0 (node + git만 사용, 크로스플랫폼).
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
const out = join(root, 'dist', `tab-downloader-a-v${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });

// HEAD 기준 ZIP이므로 미커밋 변경은 먼저 저장해야 한다.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
if (dirty) {
  throw new Error('커밋하지 않은 변경이 있습니다. 커밋 후 패키징하세요.');
}

execFileSync('git', ['archive', '--format=zip', '-o', out, 'HEAD'], { cwd: root });
console.log(`생성됨: dist/tab-downloader-a-v${version}.zip`);
