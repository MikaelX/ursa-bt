#pragma once

#include <stdint.h>

struct Nrf24Info {
  bool ok = false;
  uint8_t channel = 100;
  uint8_t radioId = 0;
  const char *bitrate = "250K";
};

bool nrf24Init();
bool nrf24Ok();
void nrf24GetInfo(Nrf24Info *out);
void nrf24DebugProbe();
void nrf24ReleaseBusForLcd();
