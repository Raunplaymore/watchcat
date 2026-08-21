#pragma once

// Copy this file to watchcat_config.h and fill in local values.
// watchcat_config.h is intentionally ignored by Git.
#define WATCHCAT_WIFI_SSID ""
#define WATCHCAT_WIFI_PASSWORD ""
#define WATCHCAT_GATEWAY_BASE_URL "http://watchcat-gateway.local:3102"
// HTTPS URL requires the issuing CA certificate in PEM form. Leave empty for HTTP.
#define WATCHCAT_GATEWAY_TLS_CA_CERT ""
#define WATCHCAT_CAMERA_TOKEN ""

// Optional administrator monitor override when it reaches the gateway through HTTPS.
#define WATCHCAT_MONITOR_BASE_URL WATCHCAT_GATEWAY_BASE_URL
#define WATCHCAT_MONITOR_TLS_CA_CERT WATCHCAT_GATEWAY_TLS_CA_CERT

// Local-only live view for the administrator monitor. The sensor advertises
// this name with mDNS, so it does not require a fixed LAN IP address.
#define WATCHCAT_SENSOR_LOCAL_URL "http://watchcat-sensor.local"

// Optional radar node overrides. Defaults: the gateway URL/CA above and the
// sensor id "living-room-radar-1". The id must be on the gateway's
// WATCHCAT_RADAR_SENSORS allowlist when that variable is set.
// #define WATCHCAT_RADAR_SENSOR_ID "living-room-radar-1"
// #define WATCHCAT_RADAR_BASE_URL WATCHCAT_GATEWAY_BASE_URL
// #define WATCHCAT_RADAR_TLS_CA_CERT WATCHCAT_GATEWAY_TLS_CA_CERT
