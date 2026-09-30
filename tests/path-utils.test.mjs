import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadFilename, sanitizeComponent, sanitizeRoot } from "../shared/path-utils.js";

test("Windows에서 사용할 수 없는 문자를 안전하게 바꾼다", () => {
  assert.equal(sanitizeComponent('A<B>:C"D/E\\F|G?H* '), "A_B__C_D_E_F_G_H_");
  assert.equal(sanitizeComponent("CON"), "_CON");
});

test("상위 경로 이동을 제거한다", () => {
  assert.equal(sanitizeRoot("../My/../Images"), "My/Images");
  assert.equal(sanitizeRoot(""), "탭 다운로더 A");
});

test("사이트 타입 폴더를 정확히 한 번만 붙인다", () => {
  assert.equal(
    buildDownloadFilename("saved_media", "twitter", "제목", "0001.jpg"),
    "saved_media/twitter/제목/0001.jpg",
  );
  assert.equal(
    buildDownloadFilename("saved_media_twitter", "twitter", "제목", "0001.jpg"),
    "saved_media_twitter/제목/0001.jpg",
  );
});
