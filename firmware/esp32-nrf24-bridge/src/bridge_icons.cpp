#include "bridge_icons.h"

#include <pgmspace.h>
#include <string.h>

namespace {
// 16×16 monochrome, MSB-first (GFX drawBitmap)
constexpr int kW = 16;
constexpr int kH = 16;

const uint8_t ICON_CAMERA[] PROGMEM = {
    0x00, 0x00, 0x03, 0xc0, 0x07, 0xe0, 0x0f, 0xf0, 0x1f, 0xf8, 0x1c, 0x38, 0x1c, 0x38, 0x1f, 0xf8,
    0x0f, 0xf0, 0x0f, 0xf0, 0x07, 0xe0, 0x03, 0xc0, 0x02, 0x40, 0x02, 0x40, 0x00, 0x00, 0x00, 0x00,
};

const uint8_t ICON_CHECK[] PROGMEM = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x1e, 0x00, 0x3e, 0x00, 0x7c, 0x01, 0xf8, 0x03, 0xf0,
    0x07, 0xe0, 0x0f, 0xc0, 0x1f, 0x80, 0x3f, 0x00, 0x7e, 0x00, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x00,
};

const uint8_t ICON_ERR[] PROGMEM = {
    0x00, 0x00, 0x07, 0xe0, 0x1f, 0xf8, 0x3c, 0x3c, 0x78, 0x1e, 0x70, 0x0e, 0xe0, 0x07, 0xe0, 0x07,
    0xe0, 0x07, 0x70, 0x0e, 0x78, 0x1e, 0x3c, 0x3c, 0x1f, 0xf8, 0x07, 0xe0, 0x00, 0x00, 0x00, 0x00,
};

const uint8_t ICON_SEARCH[] PROGMEM = {
    0x07, 0xe0, 0x1c, 0x70, 0x38, 0x38, 0x30, 0x18, 0x60, 0x0c, 0x60, 0x0c, 0xc0, 0x06, 0xc6, 0x06,
    0xcc, 0x03, 0x98, 0x03, 0xb0, 0x01, 0x60, 0x03, 0x30, 0x06, 0x1f, 0xfc, 0x0f, 0xf8, 0x00, 0x00,
};

