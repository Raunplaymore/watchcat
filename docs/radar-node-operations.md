# 레이더 노드 운영 노트 (Phase R1)

설계: `docs/ld2454-cat-tracker-design.md` · 프로토콜 실측: `docs/ld2454-r0-observations.md`

## 구성

```text
LD2454 ─UART(256000)─> XIAO ESP32C3 (radar_node_c3) ─HTTPS 4Hz─> Pi gateway :3102
                                                                    │
                                          radar.linkus-plz.com ────┤ 부채꼴 지도
                                          watchcat-api.…/radar  ────┤ (같은 페이지)
                                          watchcat-api.… 메인 페이지 ─┘ 요약 한 줄
```

- 배선: 5V(검정)→VBUS · G(빨강)→GND · T(흰색)→D7/GPIO20 · **R(노랑)은 미연결이 기본**
  (부팅 차단 함정 — R0 문서 참조)
- 센서 ID: `living-room-radar-1` (`WATCHCAT_RADAR_SENSOR_ID`로 변경,
  게이트웨이 `WATCHCAT_RADAR_SENSORS` 허용 목록과 일치해야 함 — 미설정이면 전부 허용)
- 전원: USB 5V. **보조배터리는 저전류(~100mA) 자동 차단됨** — 이동 테스트는
  저전류 모드 있는 배터리나 벽 어댑터로.

## 상태 읽는 법 (지도 페이지 상단)

| 표시 | 뜻 | 첫 의심 |
|---|---|---|
| 🟢 레이더 온라인 | 노드·레이더 모두 정상 | — |
| 🟠 노드 온라인 · 레이더 무신호 | C3는 전송 중, 레이더 프레임 없음 | 레이더 배선(T선)·전원, R핀 부팅 차단 |
| 🔴 레이더 오프라인 | 노드 배치가 3초 이상 없음 | 노드 전원(보조배터리!), Wi-Fi 범위 |

지도: 부채꼴 꼭짓점=센서, ±60° 시야, 1m 링, 2/4/8m 줌. 초록 점=현재 타겟,
옅은 점=10초 잔상, 원=몸집 버블(±cm = 3초 창 직선 경로 대비 RMS 흔들림).

## 몸집 버블의 한계 (실측 2026-08-21)

사람 보행: 중앙값 ±2.5cm · 상위25% ±4.2cm · 최대 ±15.8cm. 레이더 내부 트래커가
반사점 배회를 스무딩하므로 **고양이/사람 판별 신호로는 부족**하다. 판별은
① 예비 모듈 2단 설치(1.5m 높이에 하나 더 — 위에 걸리면 사람) 또는 ② 카메라
확인(`catConfirmed`)으로 한다. 고양이 기준선은 미수집.

## 배포 방법

- **게이트웨이**: 로컬에서 push → `ssh rasp-pi 'git -C /home/ray/watchcat pull'`
  → `sudo systemctl restart watchcat-gateway`
- **노드 펌웨어**: `pio run -e radar_node_c3 -t upload --upload-port <포트>`
  (C3는 VID:PID 303A:1001, SER `AC:27:6E:81:A2:54` — 캣센서 XIAO S3와 SER로 구분)
- **도메인 추가 시**: `/etc/cloudflared/config.yml` ingress에 hostname 추가 →
  `cloudflared tunnel route dns 8789855e-… <호스트명>` → `sudo systemctl restart cloudflared`

## 진단 도구

- `radar_probe_c3` env: 수신 전용 관찰 도구. 부팅 시 **RX 선 레벨**을 출력해
  (100/100 high = 레이더 통전·연결, 0/100 = 선 끊김/무전원) 침묵 원인을 가른다.
- 게이트웨이 상태: `curl https://watchcat-api.linkus-plz.com/api/v1/radar/status`
- 노드 시리얼 Health 줄: `frames/bad/sends/wifi/targets/heap` 5초마다.

## 다음 단계 후보

1. 오월이 몸집 버블 기준선 수집 (참고용)
2. 2단 레이더 — 예비 모듈을 1.5m에 추가해 높이 구분 (C3 UART 2개로 보드 추가 불필요)
3. Phase R2 — 방 좌표 변환, 구역(zone) 편집, 이벤트 이력, SQLite 보관
4. Phase R3 — 관심 구역 진입 시 카메라 촬영 연동
