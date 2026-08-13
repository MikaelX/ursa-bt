#include "bridge_glyphs.h"

namespace glyphs {
namespace {
Arduino_GFX *g = nullptr;

void thickCircle(int cx, int cy, int r, uint16_t c) {
  g->drawCircle(cx, cy, r, c);
  g->drawCircle(cx, cy, r - 1, c);
}

void thickRoundRect(int x, int y, int w, int h, int r, uint16_t c) {
  g->drawRoundRect(x, y, w, h, r, c);
  g->drawRoundRect(x + 1, y + 1, w - 2, h - 2, r - 1 < 1 ? 1 : r - 1, c);
}

void thickLine(int x0, int y0, int x1, int y1, uint16_t c) {
  g->drawLine(x0, y0, x1, y1, c);
  g->drawLine(x0 + 1, y0, x1 + 1, y1, c);
  g->drawLine(x0, y0 + 1, x1, y1 + 1, c);
}
}  // namespace

void init(Arduino_GFX *gfx) { g = gfx; }

// ---- Camera: rounded body with viewfinder bump + lens ring + dot ------
void drawCamera(int x, int y, int s, uint16_t c) {
  // body
  const int bw = s;
  const int bh = (s * 7) / 10;
  const int by = y + s - bh;
  thickRoundRect(x, by, bw, bh, 3, c);
  // viewfinder bump (top-center)
  const int vw = s / 3;
  const int vh = s / 8 + 1;
  thickRoundRect(x + (bw - vw) / 2, by - vh + 1, vw, vh + 1, 1, c);
  // lens ring
  const int cx = x + bw / 2;
  const int cy = by + bh / 2 + 1;
  const int r  = bh / 3;
  thickCircle(cx, cy, r, c);
  g->fillCircle(cx, cy, r / 2 < 1 ? 1 : r / 2, c);
  // record dot
  g->fillCircle(x + bw - 4, by + 4, 1, c);
}

// ---- Radar: concentric arcs sweeping + center dot ---------------------
void drawRadar(int x, int y, int s, uint16_t c, uint8_t f) {
  const int cx = x + s / 2;
  const int cy = y + s / 2;
  const int r1 = s / 6;
  const int r2 = s / 3;
  const int r3 = s / 2 - 1;

  g->fillCircle(cx, cy, max(2, s / 12), c);

  const float base = 20.0f + (float)f * 30.0f;
  g->drawArc(cx, cy, r1, r1 - 1, base,          base + 90.0f, c);
  g->drawArc(cx, cy, r2, r2 - 1, base + 30.0f,  base + 110.0f, c);
  g->drawArc(cx, cy, r3, r3 - 1, base + 60.0f,  base + 130.0f, c);
}

// ---- Link: two interlocked rounded oblongs ----------------------------
void drawLink(int x, int y, int s, uint16_t c) {
  const int linkW = (s * 5) / 8;
  const int linkH = s / 3;
  const int x1 = x;
  const int y1 = y + (s - linkH) / 2 - linkH / 4;
  const int x2 = x + s - linkW;
  const int y2 = y + (s - linkH) / 2 + linkH / 4;
  thickRoundRect(x1, y1, linkW, linkH, linkH / 2, c);
  thickRoundRect(x2, y2, linkW, linkH, linkH / 2, c);
}

// ---- Warning: triangle with exclamation -------------------------------
void drawWarn(int x, int y, int s, uint16_t c) {
  const int x0 = x + s / 2;
  const int y0 = y + 2;
  const int xL = x + 1;
  const int xR = x + s - 2;
  const int yB = y + s - 2;
  thickLine(x0, y0, xR, yB, c);
  thickLine(xR, yB, xL, yB, c);
  thickLine(xL, yB, x0, y0, c);
  // exclamation
  const int ex = x + s / 2;
  g->fillRect(ex - 1, y + s / 2 - s / 6, 2, s / 3, c);
  g->fillCircle(ex, y + s - 6, 1, c);
}

// ---- Moon (sleep) -----------------------------------------------------
void drawMoon(int x, int y, int s, uint16_t c) {
  const int cx = x + s / 2;
  const int cy = y + s / 2;
  const int r  = s / 2 - 1;
  g->fillCircle(cx, cy, r, c);
  // bite (subtract) — use bg-toned overlay by redrawing with same color shifted
  g->fillCircle(cx + r / 3, cy - r / 4, r - 2, 0x0000);
}

// ---- Checkmark --------------------------------------------------------
void drawCheck(int x, int y, int s, uint16_t c) {
  const int x0 = x + s / 6;
  const int y0 = y + s / 2;
  const int x1 = x + s / 2 - 1;
  const int y1 = y + s - s / 4;
  const int x2 = x + s - 2;
  const int y2 = y + s / 5;
  thickLine(x0, y0, x1, y1, c);
  thickLine(x1, y1, x2, y2, c);
}

// ---- Signal bars ------------------------------------------------------
void drawSignal(int x, int y, int s, uint16_t c, int8_t dbm) {
  int bars = 0;
  if (dbm > -55) bars = 4;
  else if (dbm > -65) bars = 3;
  else if (dbm > -75) bars = 2;
  else if (dbm > -85) bars = 1;

  const int gap = 1;
  const int bw  = (s - 3 * gap) / 4;
  for (int i = 0; i < 4; i++) {
    const int bh = ((s - 2) * (i + 1)) / 4;
    const int bx = x + i * (bw + gap);
    const int by = y + s - bh;
    if (i < bars) g->fillRoundRect(bx, by, bw, bh, 1, c);
    else          g->drawRoundRect(bx, by, bw, bh, 1, 0x2945);
  }
}

// ---- Battery ----------------------------------------------------------
void drawBattery(int x, int y, int w, int h, uint16_t frame, uint16_t fill, int8_t percent) {
  // body
  g->drawRoundRect(x, y, w, h, 2, frame);
  // tip
  g->fillRect(x + w, y + h / 3, 2, h - 2 * (h / 3), frame);
  if (percent < 0) return;
  if (percent > 100) percent = 100;
  const int innerX = x + 2;
  const int innerY = y + 2;
  const int innerW = w - 4;
  const int innerH = h - 4;
  const int fillW  = (innerW * percent) / 100;
  if (fillW > 0) g->fillRect(innerX, innerY, fillW, innerH, fill);
}

// ---- 'BM' brand mark — minimal monogram, scaled --------------------
void drawBmMark(int x, int y, int s, uint16_t c) {
  // Just bold "BM" letters drawn as filled rectangles, blocky monospace-ish
  // letterforms (scale-friendly). Width: s, height: s.
  const int h = s;
  const int colW = max(1, s / 12);
  const int letW = (s - colW * 3) / 2;  // two letters with gaps
  // letter B at x
  // simplified: just two vertical stubs and crossbars
  const int bx = x;
  g->fillRect(bx, y, colW, h, c);                    // B left bar
  g->fillRect(bx, y, letW, colW, c);                  // top
  g->fillRect(bx, y + h / 2 - colW / 2, letW, colW, c); // mid
  g->fillRect(bx, y + h - colW, letW, colW, c);       // bottom
  g->fillRect(bx + letW - colW, y, colW, h, c);       // B right bar

  // letter M at x + letW + colW
  const int mx = bx + letW + colW;
  g->fillRect(mx, y, colW, h, c);                       // M left bar
  g->fillRect(mx + letW - colW, y, colW, h, c);         // M right bar
  // diagonal V via two lines
  thickLine(mx, y, mx + letW / 2, y + h / 2, c);
  thickLine(mx + letW - 1, y, mx + letW / 2, y + h / 2, c);
}

void drawBoltKey(int x, int y, int s, uint16_t c) {
  // simple key cap
  thickRoundRect(x, y, s, s, 3, c);
  g->drawFastHLine(x + 3, y + s - 3, s - 6, c);
}

}  // namespace glyphs
