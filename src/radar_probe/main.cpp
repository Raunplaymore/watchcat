#include <Arduino.h>

// Phase R0 observation tool (docs/ld2454-cat-tracker-design.md): print the
// LD2454's raw UART bytes as hex so frame boundaries, byte order, and units can
// be checked against the vendor manual before any parser exists. Receive only —
// no Wi-Fi, no Pi upload, no configuration commands.
//
// Wiring: LD2454 5V(1) -> VBUS, GND(2) -> GND, TX(3) -> kRadarRx.
// kRadarTx stays unconnected until configuration commands are needed.
constexpr int kRadarRx = 20, kRadarTx = 21;  // XIAO C3 silk D7/RX and D6/TX; free because logs go over USB
constexpr uint32_t kRadarBaud = 256000;      // vendor-documented default
// A pause in the stream is the best frame-boundary hint before the format is
// known, so a line also breaks after this much idle time, marked with "..".
constexpr uint32_t kIdleBreakMs = 20;

HardwareSerial radar(1);

void setup() {
  Serial.begin(115200);
  delay(2000);  // the USB CDC console needs a moment to enumerate before the first lines
  // A UART line idles high, so with a pulldown a connected-and-powered radar TX
  // reads ~100/100 high; a broken wire or unpowered module reads ~0. Sampled
  // before the UART claims the pin.
  pinMode(kRadarRx, INPUT_PULLDOWN);
  delay(50);
  int idleHigh = 0;
  for (int i = 0; i < 100; i++) { idleHigh += digitalRead(kRadarRx); delayMicroseconds(200); }
  Serial.printf("RX line: %d/100 high\n", idleHigh);
  radar.begin(kRadarBaud, SERIAL_8N1, kRadarRx, kRadarTx);
  Serial.printf("LD2454 probe: RX=GPIO%d TX=GPIO%d baud=%lu\n", kRadarRx, kRadarTx, static_cast<unsigned long>(kRadarBaud));
}

void loop() {
  static uint32_t total = 0, lastReportAt = 0, lastByteAt = 0;
  static int col = 0;
  while (radar.available()) {
    const uint8_t value = radar.read();
    if (col == 0) Serial.printf("%8lu | ", static_cast<unsigned long>(millis()));
    Serial.printf("%02X ", value);
    lastByteAt = millis();
    total++;
    if (++col == 16) { Serial.println(); col = 0; }
  }
  if (col && millis() - lastByteAt >= kIdleBreakMs) { Serial.println(".."); col = 0; }
  if (millis() - lastReportAt >= 5000) {
    lastReportAt = millis();
    Serial.printf("-- %lu bytes total, heap %lu\n", static_cast<unsigned long>(total), static_cast<unsigned long>(ESP.getFreeHeap()));
  }
}
