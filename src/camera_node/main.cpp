#include <Arduino.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include "esp_camera.h"
#if __has_include("watchcat_config.h")
#include "watchcat_config.h"
#else
#include "watchcat_config.example.h"
#endif

#ifndef WATCHCAT_CAMERA_UPLOAD_BASE_URL
#define WATCHCAT_CAMERA_UPLOAD_BASE_URL WATCHCAT_GATEWAY_BASE_URL
#endif

#ifndef WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT
#define WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT WATCHCAT_GATEWAY_TLS_CA_CERT
#endif

namespace {
// XIAO ESP32S3 Sense camera-expansion pin map. Never share these pins with TFT.
camera_config_t kCamera = {
  .pin_pwdn=-1, .pin_reset=-1, .pin_xclk=10, .pin_sccb_sda=40, .pin_sccb_scl=39,
  .pin_d7=48, .pin_d6=11, .pin_d5=12, .pin_d4=14, .pin_d3=16, .pin_d2=18,
  .pin_d1=17, .pin_d0=15, .pin_vsync=38, .pin_href=47, .pin_pclk=13,
  .xclk_freq_hz=20000000, .ledc_timer=LEDC_TIMER_0, .ledc_channel=LEDC_CHANNEL_0,
  .pixel_format=PIXFORMAT_JPEG, .frame_size=FRAMESIZE_UXGA, .jpeg_quality=4,
  .fb_count=1, .fb_location=CAMERA_FB_IN_PSRAM, .grab_mode=CAMERA_GRAB_LATEST,
};
WebServer server(80);
bool cameraReady = false;
String lastError, lastCaptureAt;
bool wifiStarted = false;
bool mdnsStarted = false;
uint32_t lastWifiBeginAt = 0;
uint32_t lastDiagnosticsAt = 0;
uint32_t lastCommandPollAt = 0;
int lastWifiStatus = WL_NO_SHIELD;
constexpr uint32_t kWifiRetryMs = 15000;
constexpr uint32_t kCommandPollMs = 2000;
constexpr uint32_t kStreamFrameMs = 700;
bool remoteStreaming = false;
bool directLive = false;
uint32_t lastStreamFrameAt = 0;

bool wifi(uint32_t timeout = 15000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) {
    if (lastWifiStatus != WL_NO_SSID_AVAIL) Serial.println("Wi-Fi SSID is not configured");
    lastWifiStatus = WL_NO_SSID_AVAIL;
    return false;
  }
  if (!wifiStarted || millis() - lastWifiBeginAt >= kWifiRetryMs) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
    wifiStarted = true;
    lastWifiBeginAt = millis();
    Serial.println("Wi-Fi connection requested");
  }
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeout) delay(200);
  const int current = WiFi.status();
  if (current != lastWifiStatus) {
    Serial.printf("Wi-Fi status: %d\n", current);
    lastWifiStatus = current;
  }
  if (current == WL_CONNECTED) {
    Serial.print("Wi-Fi connected, IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  return false;
}
bool authorized() {
  return !strlen(WATCHCAT_CAMERA_TOKEN) || server.header("Authorization") == String("Bearer ") + WATCHCAT_CAMERA_TOKEN;
}
void applyFrameSize() {
  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) { lastError = "Camera sensor unavailable"; return; }
  sensor->set_framesize(sensor, (remoteStreaming || directLive) ? FRAMESIZE_QVGA : FRAMESIZE_UXGA);
}
void ensureMdns() {
  if (mdnsStarted || WiFi.status() != WL_CONNECTED) return;
  mdnsStarted = MDNS.begin("watchcat-sensor");
  if (mdnsStarted) { MDNS.addService("http", "tcp", 80); Serial.println("mDNS: watchcat-sensor.local"); }
}
bool beginGateway(HTTPClient& http, WiFiClientSecure& secureClient, const String& endpoint) {
  http.setConnectTimeout(5000); http.setTimeout(15000);
  if (endpoint.startsWith("https://")) {
    if (!strlen(WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT)) { lastError = "Gateway TLS CA is not configured"; return false; }
    secureClient.setCACert(WATCHCAT_CAMERA_UPLOAD_TLS_CA_CERT);
    if (!http.begin(secureClient, endpoint)) { lastError = "Gateway HTTPS connection setup failed"; return false; }
    return true;
  }
  if (!http.begin(endpoint)) { lastError = "Gateway HTTP connection setup failed"; return false; }
  return true;
}
bool upload(const String& commandId = "", bool isStreaming = false) {
  if (!cameraReady) { lastError = "Camera not ready"; return false; }
  if (!wifi()) { lastError = "Wi-Fi unavailable"; return false; }
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) { lastError = "Capture failed"; return false; }
  const String endpoint = String(WATCHCAT_CAMERA_UPLOAD_BASE_URL) + "/api/v1/frames";
  HTTPClient http;
  WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, endpoint)) { esp_camera_fb_return(frame); return false; }
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Watchcat-Camera-Id", "xiao-esp32s3-sense");
  http.addHeader("X-Watchcat-Captured-At", String(millis()));
  http.addHeader("X-Watchcat-Width", String(frame->width)); http.addHeader("X-Watchcat-Height", String(frame->height));
  if (isStreaming) http.addHeader("X-Watchcat-Stream", "true");
  if (commandId.length()) http.addHeader("X-Watchcat-Command-Id", commandId);
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST(frame->buf, frame->len);
  esp_camera_fb_return(frame); http.end();
  if (code < 200 || code >= 300) { lastError = "Upload HTTP " + String(code); return false; }
  lastCaptureAt = String(millis()); lastError = ""; return true;
}
bool acknowledgeCommand(const String& id) {
  HTTPClient http;
  WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_CAMERA_UPLOAD_BASE_URL) + "/api/v1/commands/ack")) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST(String("{\"id\":\"") + id + "\"}");
  http.end();
  return code >= 200 && code < 300;
}
bool commandId(const String& response, String& id) {
  const String key = "\"id\":\"";
  const int start = response.indexOf(key);
  if (start < 0) return false;
  const int idStart = start + key.length(), idEnd = response.indexOf('"', idStart);
  if (idEnd < 0) return false;
  id = response.substring(idStart, idEnd);
  return true;
}
void setRemoteStreaming(bool active) {
  remoteStreaming = active;
  applyFrameSize();
  lastStreamFrameAt = 0;
  Serial.println(active ? "Remote live stream started" : "Remote live stream stopped");
}
void pollCommand() {
  if (!cameraReady || !wifi()) return;
  HTTPClient http;
  WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_CAMERA_UPLOAD_BASE_URL) + "/api/v1/commands/next")) return;
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET();
  const String response = code == 200 ? http.getString() : "";
  http.end();
  if (code != 200) { lastError = "Command HTTP " + String(code); return; }
  if (response.indexOf("\"command\":\"capture\"") >= 0) {
    String id;
    if (!commandId(response, id)) { lastError = "Invalid capture command"; return; }
    const bool resumeStreaming = remoteStreaming || directLive;
    sensor_t* sensor = esp_camera_sensor_get();
    if (resumeStreaming && sensor) sensor->set_framesize(sensor, FRAMESIZE_UXGA);
    upload(id);
    if (resumeStreaming) applyFrameSize();
    return;
  }
  const bool start = response.indexOf("\"command\":\"stream-start\"") >= 0;
  const bool stop = response.indexOf("\"command\":\"stream-stop\"") >= 0;
  if (!start && !stop) return;
  String id;
  if (!commandId(response, id)) { lastError = "Invalid stream command"; return; }
  setRemoteStreaming(start);
  if (!acknowledgeCommand(id)) lastError = "Stream command acknowledgement failed";
}
void status() {
  server.send(200, "application/json", String("{\"ok\":true,\"cameraReady\":") + (cameraReady ? "true" : "false") + ",\"wifiConnected\":" + (WiFi.status() == WL_CONNECTED ? "true" : "false") + ",\"directLive\":" + (directLive ? "true" : "false") + ",\"lastCaptureAt\":\"" + lastCaptureAt + "\",\"lastError\":\"" + lastError + "\"}");
}
void capture() {
  if (!authorized()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized\"}"); return; }
  const bool ok = upload();
  server.send(ok ? 202 : 503, "application/json", ok ? "{\"ok\":true,\"accepted\":true}" : String("{\"ok\":false,\"error\":\"") + lastError + "\"}");
}
void localLiveControl() {
  if (!authorized()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized\"}"); return; }
  const String value = server.arg("plain");
  const bool active = value.indexOf("true") >= 0;
  directLive = active;
  applyFrameSize();
  server.send(200, "application/json", String("{\"ok\":true,\"active\":") + (directLive ? "true" : "false") + "}");
}
void localLiveFrame() {
  if (!authorized()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized\"}"); return; }
  if (!directLive || !cameraReady) { server.send(409, "application/json", "{\"ok\":false,\"error\":\"Live view is not active\"}"); return; }
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) { server.send(503, "application/json", "{\"ok\":false,\"error\":\"Capture failed\"}"); return; }
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(frame->len);
  server.send(200, "image/jpeg", "");
  server.client().write(frame->buf, frame->len);
  esp_camera_fb_return(frame);
}
}

