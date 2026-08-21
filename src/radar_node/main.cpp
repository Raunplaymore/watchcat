#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#include "watchcat_config.h"

// Phase R1 radar node (docs/ld2454-cat-tracker-design.md §10): decode LD2454
// frames and hand the gateway the latest batch. Frame format was verified on
// hardware in docs/ld2454-r0-observations.md — 30 bytes at ~16 Hz, values in
// sign-magnitude where a set MSB means positive.
#ifndef WATCHCAT_RADAR_SENSOR_ID
#define WATCHCAT_RADAR_SENSOR_ID "living-room-radar-1"
#endif
// The radar reaches the gateway the same way the camera does, so its URL and CA
// default to the camera-upload pair when the local config defines them.
#ifndef WATCHCAT_RADAR_BASE_URL
#ifdef WATCHCAT_CAMERA_UPLOAD_BASE_URL
#define WATCHCAT_RADAR_BASE_URL WATCHCAT_CAMERA_UPLOAD_BASE_URL
#else
#define WATCHCAT_RADAR_BASE_URL WATCHCAT_GATEWAY_BASE_URL
#endif
#endif
#ifndef WATCHCAT_RADAR_TLS_CA_CERT
#ifdef WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT
#define WATCHCAT_RADAR_TLS_CA_CERT WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT
#else
#define WATCHCAT_RADAR_TLS_CA_CERT WATCHCAT_GATEWAY_TLS_CA_CERT
#endif
#endif

constexpr int kRadarRx = 20, kRadarTx = 21;  // XIAO C3 silk D7/RX and D6/TX
constexpr uint32_t kRadarBaud = 256000;
// The radar emits ~16 batches a second; the map needs far fewer. Only the most
// recent decoded frame is ever sent — a batch that missed its slot is stale
// position data, and replaying it after a network stall would paint the past
// (design doc §7.1), so there is no retry queue.
constexpr uint32_t kSendIntervalMs = 250;
constexpr uint32_t kWifiRetryMs = 15000;
constexpr uint32_t kHealthMs = 5000;

struct Target { int16_t xMm, yMm, speedCmPerSec; };

HardwareSerial radar(1);
Target targets[3];
int targetCount = 0;
bool batchFresh = false;
uint32_t sequence = 0, framesParsed = 0, framesBad = 0, sendsOk = 0, sendsFailed = 0;
uint32_t lastSendAt = 0, lastHealthAt = 0, lastWifiBeginAt = 0, lastFrameAt = 0;
// With no radar frames the node still posts an empty batch on this cadence,
// marked radarOk:false — otherwise "node dead" and "radar silent" look
// identical from the gateway, which cost a live debugging session to tell apart.
constexpr uint32_t kHeartbeatMs = 2000;
bool wifiStarted = false;

bool wifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) return false;
  if (!wifiStarted || millis() - lastWifiBeginAt >= kWifiRetryMs) {
    wifiStarted = true; lastWifiBeginAt = millis();
    WiFi.mode(WIFI_STA); WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
  }
  return false;
}

// Sign-magnitude per the R0 measurement: MSB set is positive, clear is negative.
int16_t signMagnitude(uint16_t raw) {
  const int16_t magnitude = raw & 0x7FFF;
  return (raw & 0x8000) ? magnitude : -magnitude;
}

// Sliding-window resync: bytes shift until a frame header leads the buffer, so a
// byte lost mid-frame (e.g. during a TLS handshake stall) costs one frame, not
// the stream. The radar keeps transmitting regardless.
uint8_t frameBuf[64];
size_t frameLen = 0;

void decodeFrame(const uint8_t* body) {
  targetCount = 0;
  for (int slot = 0; slot < 3; slot++) {
    const uint8_t* at = body + slot * 8;
    const uint16_t xRaw = at[0] | at[1] << 8, yRaw = at[2] | at[3] << 8, speedRaw = at[4] | at[5] << 8;
    if (!xRaw && !yRaw && !speedRaw) continue;
    targets[targetCount++] = { signMagnitude(xRaw), signMagnitude(yRaw), signMagnitude(speedRaw) };
  }
  sequence++; framesParsed++; batchFresh = true; lastFrameAt = millis();
}

