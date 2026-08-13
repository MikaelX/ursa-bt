// Minimal NRF24 bench test — Waveshare ESP32-C6-LCD-1.47
//
// Flash + monitor:
//   pio run -e nrf24_test -t upload -t monitor
//
// Wiring (left header): MISO=0 MOSI=1 SCK=2 CE=3 CSN=4  VCC=3V3 GND=GND

#include <Arduino.h>
#include <SPI.h>
#include <NRFLite.h>

#ifndef NRF_CE_PIN
#define NRF_CE_PIN 3
#define NRF_CSN_PIN 4
#define NRF_SCK_PIN 2
#define NRF_MOSI_PIN 1
#define NRF_MISO_PIN 0
#endif

NRFLite radio(Serial);

bool g_nrfOk = false;
const char *g_rateLabel = "none";

void serialLog(const char *msg) {
  Serial.println(msg);
  Serial.flush();
}

void serialInit() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 5000) {
    delay(10);
  }
  delay(300);
  serialLog("\n=== NRF24 bench test (NRFLite) ===");
  Serial.printf("[serial] USB ready, baud=115200, waited %lu ms\n",
                static_cast<unsigned long>(millis() - t0));
  Serial.flush();
}

bool tryInit(NRFLite::Bitrates rate, const char *label) {
  Serial.printf("\n[nrf] init %s ... ", label);
  Serial.flush();
  const uint8_t ok = radio.init(0, NRF_CE_PIN, NRF_CSN_PIN, rate, 100, 0);
  Serial.println(ok ? "OK" : "FAIL");
  radio.printDetails();
  Serial.flush();
  if (ok) g_rateLabel = label;
  return ok != 0;
}

void printSummary() {
  Serial.println("\n[nrf] --- status ---");
  Serial.printf("[nrf] link: %s (%s)\n", g_nrfOk ? "CONNECTED" : "NO LINK", g_rateLabel);
  if (g_nrfOk) {
    const uint8_t noise = radio.scanChannel(100, 64);
    Serial.printf("[nrf] ch100 noise=%u (0=quiet)\n", noise);
  } else {
    Serial.println("[nrf] hint: CONFIG 11111111 = no SPI reply");
  }
  Serial.flush();
}

void setup() {
  serialInit();

  Serial.printf("[nrf] pins CE=%d CSN=%d SCK=%d MOSI=%d MISO=%d\n", NRF_CE_PIN, NRF_CSN_PIN,
                NRF_SCK_PIN, NRF_MOSI_PIN, NRF_MISO_PIN);
  Serial.flush();

  pinMode(NRF_CE_PIN, OUTPUT);
  pinMode(NRF_CSN_PIN, OUTPUT);
  digitalWrite(NRF_CSN_PIN, HIGH);
  digitalWrite(NRF_CE_PIN, LOW);
  pinMode(NRF_MISO_PIN, INPUT);
  Serial.printf("[nrf] MISO idle (CSN high) = %d\n", digitalRead(NRF_MISO_PIN));
  Serial.flush();

  SPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

  g_nrfOk = tryInit(NRFLite::BITRATE250KBPS, "250KBPS");
  if (!g_nrfOk) g_nrfOk = tryInit(NRFLite::BITRATE1MBPS, "1MBPS");
  if (!g_nrfOk) g_nrfOk = tryInit(NRFLite::BITRATE2MBPS, "2MBPS");

  printSummary();
  serialLog("[serial] setup done — heartbeat every 2s (press RST to re-run setup)");
}

void loop() {
  static uint32_t lastMs = 0;
  static uint32_t lastSummaryMs = 0;
  static bool firstLoop = true;
  const uint32_t now = millis();

  if (firstLoop) {
    firstLoop = false;
    printSummary();  // repeat for monitors opened after boot
  }

  if (now - lastMs >= 2000) {
    lastMs = now;
    Serial.printf("[nrf] alive %lu ms | %s\n", static_cast<unsigned long>(now),
                  g_nrfOk ? "CONNECTED" : "NO LINK");
    Serial.flush();
  }

  if (now - lastSummaryMs >= 30000) {
    lastSummaryMs = now;
    printSummary();
  }

  delay(20);
}