void setup() {
  Serial.begin(115200); delay(300);
  cameraReady = esp_camera_init(&kCamera) == ESP_OK;
  if (!cameraReady) { lastError = "Camera initialization failed"; Serial.println(lastError); }
  else {
    sensor_t* sensor = esp_camera_sensor_get();
    if (sensor) {
      sensor->set_vflip(sensor, 1);
      sensor->set_aec2(sensor, 1);
      sensor->set_brightness(sensor, 1);
      sensor->set_contrast(sensor, 1);
      sensor->set_sharpness(sensor, 2);
      sensor->set_denoise(sensor, 0);
    }
    Serial.println("Camera initialized");
  }
  wifi();
  ensureMdns();
  const char* headers[] = {"Authorization"};
  server.collectHeaders(headers, 1);
  server.on("/api/v1/status", HTTP_GET, status);
  server.on("/api/v1/capture", HTTP_POST, capture);
  server.on("/api/v1/live", HTTP_POST, localLiveControl);
  server.on("/api/v1/live.jpg", HTTP_GET, localLiveFrame);
  server.begin();
  Serial.println("Camera API listening on port 80");
}
void loop() {
  server.handleClient();
  if (WiFi.status() != WL_CONNECTED) wifi(1000);
  ensureMdns();
  if (millis() - lastCommandPollAt >= kCommandPollMs) { lastCommandPollAt = millis(); pollCommand(); }
  if (remoteStreaming && millis() - lastStreamFrameAt >= kStreamFrameMs) { lastStreamFrameAt = millis(); upload("", true); }
  if (millis() - lastDiagnosticsAt >= 5000) {
    lastDiagnosticsAt = millis();
    Serial.printf("Health: camera=%s wifi=%d ip=%s\n", cameraReady ? "ready" : "failed", WiFi.status(), WiFi.localIP().toString().c_str());
  }
  delay(2);
}