void pumpRadar() {
  while (radar.available()) {
    if (frameLen == sizeof frameBuf) { memmove(frameBuf, frameBuf + 1, --frameLen); }
    frameBuf[frameLen++] = radar.read();
    while (frameLen >= 4 && !(frameBuf[0] == 0xAA && frameBuf[1] == 0xFF && frameBuf[2] == 0x03 && frameBuf[3] == 0x00)) {
      memmove(frameBuf, frameBuf + 1, --frameLen);
    }
    if (frameLen < 30) continue;
    if (frameBuf[28] == 0x55 && frameBuf[29] == 0xCC) {
      decodeFrame(frameBuf + 4);
      memmove(frameBuf, frameBuf + 30, frameLen -= 30);
    } else {
      framesBad++;
      memmove(frameBuf, frameBuf + 1, --frameLen);
    }
  }
}

// One TLS session, handshaken once and kept alive — the same lesson as the
// monitor's status poller. Headers are added once per session because
// HTTPClient resends its stored headers on every request.
HTTPClient http;
WiFiClientSecure secureClient;
bool sessionUp = false;

bool beginGateway() {
  const String endpoint = String(WATCHCAT_RADAR_BASE_URL) + "/api/v1/radar/observations";
  http.setConnectTimeout(5000); http.setTimeout(8000); http.setReuse(true);
  if (endpoint.startsWith("https://")) {
    if (!strlen(WATCHCAT_RADAR_TLS_CA_CERT)) return false;
    secureClient.setCACert(WATCHCAT_RADAR_TLS_CA_CERT);
    if (!http.begin(secureClient, endpoint)) return false;
  } else if (!http.begin(endpoint)) {
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  return true;
}

void sendLatest() {
  const uint32_t now = millis();
  const bool radarOk = framesParsed && now - lastFrameAt < 1000;
  if (now - lastSendAt < (batchFresh ? kSendIntervalMs : kHeartbeatMs)) return;
  if (!wifi()) return;
  if (!sessionUp) sessionUp = beginGateway();
  if (!sessionUp) { sendsFailed++; lastSendAt = millis(); return; }
  String body = String("{\"sensorId\":\"") + WATCHCAT_RADAR_SENSOR_ID + "\",\"sequence\":" + sequence +
                ",\"radarOk\":" + (radarOk ? "true" : "false") + ",\"targets\":[";
  // A heartbeat carries no targets: whatever sits in the slots is a stale batch.
  for (int i = 0; batchFresh && i < targetCount; i++) {
    if (i) body += ',';
    body += String("{\"xMm\":") + targets[i].xMm + ",\"yMm\":" + targets[i].yMm +
            ",\"speedMmPerSec\":" + (targets[i].speedCmPerSec * 10) + "}";
  }
  body += "]}";
  const int code = http.POST(body);
  const bool ok = code >= 200 && code < 300;
  if (ok) { sendsOk++; } else { sendsFailed++; http.end(); sessionUp = false; }
  batchFresh = false;
  lastSendAt = millis();
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // USB CDC needs a moment to enumerate before the first lines
  // 16 Hz x 30 bytes is slow, but a TLS handshake can stall loop() for over a
  // second, and the default RX buffer overflows in half that.
  radar.setRxBufferSize(2048);
  radar.begin(kRadarBaud, SERIAL_8N1, kRadarRx, kRadarTx);
  Serial.printf("Radar node %s: RX=GPIO%d baud=%lu -> %s\n", WATCHCAT_RADAR_SENSOR_ID, kRadarRx,
                static_cast<unsigned long>(kRadarBaud), WATCHCAT_RADAR_BASE_URL);
  wifi();
}

void loop() {
  pumpRadar();
  sendLatest();
  if (millis() - lastHealthAt >= kHealthMs) {
    lastHealthAt = millis();
    Serial.printf("Health: frames=%lu bad=%lu sends=%lu/%lu wifi=%d targets=%d heap=%lu\n",
                  static_cast<unsigned long>(framesParsed), static_cast<unsigned long>(framesBad),
                  static_cast<unsigned long>(sendsOk), static_cast<unsigned long>(sendsOk + sendsFailed),
                  WiFi.status(), targetCount, static_cast<unsigned long>(ESP.getFreeHeap()));
  }
  delay(2);
}
