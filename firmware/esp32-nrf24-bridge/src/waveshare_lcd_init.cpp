#include "waveshare_lcd_init.h"

Arduino_DataBus *bus = new Arduino_HWSPI(15 /* DC */, 14 /* CS */, 7 /* SCK */, 6 /* MOSI */);

// Waveshare ESP32-C6-LCD-1.47 ships an **IPS** ST7789 panel.
// IPS=true tells the driver to use BGR order + send INVON (the panel
// firmware requires inverted addressing for correct colors). With IPS=false
// the panel renders nearly monochrome — confirmed on hardware.
Arduino_GFX *gfx = new Arduino_ST7789(
    bus, 21 /* RST */, 0 /* rotation */, true /* IPS */,
    172 /* width */, 320 /* height */,
    34 /* col_offset1 */, 0 /* row_offset1 */,
    34 /* col_offset2 */, 0 /* row_offset2 */);

namespace {
constexpr int32_t kSpiActiveHz = 80000000;
constexpr int32_t kSpiSaveHz = 40000000;
}  // namespace

void waveshare_lcd_init(void) {
  if (!gfx->begin(kSpiActiveHz)) {
    Serial.println("[ERR] gfx->begin() failed");
    return;
  }
  gfx->setRotation(0);
  gfx->fillScreen(RGB565_BLACK);
  // Backlight via power_manager (PWM dimmed)
}

void waveshareLcdSetPerformance(bool high) {
  if (!bus) return;
  bus->begin(high ? kSpiActiveHz : kSpiSaveHz);
}
