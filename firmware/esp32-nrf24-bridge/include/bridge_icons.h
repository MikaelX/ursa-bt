#pragma once

#include <Arduino_GFX_Library.h>

#include "bridge_ui.h"

enum class BridgeIcon : uint8_t {
  Idle,
  Ready,
  Scan,
  Link,
  Ok,
  Err,
  Camera,
  Search,
  Btn,
  Stop,
};

constexpr int kBridgeIconSize = 16;
constexpr int kBridgeIconLargeScale = 3;  // 48×48 px on panel

BridgeIcon bridgeIconForLinkState(LinkState state);
BridgeIcon bridgeIconForFooter(const char *footer);
void bridgeIconDraw(Arduino_GFX *gfx, BridgeIcon icon, int16_t x, int16_t y, uint16_t color);
void bridgeIconDrawLarge(Arduino_GFX *gfx, BridgeIcon icon, int16_t cx, int16_t cy, int scale,
                         uint16_t color);
