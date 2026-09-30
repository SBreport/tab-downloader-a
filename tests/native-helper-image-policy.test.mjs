import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const { imagePolicy, validateImageAssets } = createRequire(import.meta.url)('../native-helper/image-policy.cjs');
const asset = { url: 'https://pbs.twimg.com/media/AAA111?format=jpg&name=orig', filename: '0001.jpg', referer: 'https://x.com/example/status/123' };
test('A는 X 원본 이미지를 검증하고 외부 호스트·잘못된 Referer·경로 이동을 거부한다', () => {
  assert.equal(validateImageAssets('twitter', [asset])[0].url, asset.url);
  assert.equal(imagePolicy('twitter').contentType('image/jpeg'), true);
  assert.equal(imagePolicy('twitter').contentType('text/html'), false);
  for (const patch of [
    { url: asset.url.replace('pbs.twimg.com', 'example.com') },
    { url: asset.url.replace('name=orig', 'name=small') },
    { referer: 'https://example.com/' },
    { folder: '../escape' },
  ]) assert.throws(() => validateImageAssets('twitter', [{ ...asset, ...patch }]));
});
test('A Helper는 지원하지 않는 타입의 이미지 작업을 거부한다', () => {
  for (const type of ['unsupported_site', 'unknown_image']) {
    assert.throws(() => validateImageAssets(type, [asset]), /허용되지 않은 이미지 작업 타입/);
  }
});
