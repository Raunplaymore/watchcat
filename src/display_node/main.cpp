#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <TJpg_Decoder.h>
#include <ESPmDNS.h>
#include "waiting_bitmap.h"
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

// The hostname the sensor advertises, without the .local suffix.
#define WATCHCAT_SENSOR_MDNS_HOST "watchcat-sensor"

namespace {
// TFT wires: SCL -> GPIO13 (SCK), SDA -> GPIO14 (MOSI), CS=11, DC=10, RST=9.
// Do not use global SPI here: Adafruit's init calls SPI.begin() again and
// restores the board defaults. A dedicated HSPI instance preserves this map.
SPIClass tftSpi(HSPI);
Adafruit_ST7789 tft(&tftSpi, 11, 10, 9);

// Three buttons are a navigation set, not three independent actions: B1 and B3 move
// between pages and B2 runs the current page's action. Adding a feature adds a page
// instead of competing for a button.
constexpr int kButtons[] = {5, 6, 7};
enum Button : uint8_t { ButtonPrev, ButtonSelect, ButtonNext };
enum Page : uint8_t { PageStatus, PagePhoto, PageLive, PageDetail, PageCount };

constexpr uint32_t kDebounceMs = 40, kStatusPollMs = 2000, kLiveFrameMs = 150, kButtonSampleMs = 10;
// A still can be UXGA, far larger than a live frame, so it gets its own ceiling.
// The photo buffer lives in PSRAM; the sensor's driver cannot emit a JPEG past its
// own 384 KB frame buffer, so anything larger than this is a bogus response.
constexpr int kMaxLiveBytes = 120000, kMaxPhotoBytes = 512000;
// The panel's corners are rounded, so anything painted at the extreme edge is cut by
// the bezel. Every page lays out inside this inset and a rounded border traces it, which
// makes the curve read as part of the design instead of as clipping.
constexpr int16_t kInset = 18, kPhotoTop = 78, kPhotoMaxHeight = 148;

// Presses are latched by a sampling task, not read from loop(). A page action is a
// blocking TLS request that can hold loop() for seconds, and the poll timer fires
// again the moment it returns, so loop() sampled the pins roughly once per poll.
// Debounce needs two samples of a held button, which meant only a multi-second hold
// ever registered and an ordinary tap was dropped between polls.
volatile bool pressLatched[] = {false, false, false};

bool mdnsStarted = false;
IPAddress sensorIp;
uint32_t sensorIpAt = 0;
constexpr uint32_t kSensorIpTtlMs = 60000;

uint32_t liveFrames = 0, liveFetchMs = 0, liveDrawMs = 0, liveStatAt = 0;
uint32_t lastStatusPoll = 0, lastLiveFrame = 0;

uint8_t page = PageStatus;
bool livePaused = false;
String statusBody;  // last gateway status JSON, shared by the status and detail pages
// The waiting state is drawn from a Hangul bitmap, so it is matched by this marker
// rather than printed as text. Every other title is ASCII and prints normally.
constexpr char kWaiting[] = "WAITING";
String title = kWaiting, message = "Booting";

bool wifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!strlen(WATCHCAT_WIFI_SSID)) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(WATCHCAT_WIFI_SSID, WATCHCAT_WIFI_PASSWORD);
  const uint32_t start = millis(); while (WiFi.status() != WL_CONNECTED && millis() - start < 5000) delay(100);
  return WiFi.status() == WL_CONNECTED;
}
bool boolIn(const String& value, const char* key, bool expected) { return value.indexOf(String("\"") + key + "\":" + (expected ? "true" : "false")) >= 0; }
// Pulls one value out of the gateway's status JSON. The detail page needs the numbers
// themselves; printing a prefix of the raw body cut off inside "confidence" and showed
// the key without ever reaching its value.
String jsonValue(const String& body, const char* key) {
  const String needle = String("\"") + key + "\":";
  int at = body.indexOf(needle);
  if (at < 0) return String();
  at += needle.length();
  if (at < static_cast<int>(body.length()) && body[at] == '"') {
    const int end = body.indexOf('"', at + 1);
    return end < 0 ? String() : body.substring(at + 1, end);
  }
  int end = at;
  while (end < static_cast<int>(body.length()) && body[end] != ',' && body[end] != '}') end++;
  const String raw = body.substring(at, end);
  return raw == "null" ? String() : raw;
}
String orDash(const String& value) { return value.length() ? value : String("-"); }
bool beginGateway(HTTPClient& http, WiFiClientSecure& secureClient, const String& endpoint) {
  http.setConnectTimeout(5000); http.setTimeout(15000);
  if (endpoint.startsWith("https://")) {
    if (!strlen(WATCHCAT_MONITOR_TLS_CA_CERT)) return false;
    secureClient.setCACert(WATCHCAT_MONITOR_TLS_CA_CERT);
    return http.begin(secureClient, endpoint);
  }
  return http.begin(endpoint);
}
bool tftOutput(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* pixels) {
  if (y >= tft.height()) return false;
  tft.drawRGBBitmap(x, y, pixels, w, h);
  return true;
}

