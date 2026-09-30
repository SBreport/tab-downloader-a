# 유튜브 채널 목록 다운로드 — 구현 계획 & 진행 트래커

기준 커밋: `60f1545` (v0.7.6) / 작성 2026-07-21
역할: Opus = 기획·브리프·diff 검수 / Sonnet(coder) = 구현 / 매 Phase 검증 후 다음 진행

## 확정된 결정
- 진입: **현재 탭(채널 페이지)에서 [분석]** — 별도 채널 입력창 없음.
- 범위: **최근 50개 + "더 불러오기"** (offset 페이징).
- 롱폼/숏폼: yt-dlp `/videos`·`/shorts` 탭을 각각 조회해 자연 분리. 길이 추정 분류 안 함.
- 다운로드: 선택 영상마다 **기존 단일영상 yt-dlp 잡을 N개** 생성(재사용). `--playlist-items` 묶음 안 씀.

## 목표 흐름
```
채널 탭(@handle / /videos / /shorts) → [분석]
  → background가 헬퍼 /probe-channel 호출 (content script는 CORS로 헬퍼 직접 못 부름)
  → yt-dlp --flat-playlist (videos + shorts, 최근 50)
  → 사이드패널 [롱폼][숏폼] 그룹 체크박스 목록 (+더 불러오기)
  → 체크 → [다운로드] → 영상당 native 잡 → 히스토리 카드 N개
```

## 핵심 계약 (구현 기준)

### 어댑터 channel-listing 마커 (content/adapters/youtube.js → analyzer가 감쌈)
```js
{ backend:"native", type:"youtube", kind:"channel-listing",
  channel:{ url: canonicalChannelUrl, name },
  assets:[], complete:false, warnings:[] }
```

### 헬퍼 엔드포인트 POST /probe-channel
- 요청: `{ url, limit=50, offset=0 }`
- 실행: `yt-dlp --flat-playlist --dump-single-json --no-warnings --playlist-start <offset+1> --playlist-end <offset+limit> --socket-timeout 20 --extractor-retries 2 <tabUrl>` (videos·shorts 각 1회)
- 응답: `{ longform:[{id,title,duration,url}], shorts:[...], hasMore:{longform,shorts} }`
- 썸네일은 클라에서 `https://i.ytimg.com/vi/<id>/hqdefault.jpg` 조합(fetch 안 함)
- **URL 검증**: 신규 `validateChannelUrl`(채널/@handle/user/c 허용). 기존 `validateMediaUrl`(server.cjs:72-84) 불변.

### 다운로드 asset (선택 영상 1개)
```js
{ delivery:{ mode:"native", engine:"yt-dlp", pageUrl:"https://www.youtube.com/watch?v=<id>" } }
```
→ 기존 `startNativeDownloadJob()`(sw.js:370) 재사용, 영상당 잡 1개.

### 메시지 타입 (신규)
- `PROBE_CHANNEL` (sidepanel→background→헬퍼 /probe-channel). 기존 `PROBE_NATIVE_MEDIA` 패턴 복제.

## 진행 체크리스트

### Phase 1 — 헬퍼 채널 목록 엔드포인트  [x] 완료 (검증됨)
- [x] `POST /probe-channel` 라우트 + 핸들러 (server.cjs:562)
- [x] `validateChannelUrl` 신설 (validateMediaUrl 불변 — diff 추가만 확인)
- [x] 채널 base URL 정규화 → /videos·/shorts (`channelTabUrls`, 어느 탭 진입해도 둘 다 생성)
- [x] flat-playlist `capture()` + entries 파싱 → longform/shorts/hasMore
- [x] `/probe`·`/start`의 `--no-playlist` 불변 확인
- [~] 스모크: server.cjs 즉시 listen 구조라 requireable 아님 → module.exports 추상화는 과함, skip. 대신 순수 파싱 로직 assert 검증 PASS(별도 실행)
- 검증완료: diff 추가만(64줄), `node --check` OK, `capture()` 시그니처 일치, 파싱 accept/reject/정규화 assert PASS

### Phase 2 — YouTube 어댑터 채널 모드  [x] 완료 (검증됨)
- [x] match() 채널 추가 — `channelPathname()` 지역함수(@handle/videos/shorts, /channel, /c, /user; segment 수 가드로 /community·/x/y 제외)
- [x] extract() 채널 분기 → channel-listing 마커. canonicalize/key도 채널 base 처리. 개별영상 경로 불변
- [x] catalog pathRegex 확장: `@[^/?#]+|channel/|c/|user/` 추가
- [~] static-check match 케이스: 원래 youtube match 테스트 없음 → skip
- 검증완료: 목업으로 채널 match/canonicalize/extract 마커 PASS, `/community`·`/results` 제외, 단일영상(match/canon/key/extract) 회귀 없음, catalog JSON 유효(89 entries)

