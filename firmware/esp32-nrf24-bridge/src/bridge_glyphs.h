#pragma once

#include <Arduino_GFX_Library.h>

// Procedural vector glyphs. Origin = top-left of the bounding box; size = px
// width/height of that box. Stroke is rendered with anti-blob double-line
// where appropriate. Colors are RGB565.

namespace glyphs {

void init(Arduino_GFX *gfx);

void drawCamera(int x, int y, int size, uint16_t color);
void drawRadar(int x, int y, int size, uint16_t color, uint8_t frame);  // frame: 0..7
void drawLink(int x, int y, int size, uint16_t color);
void drawWarn(int x, int y, int size, uint16_t color);
void drawMoon(int x, int y, int size, uint16_t color);
void drawCheck(int x, int y, int size, uint16_t color);
void drawSignal(int x, int y, int size, uint16_t color, int8_t dbm);   // 4 bars
void drawBattery(int x, int y, int w, int h, uint16_t frame, uint16_t fill, int8_t percent);
void drawBmMark(int x, int y, int size, uint16_t color);  // 'BM' brand mono mark
void drawBoltKey(int x, int y, int size, uint16_t color); // small key-cap "button" hint

}  // namespace glyphs