const char* pageName(uint8_t p) {
  switch (p) {
    case PageStatus: return "STATUS";
    case PagePhoto: return "PHOTO";
    case PageLive: return "LIVE";
    default: return "DETAIL";
  }
}
const char* selectLabel(uint8_t p) {
  switch (p) {
    case PageStatus: return "CAPTURE";
    case PagePhoto: return "RELOAD";
    case PageLive: return livePaused ? "RESUME" : "PAUSE";
    default: return "REFRESH";
  }
}
// Always states the current page and what B2 will do, so the label can never drift from
// the behaviour the way a fixed "B2 Page" caption did.
void drawChrome(uint16_t color) {
  tft.setTextWrap(false);
  tft.drawRoundRect(6, 6, tft.width() - 12, tft.height() - 12, 14, 0x3186);  // dim gray
  tft.setTextColor(color); tft.setTextSize(2); tft.setCursor(kInset, 20); tft.print("WATCHCAT");
  tft.drawFastHLine(kInset, 46, tft.width() - 2 * kInset, color);
  tft.setTextSize(1); tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(kInset, 236); tft.printf("< %s >", pageName(page));
  tft.setCursor(kInset, 250); tft.printf("B2: %s", selectLabel(page));
}
void drawStatusPage() {
  const uint16_t color = title == "CAT FOUND" ? ST77XX_RED : title == "NO CAT" ? ST77XX_GREEN : title == "ERROR" ? ST77XX_RED : ST77XX_YELLOW;
  tft.fillScreen(ST77XX_BLACK);
  drawChrome(color);
  if (title == kWaiting) tft.drawBitmap((tft.width() - kWaitingBitmapWidth) / 2, 84, kWaitingBitmap, kWaitingBitmapWidth, kWaitingBitmapHeight, color);
  else { tft.setTextColor(color); tft.setTextSize(3); tft.setCursor(kInset, 88); tft.print(title); }
  tft.setTextColor(ST77XX_WHITE); tft.setTextSize(1); tft.setTextWrap(true); tft.setCursor(kInset, 166); tft.print(message);
}
void drawDetailPage() {
  tft.fillScreen(ST77XX_BLACK);
  drawChrome(ST77XX_CYAN);
  const String conf = jsonValue(statusBody, "confidence");
  const String done = jsonValue(statusBody, "processedAt");
  struct { const char* label; String value; } rows[] = {
    {"CONF",  orDash(conf.length() ? conf.substring(0, 5) : conf)},
    {"STATE", orDash(jsonValue(statusBody, "inferenceState"))},
    {"CAT",   boolIn(statusBody, "catPresent", true) ? "yes" : "no"},
    {"SHOT",  orDash(jsonValue(statusBody, "capturedAt"))},
    {"DONE",  orDash(done.length() >= 19 ? done.substring(11, 19) : done)},
    {"CAM",   sensorIp == IPAddress() ? String("unresolved") : sensorIp.toString()},
    {"WIFI",  WiFi.status() == WL_CONNECTED ? String(WiFi.RSSI()) + " dBm" : String("down")},
    {"ERR",   orDash(jsonValue(statusBody, "lastError"))},
  };
  tft.setTextSize(1); tft.setTextWrap(false);
  int y = 62;
  for (const auto& row : rows) {
    tft.setTextColor(ST77XX_CYAN); tft.setCursor(kInset, y); tft.print(row.label);
    tft.setTextColor(ST77XX_WHITE); tft.setCursor(kInset + 54, y); tft.print(row.value);
    y += 20;
  }
}
void render() {
  if (page == PageStatus) drawStatusPage();
  else if (page == PageDetail) drawDetailPage();
}

