#include "bridge_text.h"

#include <pgmspace.h>
#include <string.h>

namespace btext {
namespace {
Arduino_GFX *g = nullptr;
const GFXfont *g_font = nullptr;
uint16_t g_fg = 0xFFFF, g_bg = 0x0000;
}  // namespace

void init(Arduino_GFX *gfx) { g = gfx; }

void setFont(const GFXfont *f) {
  g_font = f;
  g->setFont(f);
  g->setTextSize(1);
}

void setColor(uint16_t fg, uint16_t bg) {
  g_fg = fg;
  g_bg = bg;
  g->setTextColor(fg, bg);
}

int16_t width(const char *s) {
  if (!s || !*s) return 0;
  int16_t x1, y1;
  uint16_t w, h;
  g->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return (int16_t)w;
}

int16_t ascent() {
  if (!g_font) return 8;  // default 6x8 font
  // Approximate cap-height via 'A' bounds
  int16_t x1, y1;
  uint16_t w, h;
  g->getTextBounds("A", 0, 0, &x1, &y1, &w, &h);
  return (int16_t)h;
}

int16_t lineHeight() {
  if (!g_font) return 8;
  return (int16_t)pgm_read_byte(&g_font->yAdvance);
}

void drawAt(int16_t x, int16_t baselineY, const char *s) {
  if (!s) return;
  g->setCursor(x, baselineY);
  g->print(s);
}

void drawCentered(int16_t boxX, int16_t boxW, int16_t baselineY, const char *s) {
  if (!s) return;
  const int16_t w = width(s);
  const int16_t x = boxX + (boxW - w) / 2;
  g->setCursor(x, baselineY);
  g->print(s);
}

void drawCenteredTruncated(int16_t boxX, int16_t boxW, int16_t baselineY, const char *s) {
  if (!s || !*s) return;
  if (width(s) <= boxW) {
    drawCentered(boxX, boxW, baselineY, s);
    return;
  }
  char buf[40];
  size_t len = strlen(s);
  if (len >= sizeof(buf)) len = sizeof(buf) - 1;
  strncpy(buf, s, len);
  buf[len] = '\0';
  while (len > 1) {
    buf[len - 1] = '~';
    buf[len] = '\0';
    if (width(buf) <= boxW) break;
    len--;
  }
  drawCentered(boxX, boxW, baselineY, buf);
}

void drawTruncated(int16_t x, int16_t baselineY, int16_t maxW, const char *s) {
  if (!s || !*s) return;
  if (width(s) <= maxW) {
    drawAt(x, baselineY, s);
    return;
  }
  char buf[40];
  size_t len = strlen(s);
  if (len >= sizeof(buf)) len = sizeof(buf) - 1;
  strncpy(buf, s, len);
  buf[len] = '\0';

  while (len > 1) {
    buf[len - 1] = '~';
    buf[len] = '\0';
    if (width(buf) <= maxW) break;
    len--;
  }
  drawAt(x, baselineY, buf);
}

}  // namespace btext