const uint8_t ICON_BTN[] PROGMEM = {
    0x00, 0x00, 0x07, 0xe0, 0x1f, 0xf8, 0x3f, 0xfc, 0x7f, 0xfe, 0x7f, 0xfe, 0x7f, 0xfe, 0x7f, 0xfe,
    0x7f, 0xfe, 0x7f, 0xfe, 0x3f, 0xfc, 0x1f, 0xf8, 0x07, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

const uint8_t ICON_STOP[] PROGMEM = {
    0x00, 0x00, 0x00, 0x00, 0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0,
    0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

constexpr uint16_t kIconBg = 0x0000;

void drawBitmapIcon(Arduino_GFX *gfx, const uint8_t *bmp, int16_t x, int16_t y, uint16_t color) {
  gfx->drawBitmap(x, y, bmp, kW, kH, color, kIconBg);
}

void drawBitmapScaled(Arduino_GFX *gfx, const uint8_t *bmp, int16_t x, int16_t y, int scale,
                      uint16_t color) {
  const int byteWidth = (kW + 7) / 8;
  for (int j = 0; j < kH; j++) {
    for (int i = 0; i < kW; i++) {
      const uint8_t byte = pgm_read_byte(&bmp[j * byteWidth + i / 8]);
      if (byte & (0x80 >> (i % 8))) {
        gfx->fillRect(x + i * scale, y + j * scale, scale, scale, color);
      }
    }
  }
}

void drawIconScan(Arduino_GFX *gfx, int16_t x, int16_t y, int16_t color, int scale) {
  const int cx = x + 3 * scale;
  const int cy = y + 13 * scale;
  const int dot = max(2, 2 * scale);
  gfx->fillCircle(cx, cy, dot, color);
  gfx->drawArc(cx, cy, 4 * scale, 5 * scale, 200, 305, color);
  gfx->drawArc(cx, cy, 8 * scale, 9 * scale, 200, 305, color);
  gfx->drawArc(cx, cy, 12 * scale, 13 * scale, 200, 305, color);
}

void drawIconLink(Arduino_GFX *gfx, int16_t x, int16_t y, uint16_t color, int scale) {
  gfx->drawCircle(x + 6 * scale, y + 8 * scale, 5 * scale, color);
  gfx->drawCircle(x + 11 * scale, y + 8 * scale, 5 * scale, color);
}

void drawIconIdle(Arduino_GFX *gfx, int16_t x, int16_t y, uint16_t color, int scale) {
  gfx->drawCircle(x + 8 * scale, y + 8 * scale, 6 * scale, color);
  gfx->drawFastHLine(x + 5 * scale, y + 8 * scale, 7 * scale, color);
}

void drawIconReady(Arduino_GFX *gfx, int16_t x, int16_t y, uint16_t color, int scale) {
  const int w = 10 * scale;
  gfx->drawFastHLine(x + 3 * scale, y + 5 * scale, w, color);
  gfx->drawFastHLine(x + 3 * scale, y + 8 * scale, w, color);
  gfx->drawFastHLine(x + 3 * scale, y + 11 * scale, w, color);
}
}  // namespace

BridgeIcon bridgeIconForLinkState(LinkState state) {
  switch (state) {
    case LinkState::Connected:
      return BridgeIcon::Ok;
    case LinkState::Scanning:
      return BridgeIcon::Scan;
    case LinkState::Connecting:
      return BridgeIcon::Link;
    case LinkState::Error:
      return BridgeIcon::Err;
    case LinkState::Ready:
      return BridgeIcon::Ready;
    case LinkState::Disconnected:
    default:
      return BridgeIcon::Idle;
  }
}

BridgeIcon bridgeIconForFooter(const char *footer) {
  if (footer == nullptr) return BridgeIcon::Btn;
  if (strstr(footer, "STOP") != nullptr) return BridgeIcon::Stop;
  if (strstr(footer, "LINK") != nullptr) return BridgeIcon::Link;
  if (strstr(footer, "SCAN") != nullptr) return BridgeIcon::Btn;
  if (strstr(footer, "TBD") != nullptr) return BridgeIcon::Link;
  return BridgeIcon::Btn;
}

void bridgeIconDraw(Arduino_GFX *gfx, BridgeIcon icon, int16_t x, int16_t y, uint16_t color) {
  if (gfx == nullptr) return;

  switch (icon) {
    case BridgeIcon::Camera:
      drawBitmapIcon(gfx, ICON_CAMERA, x, y, color);
      break;
    case BridgeIcon::Ok:
      drawBitmapIcon(gfx, ICON_CHECK, x, y, color);
      break;
    case BridgeIcon::Err:
      drawBitmapIcon(gfx, ICON_ERR, x, y, color);
      break;
    case BridgeIcon::Search:
      drawBitmapIcon(gfx, ICON_SEARCH, x, y, color);
      break;
    case BridgeIcon::Btn:
      drawBitmapIcon(gfx, ICON_BTN, x, y, color);
      break;
    case BridgeIcon::Stop:
      drawBitmapIcon(gfx, ICON_STOP, x, y, color);
      break;
    case BridgeIcon::Scan:
      drawIconScan(gfx, x, y, color, 1);
      break;
    case BridgeIcon::Link:
      drawIconLink(gfx, x, y, color, 1);
      break;
    case BridgeIcon::Idle:
      drawIconIdle(gfx, x, y, color, 1);
      break;
    case BridgeIcon::Ready:
      drawIconReady(gfx, x, y, color, 1);
      break;
  }
}

void bridgeIconDrawLarge(Arduino_GFX *gfx, BridgeIcon icon, int16_t cx, int16_t cy, int scale,
                         uint16_t color) {
  if (gfx == nullptr || scale < 1) return;

  const int16_t x = cx - (kW * scale) / 2;
  const int16_t y = cy - (kH * scale) / 2;

  switch (icon) {
    case BridgeIcon::Camera:
      drawBitmapScaled(gfx, ICON_CAMERA, x, y, scale, color);
      break;
    case BridgeIcon::Ok:
      drawBitmapScaled(gfx, ICON_CHECK, x, y, scale, color);
      break;
    case BridgeIcon::Err:
      drawBitmapScaled(gfx, ICON_ERR, x, y, scale, color);
      break;
    case BridgeIcon::Search:
      drawBitmapScaled(gfx, ICON_SEARCH, x, y, scale, color);
      break;
    case BridgeIcon::Btn:
      drawBitmapScaled(gfx, ICON_BTN, x, y, scale, color);
      break;
    case BridgeIcon::Stop:
      drawBitmapScaled(gfx, ICON_STOP, x, y, scale, color);
      break;
    case BridgeIcon::Scan:
      drawIconScan(gfx, x, y, color, scale);
      break;
    case BridgeIcon::Link:
      drawIconLink(gfx, x, y, color, scale);
      break;
    case BridgeIcon::Idle:
      drawIconIdle(gfx, x, y, color, scale);
      break;
    case BridgeIcon::Ready:
      drawIconReady(gfx, x, y, color, scale);
      break;
  }
}
