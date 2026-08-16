#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#if __has_include("watchcat_config.h")
#include "watchcat_config.h"
#else
#include "watchcat_config.example.h"
#endif

namespace {
Adafruit_ST7789 tft(11, 10, 16, 15, 9);  // CS, DC, MOSI, SCLK, RST
constexpr int kButtons[] = {5, 6, 7};
constexpr uint32_t kDebounceMs = 40, kPollMs = 2000;
bool lastRead[] = {HIGH, HIGH, HIGH}, stable[] = {HIGH, HIGH, HIGH};
uint32_t changed[] = {0, 0, 0}, lastPoll = 0, lastAutoCapture = 0;
bool detail = false, autoCapture = false;
String title = "INFERENCE WAITING", message = "Booting";

bool wifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
  const uint32_t start = millis(); while (WiFi.status() != WL_CONNECTED && millis() - start < 5000) delay(100);
  return WiFi.status() == WL_CONNECTED;
}
bool boolIn(const String& value, const char* key, bool expected) { return value.indexOf(String("\"") + key + "\":" + (expected ? "true" : "false")) >= 0; }
void draw() {
  const uint16_t color = title == "CAT FOUND" ? ST77XX_RED : title == "NO CAT" ? ST77XX_GREEN : title == "ERROR" ? ST77XX_RED : ST77XX_YELLOW;
  tft.fillScreen(ST77XX_BLACK); tft.setTextWrap(true); tft.setTextColor(color); tft.setTextSize(2); tft.setCursor(12, 20); tft.println("WATCHCAT"); tft.drawFastHLine(12, 50, 216, color);
  tft.setTextSize(3); tft.setCursor(12, 75); tft.println(title); tft.setTextColor(ST77XX_WHITE); tft.setTextSize(1); tft.setCursor(12, 170); tft.println(message);
  tft.setCursor(12, 235); tft.print("B1 Capture B2 Page B3 Auto:"); tft.println(autoCapture ? "ON" : "OFF");
}
void capture() {
  if (!wifi()) { title = "ERROR"; message = "Wi-Fi unavailable"; draw(); return; }
  HTTPClient http; http.begin(String(WATCHCAT_GATEWAY_BASE_URL) + "/api/v1/capture"); http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST("{}"); http.end(); title = code >= 200 && code < 300 ? "INFERENCE WAITING" : "ERROR"; message = code >= 200 && code < 300 ? "Capture requested" : "Capture request failed"; draw();
}
void poll() {
  if (!wifi()) { title = "CAMERA OFFLINE"; message = "Pi Wi-Fi unavailable"; draw(); return; }
  HTTPClient http; http.begin(String(WATCHCAT_GATEWAY_BASE_URL) + "/api/v1/status"); if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET(); const String body = code == 200 ? http.getString() : ""; http.end();
  if (code != 200) { title = "CAMERA OFFLINE"; message = "Gateway unavailable"; draw(); return; }
  title = boolIn(body, "catPresent", true) ? "CAT FOUND" : body.indexOf("\"inferenceState\":\"waiting\"") >= 0 || body.indexOf("\"inferenceState\":\"running\"") >= 0 ? "INFERENCE WAITING" : boolIn(body, "cameraOnline", true) ? "NO CAT" : "CAMERA OFFLINE";
  message = detail ? body.substring(0, 90) : "Pi status received"; draw();
}
bool pressed(int index) {
  const bool raw = digitalRead(kButtons[index]); if (raw != lastRead[index]) changed[index] = millis(); lastRead[index] = raw;
  if (millis() - changed[index] < kDebounceMs || raw == stable[index]) return false;
  stable[index] = raw; return raw == LOW;
}
}

void setup() { for (int pin : kButtons) pinMode(pin, INPUT_PULLUP); tft.init(240, 280); tft.setRotation(2); draw(); wifi(); }
void loop() {
  if (pressed(0)) capture();
  if (pressed(1)) { detail = !detail; draw(); }
  if (pressed(2)) { autoCapture = !autoCapture; lastAutoCapture = millis(); draw(); }
  if (autoCapture && millis() - lastAutoCapture >= 10000) { lastAutoCapture = millis(); capture(); }
  if (millis() - lastPoll >= kPollMs) { lastPoll = millis(); poll(); }
  delay(5);
}