> **Phase 5 필수**: `tests/static-check.mjs:11`이 `manifest.version==="0.7.5"` 하드코딩인데 실제 0.7.6 → 기존부터 깨진 테스트. 버전 범프 시 이 assert도 갱신(또는 manifest 참조로 완화).

### Phase 3 — 사이드패널 다중선택 UI (최대 작업)  [x] 완료 (검증됨)
- [x] renderAnalysis 분기: kind==="channel-listing" → 조기 return
- [x] PROBE_CHANNEL 왕복 (sidepanel.js fetchChannelPage + service-worker 핸들러, PROBE_NATIVE_MEDIA 패턴 복제)
- [x] [롱폼][숏폼] 그룹 + 그룹 전체선택 + 항목 체크박스+썸네일(i.ytimg)+제목+길이(m:ss)
- [x] 더 불러오기(offset+=50) + id dedup append + 선택 유지
- [x] 선택 개수 + [선택 다운로드] (Map `${kind}:${id}`)
- [x] 품질 select 재사용 (nativeOptions 위치 이동 + 기존 280행 toggle로 비-native 재hide 확인)
- 검증완료: node --check OK, 응답 shape 일치, 선택 계약 `{id,url,title,kind}`, nativeOptions 잔상버그 없음(280행), 일반/이미지/range 회귀 없음(조기return). 실채널 e2e는 Phase 5 후 수동 런 필요

### Phase 4 — 선택 N개 다운로드  [x] 완료 (검증됨)
- [x] handleChannelDownload: 선택 영상마다 단일영상 analysis 만들어 START_DOWNLOAD 루프
- [x] service-worker 변경 불필요 — startNativeDownloadJob이 yt-dlp 단일 asset 처리, 영상당 잡 1개로 100% 재사용
- [~] 채널명 상위 폴더: skip(각 영상=기존 단일영상과 동일 저장 위치). 완료 메시지에 채널명만 표기. ponytail: 필요시 추가
- 검증완료: node --check OK, per-video analysis가 assertAnalysis(assets 1개+complete:true) 충족, SW diff에 Phase4 변경 0. 실다운로드 e2e는 수동 런 필요
- 알려진 상한: N개 동시 잡(ponytail 주석). 대량 선택 시 순차 큐 전환 여지

### Phase 5 — 마감  [x] 완료 (검증됨)
- [x] 버전 0.8.0 일괄 범프: manifest, package.json, sidepanel.html eyebrow, static-check:11, helper /hello
- [x] static-check stale assert(0.7.5→0.8.0) 수정 → `npm run check` 통과
- [x] CHANGELOG 0.8.0 항목 + README(지원표/사용법/보안 섹션)
- [x] `npm test` 45/46 통과. 1 실패는 FFmpeg libwebp 인코더 미설치(환경, image-converter — 우리 변경 무관)
- 검증완료: static-check PASS, 버전 전수 0.8.0 통일, 전체 diff 12파일

## e2e 검증 결과 (2026-07-21)
- [x] **Helper 0.8.0 재설치 완료** — `install-macos.sh nccjgbgpcokjhaalfdbfmkomielehekd`, `/hello` 0.8.0 확인(이전 0.6.0).
- [x] **백엔드 실 e2e PASS** (실제 yt-dlp + @MrBeast 실채널 + 실 CORS):
  - `/probe-channel` limit=5 → 롱폼 5·숏폼 5, hasMore 둘 다 true, 스키마 정확(id/title/duration/watch URL)
  - 숏폼 duration null 우아 처리
  - offset=5 페이징 → 다른 id, 중복 없음
  - 비-채널(watch) URL 거부, evil.com 오리진 403 차단, 오리진 없는 요청은 기존 `/probe`와 동일(127.0.0.1 전용, 회귀 아님)

## 남은 것 (사용자만 가능 — UI e2e)
- 크롬에 확장 로드 후 실제 채널 탭에서 [분석] → 목록 렌더/체크박스/더 불러오기 버튼 동작 확인.
- 영상 몇 개 체크 → [선택 다운로드] → 히스토리 카드 N개 진행·MP4 실제 저장 확인.
- 확인 권장: 대형 채널 50개 로드 속도, 멤버십/비공개 영상 선택 시 개별 잡 failed 처리, 다수 선택 시 동시 다운로드 부하.

## 리스크
- yt-dlp 설치 전제(기존과 동일, 신규 부담 없음)
- 대형 채널 throttle — 50 flat-playlist는 가벼움, offset 남발만 주의
- flat-playlist duration null 가능 → 있으면 표시, 분류엔 미사용
- 멤버십/회원 영상 다운로드 실패 → 기존 failed 잡으로 처리
