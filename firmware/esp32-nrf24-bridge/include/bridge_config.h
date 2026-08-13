#pragma once

// Waveshare ESP32-C6-LCD-1.47 — buttons (active LOW, INPUT_PULLUP)
// Until external UP/DOWN/SEL are wired: onboard BOOT = SELECT (GPIO0).
#define BTN_USE_BOOT_FALLBACK 1

#if BTN_USE_BOOT_FALLBACK
#define BTN_PIN_BOOT 9       // ESP32-C6 onboard BOOT (IO9, not IO0) — active LOW
#define BTN_ACTIVE_LOW 1
#define BTN_PIN_UP (-1)      // not connected yet
#define BTN_PIN_DOWN (-1)
#define BTN_PIN_SELECT BTN_PIN_BOOT
#else
#define BTN_PIN_UP 1
#define BTN_PIN_DOWN 3
#define BTN_PIN_SELECT 4
#define BTN_ACTIVE_LOW 1
#endif

// NRF24 on GPIO 0–4 (left header — bench bring-up; GP5 spare)
#define NRF_MISO_PIN 0
#define NRF_MOSI_PIN 1
#define NRF_SCK_PIN 2
#define NRF_CE_PIN 3
#define NRF_CSN_PIN 4
// GP5 free — future IRQ or second device

// Blackmagic Camera Service (lowercase for BLE stack)
#define BM_CAMERA_SERVICE_UUID "291d567a-6d75-11e6-8b77-86f30ca893d3"

// 1 = list every BLE advertiser (bench test); 0 = Blackmagic cameras only
#define BLE_SCAN_ALL_DEVICES 1

#define UI_LIST_MAX 12
#define UI_LIST_VISIBLE 2   // tiny screen — large text, few rows
#define UI_NAME_CHARS 12    // max chars at text size 2 (~172px wide)

// 1 = hold extra NRF wiring/status screen after boot splash (remove when stable)
#define BRIDGE_DEBUG_NRF_SPLASH 1
// 1 = verbose serial NRF probe + skip UI demo cycle during bench
#define BRIDGE_DEBUG_NRF_VERBOSE 1
#define BRIDGE_SKIP_UI_DEMO 1

// Bench: no dim/backlight-off; screen stays on (optional 5 min cap if re-enabled)
#define BRIDGE_POWER_SAVE_DISABLED 1
#define BRIDGE_DISPLAY_OFF_AFTER_MS (5UL * 60 * 1000)  // 5 min when save is on
