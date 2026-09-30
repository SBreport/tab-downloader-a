# 확장프로그램 동작 구조와 이식 가이드

## 전체 흐름

```text
현재 탭 URL
  → engine-catalog.json에서 후보 판별
  → 해당 adapterScript만 탭에 주입
  → DOM 분석 결과인 MediaPlan 생성
  → delivery.mode에 따라 분기
      direct: Chrome downloads + Referer 규칙
      native: 로컬 Media Helper → yt-dlp/FFmpeg 또는 제한된 HTTP 이미지 엔진
  → Downloads/<기본 폴더>/<어댑터>/<제목>/ 저장
  → job:<id> + downloadJobHistory에 상태 기록
```

핵심 원칙은 **사이트 분석**과 **파일 전달 방식**을 분리하는 것입니다. 사이트마다 제목·원본 URL·순서를 찾는 법은 달라도, 분석 뒤에는 같은 `MediaPlan` 형태를 사용합니다.

## 주요 파일

| 파일 | 역할 |
|---|---|
| `catalog/engine-catalog.json` | YouTube·X·Vimeo URL 범위와 어댑터 파일 경로 |
| `content/adapter-runtime.js` | 어댑터 등록소와 공통 URL·파일명 유틸리티 |
| `content/adapters/*.js` | 사이트별 URL 판별과 DOM 추출 |
| `content/analyzer.js` | 현재 URL에 맞는 동기·비동기 어댑터를 실행해 MediaPlan 반환 |
| `sidepanel/sidepanel.js` | 카탈로그 판별, 권한 요청, 결과·품질 선택 UI |
| `background/service-worker.js` | 직접 다운로드와 Helper 작업 생성·상태 저장, 재생목록 자막 작업 중계 |
| `native-helper/server.cjs` | 로컬 전용 영상 분석·다운로드 서버 |
| `shared/path-utils.js` | Windows 안전 파일명과 타입 폴더 중복 방지 |

## MediaPlan 계약

직접 이미지 예시:

```javascript
{
  schemaVersion: 1,
  type: "site_id",
  siteName: "표시 이름",
  backend: "chrome",
  title: "게시물 제목",
  complete: true,
  warnings: [],
  assets: [{
    id: "0001",
    kind: "image",
    url: "https://cdn.example/original.jpg",
    referer: "https://example/post/1",
    filename: "0001.jpg",
    delivery: { mode: "direct" }
  }]
}
```

Helper 영상 예시:

```javascript
{
  type: "youtube",
  backend: "native",
  title: "영상 제목",
  complete: true,
  assets: [{
    kind: "video",
    filename: "영상 제목.mp4",
    delivery: {
      mode: "native",
      engine: "yt-dlp",
      pageUrl: "https://www.youtube.com/watch?v=..."
    }
  }]
}
```

X처럼 한 게시물 URL에서 영상 여러 개를 내려받는 경우 `assets`에는 Helper 작업 하나만 넣고 `mediaCount`와 `expectedCount`에 실제 항목 수를 기록합니다. Helper가 `yt-dlp`의 playlist 항목을 `0001`, `0002`로 펼칩니다.

X 사진에서 WebP 변환을 선택하면 `http-images` Helper 엔진을 사용합니다. 이미지 호스트, 게시물 Referer, MIME, 크기와 최종 리디렉션 URL을 검증합니다. A의 이미지 정책은 X만 허용합니다.

`imageFormat`은 `original` 또는 `webp`만 허용합니다. WebP 원본은 그대로 이동하고 다른 정적 이미지는 FFmpeg `libwebp` 무손실 모드, GIF는 `libwebp_anim`으로 변환합니다. 다운로드 중간 파일과 변환 중간 파일은 작업별 이름을 쓰며 성공 시 결과만 남기고 실패·취소 시 정리합니다.

Helper 다운로드는 Chrome 다운로드 기록에 등록되지 않습니다. 작업 상태의 `outputDirectory`를 패널에 표시하고 `/open-folder`로 탐색기를 실행합니다. 이 API는 경로를 정규화한 뒤 사용자 `Downloads` 하위인지, 실제 디렉터리인지 다시 검사합니다. Chrome 직접 다운로드 작업은 서비스 워커가 만든 안전한 `relativeDirectory`를 사용합니다.

## 자체 다운로드 기록

- 각 작업은 `chrome.storage.local`의 `job:<UUID>`에 저장합니다.
- `downloadJobHistory`에는 최신 순서의 작업 ID를 최대 50개 보관합니다.
- 직접 다운로드 실패 시 실패한 asset만 `failedAssets`에 남겨 재시도합니다.
- Helper 작업은 허용된 페이지 URL과 품질로 구성한 제한된 `retrySpec`을 저장합니다.
- 취소는 Chrome download ID 또는 Helper `/cancel`로 실제 진행 작업을 먼저 중지한 뒤 `canceled` 상태를 기록합니다.
- 기록 삭제는 종료 상태의 `job:<UUID>`만 지우며 다운로드 파일에는 접근하지 않습니다.
- 같은 작업의 완료 이벤트는 job별 직렬 큐에서 갱신하며, download ID 매핑과 기록 인덱스도 각각 직렬화해 동시 이벤트의 증가분 유실을 막습니다.
- 서비스 워커 시작과 기록 조회 때 남은 Chrome download ID를 재조회합니다. Helper 재시작으로 메모리 작업이 사라진 경우 기존 작업을 실패로 확정해 재시도·삭제할 수 있게 합니다.

## 신규 영상 사이트 이식 순서

영상 사이트는 먼저 `yt-dlp --dump-single-json --skip-download <URL>`이 현재 환경에서 지원되는지 확인합니다.

- 지원되면 YouTube 어댑터처럼 페이지 URL만 MediaPlan에 넣고 Helper가 포맷·다운로드를 담당하게 확장합니다.
- X 사진처럼 공개 원본 CDN URL이 DOM에 있으면 영상과 분리해 `direct` 방식으로 처리합니다.
- 쿠키가 필요한 사이트는 쿠키 전달 범위와 저장 정책을 별도로 설계해야 하며 자동으로 브라우저 쿠키를 읽지 않습니다.
- HLS/DASH 라이브는 재시도, 중단, 파일 마무리, 방송 종료 조건이 일반 영상과 달라 별도 작업 유형으로 구현합니다.
- DRM 또는 유료 접근 우회는 지원하지 않습니다.

새 영상 도메인을 Helper에 추가할 때는 `server.cjs`의 URL 허용 규칙도 함께 좁게 확장해야 합니다. 카탈로그만 추가해서 임의 URL을 로컬 명령에 전달하면 안 됩니다. 서비스 워커의 `assertAnalysis` 허용 타입도 함께 검토해야 합니다.

## 상태 값

- `candidate`: 기존 엔진 인벤토리에만 등록, 확장프로그램에서는 실행하지 않음
- `testing`: 어댑터가 있으나 실제 페이지 회귀 확인 중
- `verified`: URL 판별·분석·실다운로드 확인 완료
- `legacy`: 기존 엔진에는 있었으나 현재 도메인/구조가 오래되어 재조사가 필요

기능 추가 후에는 `README.md`와 `CHANGELOG.md`에도 사용자 관점의 변경 내용을 기록합니다.
