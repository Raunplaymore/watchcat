#include <Arduino.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <WiFi.h>
#include "esp_camera.h"
#if __has_include("watchcat_config.h")
#include "watchcat_config.h"
#else
#include "watchcat_config.example.h"
#endif

namespace {
// XIAO ESP32S3 Sense camera-expansion pin map. Never share these pins with TFT.
camera_config_t kCamera = {
  .pin_pwdn=-1, .pin_reset=-1, .pin_xclk=10, .pin_sccb_sda=40, .pin_sccb_scl=39,
  .pin_d7=48, .pin_d6=11, .pin_d5=12, .pin_d4=14, .pin_d3=16, .pin_d2=17,
  .pin_d1=18, .pin_d0=15, .pin_vsync=38, .pin_href=47, .pin_pclk=13,
  .xclk_freq_hz=20000000, .ledc_timer=LEDC_TIMER_0, .ledc_channel=LEDC_CHANNEL_0,
  .pixel_format=PIXFORMAT_JPEG, .frame_size=FRAMESIZE_VGA, .jpeg_quality=12,
  .fb_count=1, .fb_location=CAMERA_FB_IN_PSRAM, .grab_mode=CAMERA_GRAB_LATEST,
};
WebServer server(80);
bool cameraReady = false;
String lastError, lastCaptureAt;

bool wifi(uint32_t timeout = 15000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeout) delay(200);
  return WiFi.status() == WL_CONNECTED;
}
bool authorized() {
  return !strlen(WATCHCAT_CAMERA_TOKEN) || server.header("Authorization") == String("Bearer ") + WATCHCAT_CAMERA_TOKEN;
}
bool upload() {
  if (!cameraReady) { lastError = "Camera not ready"; return false; }
  if (!wifi()) { lastError = "Wi-Fi unavailable"; return false; }
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) { lastError = "Capture failed"; return false; }
  HTTPClient http;
  http.setConnectTimeout(5000); http.setTimeout(15000);
  http.begin(String(WATCHCAT_GATEWAY_BASE_URL) + "/api/v1/frames");
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Watchcat-Camera-Id", "xiao-esp32s3-sense");
  http.addHeader("X-Watchcat-Captured-At", String(millis()));
  http.addHeader("X-Watchcat-Width", "640"); http.addHeader("X-Watchcat-Height", "480");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST(frame->buf, frame->len);
  esp_camera_fb_return(frame); http.end();
  if (code < 200 || code >= 300) { lastError = "Upload HTTP " + String(code); return false; }
  lastCaptureAt = String(millis()); lastError = ""; return true;
}
void status() {
  server.send(200, "application/json", String("{\"ok\":true,\"cameraReady\":") + (cameraReady ? "true" : "false") + ",\"wifiConnected\":" + (WiFi.status() == WL_CONNECTED ? "true" : "false") + ",\"lastCaptureAt\":\"" + lastCaptureAt + "\",\"lastError\":\"" + lastError + "\"}");
}
void capture() {
  if (!authorized()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"Unauthorized\"}"); return; }
  const bool ok = upload();
  server.send(ok ? 202 : 503, "application/json", ok ? "{\"ok\":true,\"accepted\":true}" : String("{\"ok\":false,\"error\":\"") + lastError + "\"}");
}
}

void setup() {
  Serial.begin(115200); delay(300);
  cameraReady = esp_camera_init(&kCamera) == ESP_OK;
  if (!cameraReady) lastError = "Camera initialization failed";
  wifi();
  server.on("/api/v1/status", HTTP_GET, status);
  server.on("/api/v1/capture", HTTP_POST, capture);
  server.begin();
}
void loop() { server.handleClient(); if (WiFi.status() != WL_CONNECTED) wifi(1000); delay(2); }
