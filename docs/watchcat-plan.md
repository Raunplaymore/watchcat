# watchcat 계획

## 목표

`watchcat`은 음성 명령을 받으면 XIAO ESP32S3 Sense 카메라가 사진을 촬영하고, Raspberry Pi 5의 Hailo가 사진에 고양이가 있는지를 판정하는 시스템이다. 결과와 최근 사진은 Raspberry Pi의 웹 서버에서 확인한다.

## 장치 역할

| 장치 | 역할 | 장기 운영 필수 여부 |
|---|---|---|
| XIAO ESP32S3 Sense | OV3660 촬영, JPEG를 Pi로 전송 | 필수 |
| Raspberry Pi 5 + Hailo | 음성 명령 처리, 사진 수신, Hailo 추론, 웹 UI와 결과 보관 | 필수 |
| ReSpeaker | `고양이 어디있나` 음성 명령을 Pi에 전달 | 필수 |
| 메인 ESP32-S3 + TFT + 버튼 | 개발 중 상태·결과를 물리 화면에서 확인 | 개발 단계용 |

메인 ESP32-S3 개발보드는 현재 검증된 TFT 배선을 유지하기 위해 사용한다. XIAO의 카메라 확장 보드는 TFT의 현재 GPIO 10, 11, 15, 16과 충돌하므로, 최종 운영에서 XIAO에 TFT를 병합하지 않는다.

## 최종 데이터 흐름

```text
ReSpeaker
  → Raspberry Pi 음성 명령 서비스
  → XIAO 카메라에 촬영 요청
  → JPEG 업로드
  → Pi의 watchcat 게이트웨이
  → hailo-camera 파일 추론
  → 고양이 결과·최근 이미지 저장
  → Pi 웹 UI 및 개발용 TFT 상태 표시
```

XIAO와 Pi는 같은 Wi-Fi에서 통신한다. Pi가 최종 상태의 기준점이며, XIAO는 고양이 판정이나 웹 화면을 직접 담당하지 않는다.

## 기존 hailo-camera 보호 원칙

- 기존 골프 캡처, 세션, MJPEG 프리뷰, 환경변수 기본값을 바꾸지 않는다.
- watchcat 사진은 `/home/ray/uploads/watchcat/`처럼 별도 하위 폴더에 원자적으로 저장한다.
- watchcat의 업로드·상태·웹 API는 별도 게이트웨이 서비스와 별도 포트로 제공한다.
- Hailo를 별도 프로세스에서 직접 점유하지 않는다. 기존 `hailo-camera`의 파일 추론 API와 큐를 사용한다.
- `AI_POSTPROCESS_CONFIG` 같은 전역 골프 설정을 watchcat 때문에 변경하지 않는다.
- `watchcat-cat`이라는 명시적 모델 옵션을 최소 추가한다. 이 옵션만 `yolov8s_nms.json`의 `cat` 전용 라벨 설정을 사용한다.
- watchcat의 실패, 대기열 지연, 재시도는 watchcat 상태에만 기록하며 기존 캡처 작업을 중단시키지 않는다.

## API 계약 초안

### XIAO 카메라 API

Pi가 XIAO에 호출한다.

- `POST /api/v1/capture`
  - JPEG 한 장을 촬영하고 Pi watchcat 게이트웨이로 업로드한다.
  - 응답: `202`와 촬영 요청 ID. 업로드·추론 완료를 기다리지 않는다.
- `GET /api/v1/status`
  - 카메라 준비 여부, Wi-Fi 상태, 마지막 촬영/업로드 오류를 반환한다.

### Pi watchcat 게이트웨이 API

XIAO와 TFT/웹 UI가 호출한다.

- `POST /api/v1/frames`
  - `Content-Type: image/jpeg`의 사진을 수신한다.
  - 인증 헤더와 촬영 시각·카메라 ID 헤더를 검증한다.
  - 사진을 저장한 뒤 기존 `hailo-camera` 파일 추론 API에 `watchcat-cat` 모델로 요청한다.
- `GET /api/v1/status`
  - `cameraOnline`, `inferenceState`, `catPresent`, `confidence`, `capturedAt`, `processedAt`, `lastError`를 반환한다.
- `GET /api/v1/latest.jpg`
  - 최근 사진을 반환한다.
