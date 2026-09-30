import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('A PiP는 기존 버튼을 중복 생성하지 않고 기존 버튼이 없으면 표시한다', () => {
  for (const existing of [null, {}]) {
    let prepended = 0;
    const controls = { prepend() { prepended++; } };
    const node = () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} });
    const document = {
      body: {}, pictureInPictureEnabled: true,
      createElement: node, createElementNS: node,
      getElementById: () => existing,
      querySelector: (selector) => selector.includes('right-controls') ? controls : { readyState: 1 },
      addEventListener() {},
    };
    vm.runInNewContext(fs.readFileSync(new URL('../content/youtube-pip.js', import.meta.url), 'utf8'), {
      document, location: { pathname: '/watch' },
      MutationObserver: class { observe() {} },
    });
    assert.equal(prepended, existing ? 0 : 1);
  }
});
