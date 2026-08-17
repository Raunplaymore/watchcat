#include <Arduino.h>
#include "esp_camera.h"

namespace {
// Seeed Studio XIAO ESP32S3 Sense / OV3660 official camera pin map, matching
// CAMERA_MODEL_XIAO_ESP32S3 in the Arduino core's camera_pins.h. Keep d2/d1 as
// 18/17 (Y4/Y3); swapping them corrupts the JPEG byte stream.
camera_config_t kCamera = {
  .pin_pwdn = -1, .pin_reset = -1, .pin_xclk = 10, .pin_sccb_sda = 40, .pin_sccb_scl = 39,
  .pin_d7 = 48, .pin_d6 = 11, .pin_d5 = 12, .pin_d4 = 14, .pin_d3 = 16, .pin_d2 = 18,
  .pin_d1 = 17, .pin_d0 = 15, .pin_vsync = 38, .pin_href = 47, .pin_pclk = 13,
  .xclk_freq_hz = 20000000, .ledc_timer = LEDC_TIMER_0, .ledc_channel = LEDC_CHANNEL_0,
  .pixel_format = PIXFORMAT_JPEG, .frame_size = FRAMESIZE_UXGA, .jpeg_quality = 12,
  .fb_count = 1, .fb_location = CAMERA_FB_IN_PSRAM, .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
};
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Official CameraWebServer-compatible XIAO camera probe starting");
  if (psramFound()) {
    kCamera.jpeg_quality = 10;
    kCamera.fb_count = 2;
    kCamera.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    kCamera.frame_size = FRAMESIZE_SVGA;
    kCamera.fb_location = CAMERA_FB_IN_DRAM;
  }
  const esp_err_t result = esp_camera_init(&kCamera);
  if (result != ESP_OK) {
    Serial.printf("CAMERA_PROBE_FAILED: 0x%lx\n", static_cast<unsigned long>(result));
    return;
  }
  Serial.println("CAMERA_PROBE_OK");
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) {
    Serial.println("FRAME_CAPTURE_FAILED");
    return;
  }
  Serial.printf("FRAME_CAPTURE_OK: %u bytes\n", frame->len);
  esp_camera_fb_return(frame);
}

void loop() { delay(1000); }
