# macOS 지원 가이드

## 지원 범위

- Chrome 114 이상에서 사이드 패널, 탭 분석, 직접 이미지 다운로드, 작업 기록을 지원합니다.
- YouTube/X/Vimeo 영상, 재생목록 스크립트, `WebP로 통일`을 선택한 X 이미지 작업은 로컬 Media Helper를 사용합니다.
- `다운로드 폴더 열기`는 Helper가 Finder의 `open` 명령을 호출합니다.
- DRM, 유료 접근 우회, 비공개 콘텐츠 우회는 지원하지 않습니다.

## 요구 사항

- macOS와 Google Chrome 114 이상
- Node.js 18 이상
- 최신 `yt-dlp`
- FFmpeg

Homebrew 사용 시 다음 명령으로 설치할 수 있습니다.

```bash
brew install node yt-dlp ffmpeg
```

## 설치

1. Chrome의 `chrome://extensions`에서 개발자 모드를 켭니다.
2. **압축해제된 확장 프로그램을 로드합니다**로 프로젝트 루트를 선택합니다.
3. 표시된 확장 ID가 `nccjgbgpcokjhaalfdbfmkomielehekd`인지 확인합니다.
4. 터미널에서 다음을 실행합니다.

```bash
chmod +x ./native-helper/install-macos.sh ./native-helper/start-macos.sh
./native-helper/install-macos.sh nccjgbgpcokjhaalfdbfmkomielehekd
```

설치 위치는 `~/Library/Application Support/TabDownloaderAMediaHelper`이고 LaunchAgent 식별자는 `com.tabdownloadera.media-helper`입니다. 기존 탭 다운로더의 Helper와 별도로 설치되며 기존 Helper를 변경하지 않습니다. Helper는 외부 인터페이스가 아닌 `127.0.0.1:17385`에만 바인딩됩니다.

## 확인

```bash
curl -fsS http://127.0.0.1:17385/hello
npm test
npm run check
```

응답의 `data.platform`이 `darwin`인지 확인합니다. 그다음 공개 이미지 게시물 하나와 짧은 공개 영상 하나를 이용해 다음을 확인합니다.

1. 현재 탭 분석
2. 제목·미디어 개수
3. 파일 다운로드와 확장자
4. 다운로드 기록
5. Finder 폴더 열기
6. Chrome 재시작 후 Helper 재연결

## 문제 해결

- Helper 로그: `~/Library/Application Support/TabDownloaderAMediaHelper/helper.stderr.log`
- 수동 시작: `./native-helper/start-macos.sh`
- LaunchAgent 상태: `launchctl print gui/$(id -u)/com.tabdownloadera.media-helper`
- 제거: `./native-helper/install-macos.sh --uninstall`

macOS에서 실제 회귀 검증이 끝나기 전까지는 이 지원 상태를 `implementation complete / hardware verification pending`으로 관리합니다.
