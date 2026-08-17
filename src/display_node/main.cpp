#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <TJpg_Decoder.h>
#if __has_include("watchcat_config.h")
#include "watchcat_config.h"
#else
#include "watchcat_config.example.h"
#endif

#ifndef WATCHCAT_MONITOR_BASE_URL
#define WATCHCAT_MONITOR_BASE_URL WATCHCAT_GATEWAY_BASE_URL
#endif

#ifndef WATCHCAT_MONITOR_TLS_CA_CERT
#define WATCHCAT_MONITOR_TLS_CA_CERT WATCHCAT_GATEWAY_TLS_CA_CERT
#endif

#ifndef WATCHCAT_SENSOR_LOCAL_URL
#define WATCHCAT_SENSOR_LOCAL_URL "http://watchcat-sensor.local"
#endif

namespace {
// TFT wires: SCL -> GPIO13 (SCK), SDA -> GPIO14 (MOSI), CS=11, DC=10, RST=9.
// Do not use global SPI here: Adafruit's init calls SPI.begin() again and
// restores the board defaults. A dedicated HSPI instance preserves this map.
SPIClass tftSpi(HSPI);
Adafruit_ST7789 tft(&tftSpi, 11, 10, 9);
constexpr int kButtons[] = {5, 6, 7};
constexpr uint32_t kDebounceMs = 40, kPollMs = 2000, kLivePollMs = 900, kButtonSampleMs = 10;
uint32_t lastPoll = 0;
// Presses are latched by a sampling task, not read from loop(). A status poll is a
// blocking TLS request that can hold loop() for seconds, and the poll timer fires
// again the moment it returns, so loop() sampled the pins roughly once per poll.
// Debounce needs two samples of a held button, which meant only a multi-second hold
// ever registered and an ordinary tap was dropped between polls.
volatile bool pressLatched[] = {false, false, false};
bool detail = false, liveView = false;
String title = "INFERENCE WAITING", message = "Booting";

bool wifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
  const uint32_t start = millis(); while (WiFi.status() != WL_CONNECTED && millis() - start < 5000) delay(100);
  return WiFi.status() == WL_CONNECTED;
}
bool boolIn(const String& value, const char* key, bool expected) { return value.indexOf(String("\"") + key + "\":" + (expected ? "true" : "false")) >= 0; }
bool beginGateway(HTTPClient& http, WiFiClientSecure& secureClient, const String& endpoint) {
  http.setConnectTimeout(5000); http.setTimeout(15000);
  if (endpoint.startsWith("https://")) {
    if (!strlen(WATCHCAT_MONITOR_TLS_CA_CERT)) return false;
    secureClient.setCACert(WATCHCAT_MONITOR_TLS_CA_CERT);
    return http.begin(secureClient, endpoint);
  }
  return http.begin(endpoint);
}
void draw() {
  const uint16_t color = title == "CAT FOUND" ? ST77XX_RED : title == "NO CAT" ? ST77XX_GREEN : title == "ERROR" ? ST77XX_RED : ST77XX_YELLOW;
  tft.fillScreen(ST77XX_BLACK); tft.setTextWrap(true); tft.setTextColor(color); tft.setTextSize(2); tft.setCursor(12, 20); tft.println("WATCHCAT"); tft.drawFastHLine(12, 50, 216, color);
  tft.setTextSize(3); tft.setCursor(12, 75); tft.println(title); tft.setTextColor(ST77XX_WHITE); tft.setTextSize(1); tft.setCursor(12, 170); tft.println(message);
  tft.setCursor(12, 235); tft.print("B1 Capture B2 Page B3 Live:"); tft.println(liveView ? "ON" : "OFF");
}
bool tftOutput(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* pixels) {
  if (y >= tft.height()) return false;
  tft.drawRGBBitmap(x, y, pixels, w, h);
  return true;
}
void capture() {
  if (!wifi()) { title = "ERROR"; message = "Wi-Fi unavailable"; draw(); return; }
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_MONITOR_BASE_URL) + "/api/v1/capture")) { title = "ERROR"; message = "Gateway TLS unavailable"; draw(); return; }
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST("{}"); http.end(); title = code >= 200 && code < 300 ? "INFERENCE WAITING" : "ERROR"; message = code >= 200 && code < 300 ? "Capture requested" : "Capture request failed"; draw();
}
void poll() {
  if (!wifi()) { title = "CAMERA OFFLINE"; message = "Pi Wi-Fi unavailable"; draw(); return; }
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_MONITOR_BASE_URL) + "/api/v1/status")) { title = "CAMERA OFFLINE"; message = "Gateway TLS unavailable"; draw(); return; }
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET(); const String body = code == 200 ? http.getString() : ""; http.end();
  if (code != 200) { title = "CAMERA OFFLINE"; message = "Gateway unavailable"; draw(); return; }
  title = boolIn(body, "catPresent", true) ? "CAT FOUND" : body.indexOf("\"inferenceState\":\"waiting\"") >= 0 || body.indexOf("\"inferenceState\":\"running\"") >= 0 ? "INFERENCE WAITING" : body.indexOf("\"inferenceState\":\"error\"") >= 0 ? "ERROR" : boolIn(body, "cameraOnline", true) ? "NO CAT" : "CAMERA OFFLINE";
  message = detail ? body.substring(0, 90) : "Pi status received"; draw();
}
bool setLiveView(bool active) {
  if (!wifi()) return false;
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_SENSOR_LOCAL_URL) + "/api/v1/live")) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST(active ? "{\"active\":true}" : "{\"active\":false}"); http.end();
  return code >= 200 && code < 300;
}
void showLiveFrame() {
  if (!wifi()) return;
  HTTPClient http; WiFiClientSecure secureClient;
  const String endpoint = String(WATCHCAT_SENSOR_LOCAL_URL) + "/api/v1/live.jpg?t=" + String(millis());
  if (!beginGateway(http, secureClient, endpoint)) return;
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET();
  const int size = http.getSize();
  if (code != 200 || size <= 0 || size > 120000) { http.end(); return; }
  uint8_t* jpeg = static_cast<uint8_t*>(malloc(size));
  if (!jpeg) { http.end(); return; }
  WiFiClient* stream = http.getStreamPtr();
  const size_t read = stream->readBytes(jpeg, size);
  http.end();
  if (read == static_cast<size_t>(size)) {
    tft.fillScreen(ST77XX_BLACK);
    TJpgDec.drawJpg(-20, 0, jpeg, size);
    tft.setTextColor(ST77XX_CYAN); tft.setTextSize(1); tft.setCursor(8, 8); tft.print("LIVE  B3 STOP");
  }
  free(jpeg);
}
// Runs independently of loop(), so a tap during a blocking request is still seen.
void buttonTask(void*) {
  bool lastRead[] = {HIGH, HIGH, HIGH}, stable[] = {HIGH, HIGH, HIGH};
  uint32_t changed[] = {0, 0, 0};
  for (;;) {
    for (int i = 0; i < 3; i++) {
      const bool raw = digitalRead(kButtons[i]);
      if (raw != lastRead[i]) { changed[i] = millis(); lastRead[i] = raw; }
      if (millis() - changed[i] < kDebounceMs || raw == stable[i]) continue;
      stable[i] = raw;
      if (raw == LOW) {
        pressLatched[i] = true;
        Serial.printf("Button B%d pressed (GPIO%d)\n", i + 1, kButtons[i]);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(kButtonSampleMs));
  }
}
bool pressed(int index) {
  if (!pressLatched[index]) return false;
  pressLatched[index] = false;
  return true;
}
}

