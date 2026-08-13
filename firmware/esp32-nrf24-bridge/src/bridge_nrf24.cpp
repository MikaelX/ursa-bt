#include "bridge_nrf24.h"

#include <SPI.h>

#include "NRFLite.h"
#include "bridge_config.h"

namespace {
#if BRIDGE_DEBUG_NRF_VERBOSE
NRFLite g_radio(Serial);
#else
NRFLite g_radio;
#endif
bool g_ok = false;
uint8_t g_channel = 100;
const char *g_bitrate = "250 kbps";

void logPins() {
  Serial.printf("[nrf] pins CE=%d CSN=%d SCK=%d MOSI=%d MISO=%d\n", NRF_CE_PIN, NRF_CSN_PIN,
                NRF_SCK_PIN, NRF_MOSI_PIN, NRF_MISO_PIN);
}

void prepGpio() {
  // LCD gfx->begin() owns the shared SPI peripheral first — release before NRF pins.
  SPI.end();
  delay(5);

  pinMode(NRF_CE_PIN, OUTPUT);
  pinMode(NRF_CSN_PIN, OUTPUT);
  digitalWrite(NRF_CSN_PIN, HIGH);
  digitalWrite(NRF_CE_PIN, LOW);
  pinMode(NRF_MISO_PIN, INPUT);
}

bool tryInitRate(NRFLite::Bitrates rate, const char *label) {
#if BRIDGE_DEBUG_NRF_VERBOSE
  Serial.printf("[nrf] init %s ... ", label);
  Serial.flush();
#endif
  const uint8_t ok = g_radio.init(0, NRF_CE_PIN, NRF_CSN_PIN, rate, 100, 0);
#if BRIDGE_DEBUG_NRF_VERBOSE
  Serial.println(ok ? "OK" : "FAIL");
  g_radio.printDetails();
  Serial.flush();
#endif
  return ok != 0;
}

bool initRadio() {
  struct Try {
    NRFLite::Bitrates rate;
    const char *name;
  };
  const Try tries[] = {{NRFLite::BITRATE250KBPS, "250 kbps"},
                       {NRFLite::BITRATE1MBPS, "1 Mbps"},
                       {NRFLite::BITRATE2MBPS, "2 Mbps"}};

  for (uint8_t i = 0; i < sizeof(tries) / sizeof(tries[0]); i++) {
    if (i > 0) {
      g_radio.powerDown();
      delay(20);
    }
    if (tryInitRate(tries[i].rate, tries[i].name)) {
      g_ok = true;
      g_channel = 100;
      g_bitrate = tries[i].name;
      return true;
    }
  }
  g_ok = false;
  return false;
}
}  // namespace

void nrf24DebugProbe() {
  Serial.println("[nrf] === probe ===");
  logPins();
  prepGpio();
  Serial.printf("[nrf] MISO idle (CSN high) = %d\n", digitalRead(NRF_MISO_PIN));

  SPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

  if (initRadio()) {
    const uint8_t noise = g_radio.scanChannel(100, 64);
    Serial.printf("[nrf] ch100 noise=%u (0=quiet)\n", noise);
  } else {
    Serial.println("[nrf] all bitrates failed");
    Serial.println("[nrf] hints: CONFIG 11111111 = no SPI; check wiring / 3.3V");
  }
}

bool nrf24Init() {
  prepGpio();
  SPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

#if BRIDGE_DEBUG_NRF_VERBOSE
  Serial.println("[nrf] === probe ===");
  logPins();
  Serial.printf("[nrf] MISO idle (CSN high) = %d\n", digitalRead(NRF_MISO_PIN));
  Serial.flush();
#endif

  if (initRadio()) {
#if BRIDGE_DEBUG_NRF_VERBOSE
    const uint8_t noise = g_radio.scanChannel(100, 64);
    Serial.printf("[nrf] ch100 noise=%u (0=quiet)\n", noise);
    Serial.flush();
#endif
    return true;
  }

#if BRIDGE_DEBUG_NRF_VERBOSE
  Serial.println("[nrf] all bitrates failed");
  Serial.println("[nrf] hints: CONFIG 11111111 = no SPI; check wiring / 3.3V");
  Serial.flush();
#endif
  return false;
}

bool nrf24Ok() { return g_ok; }

void nrf24GetInfo(Nrf24Info *out) {
  if (!out) return;
  out->ok = g_ok;
  out->channel = g_channel;
  out->radioId = 0;
  out->bitrate = g_bitrate;
}

void nrf24ReleaseBusForLcd() {
  // Hand shared SPI back to the panel bus (called after init check, before UI draw).
  SPI.end();
  delay(2);
}
