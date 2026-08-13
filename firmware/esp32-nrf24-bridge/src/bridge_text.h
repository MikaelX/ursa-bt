#pragma once

#include <Arduino_GFX_Library.h>
#include <gfxfont.h>

namespace btext {

void init(Arduino_GFX *gfx);

// Returns pixel width of the string under the currently-set font.
int16_t width(const char *s);
// Returns ascent (cap height) in px for the current font (0 if default font).
int16_t ascent();
// Total line height (font yAdvance, or 8 if default).
int16_t lineHeight();

void setFont(const GFXfont *f);
void setColor(uint16_t fg, uint16_t bg);

// Draw left-aligned at (x, baseline y). For custom GFXfont, y is the baseline.
void drawAt(int16_t x, int16_t baselineY, const char *s);
// Draw centered horizontally inside [x, x+w), baseline at y.
void drawCentered(int16_t boxX, int16_t boxW, int16_t baselineY, const char *s);
// Truncates with '~' if needed to fit in maxW px.
void drawTruncated(int16_t x, int16_t baselineY, int16_t maxW, const char *s);
// Truncate to fit, then center horizontally inside [boxX, boxX+boxW).
void drawCenteredTruncated(int16_t boxX, int16_t boxW, int16_t baselineY, const char *s);

}  // namespace btext