void capture() {
  if (!wifi()) { title = "ERROR"; message = "Wi-Fi unavailable"; return; }
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_MONITOR_BASE_URL) + "/api/v1/capture")) { title = "ERROR"; message = "Gateway TLS unavailable"; return; }
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST("{}"); http.end();
  const bool ok = code >= 200 && code < 300;
  title = ok ? kWaiting : "ERROR"; message = ok ? "Capture requested" : "Capture request failed";
}
void pollStatus() {
  if (!wifi()) { title = "CAMERA OFFLINE"; message = "Pi Wi-Fi unavailable"; return; }
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, String(WATCHCAT_MONITOR_BASE_URL) + "/api/v1/status")) { title = "CAMERA OFFLINE"; message = "Gateway TLS unavailable"; return; }
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET(); const String body = code == 200 ? http.getString() : ""; http.end();
  if (code != 200) { title = "CAMERA OFFLINE"; message = "Gateway unavailable"; return; }
  statusBody = body;
  // A queued capture means the reported verdict still belongs to the previous photo:
  // the sensor polls every 2s, so the gateway keeps serving the old completed result
  // for seconds after a capture. Showing it made a fresh capture look like an instant
  // NO CAT.
  const bool stale = boolIn(body, "capturePending", true) || body.indexOf("\"inferenceState\":\"waiting\"") >= 0 || body.indexOf("\"inferenceState\":\"running\"") >= 0;
  title = stale ? kWaiting : boolIn(body, "catPresent", true) ? "CAT FOUND" : body.indexOf("\"inferenceState\":\"error\"") >= 0 ? "ERROR" : boolIn(body, "cameraOnline", true) ? "NO CAT" : "CAMERA OFFLINE";
  const String conf = jsonValue(body, "confidence");
  message = stale ? "Waiting for the sensor" : conf.length() ? "confidence " + conf.substring(0, 5) : "Pi status received";
}

