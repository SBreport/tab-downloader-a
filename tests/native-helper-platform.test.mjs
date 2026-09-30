import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { folderOpenCommand, folderOpenSpawnOptions } = require("../native-helper/platform.cjs");

test("운영체제별 기본 파일 관리자를 선택한다", () => {
  assert.equal(folderOpenCommand("darwin"), "/usr/bin/open");
  assert.equal(folderOpenCommand("linux"), "xdg-open");
  assert.equal(folderOpenCommand("win32", { WINDIR: "D:\\Windows" }), "D:\\Windows\\explorer.exe");
});

test("폴더 열기 프로세스는 사용자에게 창을 숨기지 않는다", () => {
  assert.deepEqual(folderOpenSpawnOptions(), {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
});