void setup() {
  Serial.begin(115200); delay(200);
  for (int pin : kButtons) pinMode(pin, INPUT_PULLUP);
  Serial.printf("Buttons ready: B1=%d B2=%d B3=%d\n", kButtons[0], kButtons[1], kButtons[2]);
  xTaskCreate(buttonTask, "buttons", 2048, nullptr, 2, nullptr);
  tftSpi.begin(13, -1, 14, 11);
  tft.init(240, 280); tft.setRotation(2);
  TJpgDec.setJpgScale(1); TJpgDec.setSwapBytes(true); TJpgDec.setCallback(tftOutput);
  draw(); wifi();
}
void loop() {
  if (pressed(0)) capture();
  if (pressed(1)) { detail = !detail; draw(); }
  if (pressed(2)) {
    const bool requested = !liveView;
    if (setLiveView(requested)) {
      liveView = requested;
      tft.setRotation(liveView ? 1 : 2);
      title = liveView ? "LIVE VIEW" : "INFERENCE WAITING"; message = liveView ? "Connecting direct" : "Live stream stopped"; draw();
    }
    else { title = "ERROR"; message = "Live request failed"; draw(); }
  }
  if (liveView && millis() - lastPoll >= kLivePollMs) { lastPoll = millis(); showLiveFrame(); }
  if (!liveView && millis() - lastPoll >= kPollMs) { lastPoll = millis(); poll(); }
  delay(5);
}