// The sensor advertises watchcat-sensor.local over mDNS, but this board carried no
// mDNS resolver, so the name fell through to the ISP's DNS — which answers NXDOMAIN
// with an ad server. Live view was fetching from that server and handing its reply
// to the JPEG decoder. Resolve over multicast and never query the .local name.
// mDNS needs a live network interface, so this cannot run from setup().
void ensureMdns() {
  if (mdnsStarted || WiFi.status() != WL_CONNECTED) return;
  mdnsStarted = MDNS.begin("watchcat-monitor");
  Serial.println(mdnsStarted ? "mDNS resolver ready" : "mDNS resolver failed to start");
}
String sensorBase() {
  const String configured = WATCHCAT_SENSOR_LOCAL_URL;
  if (configured.indexOf(".local") < 0) return configured;  // explicit host, use as is
  ensureMdns();
  if (!mdnsStarted) return String();
  if (sensorIp == IPAddress() || millis() - sensorIpAt >= kSensorIpTtlMs) {
    const IPAddress found = MDNS.queryHost(WATCHCAT_SENSOR_MDNS_HOST, 2000);
    if (found != IPAddress()) {
      sensorIp = found; sensorIpAt = millis();
      Serial.print("Sensor resolved over mDNS: "); Serial.println(sensorIp);
    } else if (sensorIp == IPAddress()) {
      Serial.println("Sensor mDNS lookup failed");
    }
  }
  return sensorIp == IPAddress() ? String() : String("http://") + sensorIp.toString();
}
bool setLiveView(bool active) {
  if (!wifi()) return false;
  const String base = sensorBase();
  if (!base.length()) return false;
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, base + "/api/v1/live")) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.POST(active ? "{\"active\":true}" : "{\"active\":false}"); http.end();
  return code >= 200 && code < 300;
}
// Fetches a JPEG into a caller-owned buffer. Returns 0 on failure. Only accepts a real
// JPEG: anything else on these endpoints — a captive portal, an ISP error page — used to
// be pushed straight to the decoder and painted as garbage.
size_t fetchJpeg(const String& endpoint, uint8_t** out, int maxBytes) {
  *out = nullptr;
  HTTPClient http; WiFiClientSecure secureClient;
  if (!beginGateway(http, secureClient, endpoint)) return 0;
  if (strlen(WATCHCAT_CAMERA_TOKEN)) http.addHeader("Authorization", String("Bearer ") + WATCHCAT_CAMERA_TOKEN);
  const int code = http.GET();
  const int size = http.getSize();
  if (code != 200 || size <= 4 || size > maxBytes) { http.end(); return 0; }
  uint8_t* buffer = static_cast<uint8_t*>(ps_malloc(size));  // PSRAM when the board has it
  if (!buffer) buffer = static_cast<uint8_t*>(malloc(size));
  if (!buffer) { http.end(); return 0; }
  const size_t read = http.getStreamPtr()->readBytes(buffer, size);
  http.end();
  if (read != static_cast<size_t>(size) || buffer[0] != 0xFF || buffer[1] != 0xD8 || buffer[2] != 0xFF) {
    free(buffer);
    return 0;
  }
  *out = buffer;
  return read;
}
void drawPhotoPage() {
  tft.fillScreen(ST77XX_BLACK);
  drawChrome(ST77XX_YELLOW);
  tft.setTextSize(1); tft.setTextColor(ST77XX_WHITE); tft.setCursor(kInset, kPhotoTop);
  if (!wifi()) { tft.print("Wi-Fi unavailable"); return; }
  tft.print("Loading...");
  uint8_t* jpeg = nullptr;
  const size_t bytes = fetchJpeg(String(WATCHCAT_MONITOR_BASE_URL) + "/api/v1/latest.jpg", &jpeg, kMaxPhotoBytes);
  tft.fillRect(kInset - 4, 56, tft.width() - 2 * (kInset - 4), 176, ST77XX_BLACK);
  if (!bytes) {
    tft.setCursor(kInset, kPhotoTop);
    tft.printf("No photo (heap %lu)", static_cast<unsigned long>(ESP.getFreeHeap()));
    return;
  }
  // The still is whatever the gateway last inferred, and that is not always UXGA — a
  // stream frame can leave a QVGA image there. Fit to the panel from the actual size
  // instead of assuming, or a live frame would be drawn at 40x30.
  uint16_t jw = 0, jh = 0;
  TJpgDec.getJpgSize(&jw, &jh, jpeg, bytes);
  const int16_t availWidth = tft.width() - 2 * kInset;
  int scale = 1;
  while (scale < 8 && (jw / scale > availWidth || jh / scale > kPhotoMaxHeight)) scale *= 2;
  TJpgDec.setJpgScale(scale);
  TJpgDec.drawJpg(kInset + (availWidth - jw / scale) / 2, kPhotoTop, jpeg, bytes);
  TJpgDec.setJpgScale(1);
  free(jpeg);
  tft.setTextColor(ST77XX_WHITE); tft.setTextSize(1); tft.setCursor(kInset, 232);
  tft.printf("%ux%u 1/%d  %s", jw, jh, scale, title == kWaiting ? "PENDING" : title.c_str());
}
void showLiveFrame() {
  if (!wifi()) return;
  const String base = sensorBase();
  if (!base.length()) return;
  const uint32_t fetchStart = millis();
  uint8_t* jpeg = nullptr;
  const size_t bytes = fetchJpeg(base + "/api/v1/live.jpg", &jpeg, kMaxLiveBytes);
  liveFetchMs += millis() - fetchStart;
  if (!bytes) return;
  const uint32_t drawStart = millis();
  // No clear between frames. The frame covers every visible pixel, so clearing first
  // only pushed another 134 KB over SPI — roughly doubling the per-frame draw cost —
  // and the black flash it left behind is what made the stream look like it was
  // repainting rather than moving.
  TJpgDec.drawJpg(-20, 0, jpeg, bytes);
  tft.setTextColor(ST77XX_CYAN); tft.setTextSize(1); tft.setCursor(8, 8); tft.print("LIVE  B1/B3 EXIT  B2 PAUSE");
  liveDrawMs += millis() - drawStart;
  liveFrames++;
  free(jpeg);
  if (millis() - liveStatAt >= 2000) {
    if (liveFrames) Serial.printf("Live: %.1f fps  fetch %lums  draw %lums (avg over %lu frames)\n",
                                  liveFrames * 1000.0 / (millis() - liveStatAt),
                                  static_cast<unsigned long>(liveFetchMs / liveFrames),
                                  static_cast<unsigned long>(liveDrawMs / liveFrames),
                                  static_cast<unsigned long>(liveFrames));
    liveStatAt = millis(); liveFrames = 0; liveFetchMs = 0; liveDrawMs = 0;
  }
}
void drawLivePaused() {
  tft.setTextColor(ST77XX_YELLOW); tft.setTextSize(2); tft.setCursor(8, 8); tft.print("PAUSED");
}