- `POST /api/v1/capture`
  - 개발용 TFT 또는 Pi 웹 UI의 요청을 XIAO 카메라의 촬영 API로 전달한다.

Wi-Fi SSID, 비밀번호, Pi 주소, API 토큰은 코드에 넣지 않고 각 장치의 로컬 설정 파일/환경변수로 관리한다.

## 단계별 범위와 완료 기준

### Phase 0 — 기준 상태와 격리

목표: 기존 `hailo-camera`를 보존한 상태에서 개발을 시작한다.

- 기존 smoke test와 골프 캡처/추론의 기준 결과를 기록한다.
- `watchcat-cat` 모델 옵션이 기존 기본 모델과 독립적으로 고양이만 반환하도록 테스트한다.
- Hailo 파일 추론 큐에 요청이 직렬화되는지 확인한다.

완료 기준: watchcat 관련 설정을 적용하지 않은 기존 흐름이 기존과 동일하게 동작한다.

### Phase 1 — 사진 한 장의 전체 경로

목표: XIAO 사진 한 장을 Hailo가 판정한다.

- XIAO가 OV3660에서 JPEG를 촬영한다.
- XIAO가 Pi 게이트웨이에 사진을 업로드한다.
- 게이트웨이가 사진을 별도 경로에 저장하고 Hailo 파일 추론을 요청한다.
- 고양이 유무·신뢰도·시각이 상태 API와 웹 UI에 표시된다.

완료 기준: 실제 고양이 사진과 비고양이 사진을 각각 전송해 `catPresent` 결과와 최근 사진을 Pi 웹 UI에서 확인한다.

### Phase 2 — 개발용 TFT와 버튼

목표: 물리 장치에서 Phase 1 결과를 확인하고 촬영을 시작한다.

- 메인 ESP32-S3가 TFT, 3개 버튼, debounce를 초기화한다.
- TFT는 `CAT FOUND`, `NO CAT`, `CAMERA OFFLINE`, `INFERENCE WAITING`, `ERROR`를 표시한다.
- 버튼 1은 즉시 촬영 요청, 버튼 2는 상태/최근 결과 화면 전환, 버튼 3은 자동 촬영 시작·정지에 사용한다.
- TFT 핀은 GPIO 15/16/9/10/11, 버튼은 GPIO 5/6/7, `tft.init(240, 280)`, `tft.setRotation(2)`를 유지한다.

완료 기준: 버튼으로 촬영을 시작하고, Pi의 추론 결과가 TFT와 웹 UI에 일치하게 표시된다.

### Phase 3 — 음성 명령

목표: ReSpeaker 명령이 사진 촬영을 시작한다.

- ReSpeaker를 Pi의 음성 명령 서비스 입력으로 사용한다.
- 허용 문구는 `고양이 어디있나`로 시작하며, 인식 결과에 confidence/재시도 정책을 둔다.
- Pi가 카메라에 Phase 1의 촬영 API를 호출한다.
- 음성 명령, 촬영 요청, 추론 결과를 하나의 요청 ID로 기록한다.

완료 기준: 허용 문구를 말한 뒤 사람이 버튼을 누르지 않아도 새 사진·추론 결과가 Pi 웹 UI에 나타난다.

### Phase 4 — 운영 안정화

목표: 장기 설치 환경에서 복구 가능하게 동작한다.

- XIAO와 Pi의 Wi-Fi 재연결
- Hailo 대기열 제한과 타임아웃
- 최근 사진 보관 수·디스크 정리
- 전원 재시작 후 자동 복구
- 고양이/비고양이 실제 환경 오탐·미탐 기록

### Phase 5 — 사진 반복 및 영상 확장

목표: Phase 4가 안정된 뒤 더 빠른 탐색으로 확장한다.

- 반복 사진 간격을 조절한다.
- 필요할 때만 MJPEG 또는 영상 프레임 처리로 확장한다.
- Phase 1의 사진 업로드·추론 API를 유지해 하위 호환성을 보장한다.

## 미확정 사항

- ReSpeaker의 정확한 모델과 Pi 연결 방식(USB, HAT 등)
- 한국어 문구 인식 엔진과 오프라인/온라인 사용 여부
- Pi의 고정 IP 또는 mDNS 이름
- 사진 해상도, JPEG 품질, 촬영 후 추론 타임아웃
- `catPresent=true`로 판단할 최소 신뢰도
