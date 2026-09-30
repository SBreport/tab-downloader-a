# 탭 다운로더 A

YouTube, X/Twitter, Vimeo용 Chrome 확장프로그램입니다. 현재 버전은 **0.11.0**입니다.

## 지원 기능

- YouTube 개별 영상·Shorts·라이브 URL 다운로드, 채널 롱폼·숏폼 선택 다운로드
- YouTube 영상 스크립트 복사·TXT 저장, 공개 재생목록 스크립트 일괄 저장(최대 100개)
- X/Twitter 개별 게시물의 원본 사진·다중 영상 다운로드
- Vimeo 직접 영상 및 현재 페이지에 삽입된 Vimeo iframe 영상 다운로드
- 영상 품질 선택, X 이미지 원본 유지·WebP 변환, YouTube PiP
- 순차 대기열, 대기 순서 변경·제거·다음 작업 일시정지, 기록·취소·실패 재시도·폴더 열기

일반 페이지에서는 Vimeo iframe만 탐색합니다.

## 설치 — 공유받은 ZIP 기준

1. ZIP을 계속 보관할 폴더에 압축 해제합니다. 설치 후 폴더를 이동하거나 삭제하지 마세요.
2. Chrome에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**에서 `manifest.json`이 있는 폴더를 선택합니다.
4. 확장 이름 **탭 다운로더 A**, ID `nccjgbgpcokjhaalfdbfmkomielehekd`를 확인합니다.
5. 영상 다운로드·재생목록 스크립트·WebP 변환을 쓰려면 아래 A 전용 Media Helper를 설치합니다.

X 원본 사진 다운로드와 YouTube 개별 스크립트·PiP는 Helper 없이 사용할 수 있습니다. 이 패키지는 Chrome 웹 스토어 설치본이 아닙니다.

### macOS Helper

Node.js 18 이상, yt-dlp, FFmpeg가 필요합니다. Homebrew 사용 시:

```sh
brew install node yt-dlp ffmpeg
```

터미널에서 압축 해제한 프로젝트 폴더로 이동한 뒤 실행합니다.

```sh
sh ./native-helper/install-macos.sh nccjgbgpcokjhaalfdbfmkomielehekd
```

로그인 시 자동 실행됩니다. 재시작·제거:

```sh
sh ./native-helper/start-macos.sh
sh ./native-helper/install-macos.sh --uninstall
```

### Windows Helper

Node.js 18 이상, yt-dlp, FFmpeg를 설치하고 `node`, `yt-dlp`, `ffmpeg`가 PATH에서 실행되는지 확인합니다. PowerShell에서 압축 해제한 프로젝트 폴더로 이동한 뒤 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native-helper\install.ps1 -ExtensionId nccjgbgpcokjhaalfdbfmkomielehekd
```

로그온 자동 실행 작업을 등록합니다. 등록 실패 시 `start.ps1`을 직접 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native-helper\start.ps1
```

제거:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native-helper\install.ps1 -ExtensionId nccjgbgpcokjhaalfdbfmkomielehekd -Uninstall
```

## 사용 및 업데이트

대상 페이지를 연 뒤 확장 아이콘 → **현재 탭 분석** → 품질 또는 이미지 형식 선택 → 다운로드 순으로 사용합니다. 채널에서는 받을 영상을 체크하고, 재생목록 스크립트는 패널에 링크를 입력합니다.

기본 저장 위치는 `Downloads/탭 다운로더 A/`입니다. 영상은 로컬 Helper가 저장하므로 Chrome 다운로드 목록 대신 사이드패널에서 진행률과 폴더를 확인합니다.

업데이트는 기존 폴더의 파일을 새 버전으로 교체하고 `chrome://extensions`에서 새로고침합니다. Helper 파일도 변경되었으면 설치 명령을 다시 실행합니다.

## 기존 버전과 함께 사용

| 항목 | A 전용 설정 |
|---|---|
| 확장 ID | `nccjgbgpcokjhaalfdbfmkomielehekd` |
| Helper 주소 | `http://127.0.0.1:17385` |
| Helper 설치 폴더·Windows 작업 이름 | `TabDownloaderAMediaHelper` |
| macOS LaunchAgent | `com.tabdownloadera.media-helper` |
| 기본 저장 폴더 | `탭 다운로더 A` |

A 설치·제거는 기존 버전 Helper를 중지하거나 제거하지 않습니다. YouTube 페이지 버튼은 기존 확장과 중복 표시되지 않도록 공통 ID를 확인합니다.

## 권한 및 처리 범위

현재 탭 분석에 사이트 접근 권한을 요청합니다. 임의 사이트의 Vimeo 삽입 영상을 찾기 위해 HTTP/HTTPS 선택적 권한 범위를 유지하며, 설치 시 고정 호스트 권한은 A Helper와 X 이미지 서버뿐입니다. Helper는 로컬 주소에만 바인딩하고 설정한 확장 ID의 요청을 허용합니다. 브라우저 쿠키를 자동으로 가져오지 않습니다.

접근 가능한 콘텐츠에만 사용하세요. 로그인·DRM·유료 접근 우회는 구현하지 않습니다. 사이트 변경이나 자막 제공 여부에 따라 분석·저장이 실패할 수 있습니다.

## 개발 및 공유 패키지

```sh
npm test
npm run check
npm run pack
```

`pack`은 **커밋된 HEAD**에서 `dist/tab-downloader-a-v0.11.0.zip`을 생성합니다. 미커밋 변경이 있으면 중단합니다. ZIP에는 Git 이력, 개인 설정, 로그, 비밀키, 다운로드 결과물이 포함되지 않습니다. Node.js·yt-dlp·FFmpeg는 수신자 환경에 별도 설치해야 합니다.

소스 저장소는 초기 비공개로 운영합니다. ZIP은 직접 전달할 수 있고, 비공개 저장소 링크를 공유할 경우 수신자에게 저장소 접근 권한이 필요합니다.

자동 테스트와 정적 검사로 분리 범위를 검증합니다. A의 실제 Chrome 설치 및 Windows/macOS 다운로드 확인은 별도로 진행해야 합니다.

[라이선스](LICENSE) · [고지](NOTICE.md) · [macOS 상세 안내](docs/MACOS.md)