// Live view owns the landscape orientation and asks the sensor to drop to QVGA, so both
// are handed back on the way out rather than left set for the other pages.
void leavePage(uint8_t from) {
  if (from != PageLive) return;
  setLiveView(false);
  tft.setRotation(2);
}
void enterPage(uint8_t to) {
  if (to == PageLive) {
    livePaused = false;
    tft.setRotation(1);
    tft.fillScreen(ST77XX_BLACK);
    tft.setTextColor(ST77XX_CYAN); tft.setTextSize(1); tft.setCursor(8, 8); tft.print("Starting live view...");
    if (!setLiveView(true)) {
      tft.fillScreen(ST77XX_BLACK);
      tft.setTextColor(ST77XX_RED); tft.setTextSize(2); tft.setCursor(8, 8); tft.print("SENSOR");
      tft.setCursor(8, 30); tft.print("UNREACHABLE");
    }
    lastLiveFrame = 0;
    return;
  }
  if (to == PagePhoto) { drawPhotoPage(); return; }
  render();
}
void movePage(int delta) {
  const uint8_t from = page;
  leavePage(from);
  page = (page + delta + PageCount) % PageCount;
  enterPage(page);
}
void selectOnPage() {
  switch (page) {
    case PageStatus:
      // The capture POST blocks on a TLS handshake for seconds, and when the page
      // already shows the waiting state the redraw after it looks identical — so
      // acknowledge the press on screen before starting the request.
      message = "Requesting...";
      render();
      capture(); render();
      break;
    case PagePhoto: drawPhotoPage(); break;
    case PageLive:
      livePaused = !livePaused;
      if (livePaused) drawLivePaused();
      break;
    default: pollStatus(); render(); break;
  }
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
  Serial.printf("Buttons ready: B1=prev(%d) B2=select(%d) B3=next(%d)\n", kButtons[0], kButtons[1], kButtons[2]);
  Serial.printf("PSRAM: %u bytes\n", ESP.getPsramSize());
  xTaskCreate(buttonTask, "buttons", 2048, nullptr, 2, nullptr);
  tftSpi.begin(13, -1, 14, 11);
  tft.init(240, 280); tft.setRotation(2);
  // The library defaults to 32 MHz. Every live frame pushes 134 KB of pixels, so the
  // clock is the floor on frame time. 40 MHz is a modest step that stays well inside
  // what this panel and these breadboard jumpers carry reliably.
  tft.setSPISpeed(40000000);
  // No pre-swap: the decoder hands drawRGBBitmap() native uint16_t RGB565 and
  // Adafruit_SPITFT byte-swaps on its way to the panel. Pre-swapping here made that a
  // double swap, which decoded the geometry correctly but painted it in neon colors.
  TJpgDec.setJpgScale(1); TJpgDec.setSwapBytes(false); TJpgDec.setCallback(tftOutput);
  render(); wifi();
}
void loop() {
  if (pressed(ButtonPrev)) movePage(-1);
  if (pressed(ButtonNext)) movePage(1);
  if (pressed(ButtonSelect)) selectOnPage();
  if (page == PageLive) {
    if (!livePaused && millis() - lastLiveFrame >= kLiveFrameMs) { lastLiveFrame = millis(); showLiveFrame(); }
  } else if (millis() - lastStatusPoll >= kStatusPollMs) {
    lastStatusPoll = millis();
    pollStatus();
    // Only the pages that show status text need repainting on a poll. Redrawing the
    // photo page here would refetch a UXGA still every two seconds.
    if (page == PageStatus || page == PageDetail) render();
  }
  delay(5);
}
