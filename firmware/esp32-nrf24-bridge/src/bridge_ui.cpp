#include "bridge_ui.h"

#include "bridge_config.h"
#include "bridge_glyphs.h"
#include "bridge_led.h"
#include "bridge_text.h"

#include "fonts/FreeSans9pt7b.h"
#include "fonts/FreeSans12pt7b.h"
#include "fonts/FreeSansBold9pt7b.h"
#include "fonts/FreeSansBold12pt7b.h"
#include "fonts/FreeSansBold18pt7b.h"
#include "fonts/FreeSansBold24pt7b.h"

namespace {
// ---- palette (RGB565) — matched to mockup-v1 -----------------------------
constexpr uint16_t kBg          = 0x0000;  // pure black chassis
constexpr uint16_t kCard        = 0x10A2;  // ~#111827 elevated surface
constexpr uint16_t kCardHi      = 0x18E3;  // hover/selected
constexpr uint16_t kBorder      = 0x2945;  // hairline
constexpr uint16_t kWhite       = 0xFFFF;
constexpr uint16_t kText        = 0xEF7D;  // #E6E8EE primary text
constexpr uint16_t kMuted       = 0x9CD3;  // #9CA3AF secondary
constexpr uint16_t kDim         = 0x4208;

constexpr uint16_t kCyan        = 0x3D9F;  // #38BDF8
constexpr uint16_t kAmber       = 0xFD20;  // #F59E0B
constexpr uint16_t kIndigo      = 0x632C;  // #6366F1
constexpr uint16_t kGreen       = 0x2604;  // #22C55E
constexpr uint16_t kRed         = 0xDA29;  // #DC2626

// ---- layout --------------------------------------------------------------
constexpr int kW = 172, kH = 320;
constexpr int kPad        = 8;
constexpr int kStatusH    = 22;
constexpr int kHeroY      = kStatusH + 4;
constexpr int kHeroH      = 56;
constexpr int kFooterH    = 32;
constexpr int kRowH       = 52;

Arduino_GFX *g = nullptr;

LinkState   g_link  = LinkState::Disconnected;
TallyState  g_tally = TallyState::Off;
char g_detail[24]  = "IDLE";
char g_footer[28]  = "SEL=SCAN";
char g_active[32]  = "";
char g_names[UI_LIST_MAX][32];
int8_t g_rssi[UI_LIST_MAX];
int g_nameCount = 0;
int g_selected  = 0;
int g_scroll    = 0;
int8_t g_battery = -1;
bool g_sleep = false;

bool g_nrfOk = false;
uint8_t g_nrfChannel = 100;
char g_nrfBitrate[8] = "250K";
bool g_nrfScreen = false;

uint32_t g_tickMs = 0;
uint8_t  g_animFrame = 0;
bool     g_animDirty = false;
bool     g_animOnly  = false;
LinkState g_lastDrawnLink = LinkState::Disconnected;
TallyState g_lastDrawnTally = TallyState::Off;
bool g_lastDrawnSleep = false;
bool g_lastDrawnNrfScreen = false;
int g_lastDrawnNameCount = -1;

uint16_t accent() {
  switch (g_link) {
    case LinkState::Connected:  return kGreen;
    case LinkState::Scanning:   return kAmber;
    case LinkState::Connecting: return kIndigo;
    case LinkState::Error:      return kRed;
    case LinkState::Ready:      return kCyan;
    default:                    return kCyan;
  }
}

// ====================== status bar =====================================
void drawNrfStatusChip(int x, int baselineY) {
  const uint16_t col = g_nrfOk ? kGreen : kRed;
  const int dotY = baselineY - 7;
  g->fillCircle(x + 3, dotY, 3, col);
  g->drawCircle(x + 3, dotY, 3, kBorder);

  char chip[12];
  if (g_nrfOk) {
    snprintf(chip, sizeof(chip), "CH%u", static_cast<unsigned>(g_nrfChannel));
  } else {
    strncpy(chip, "NO RF", sizeof(chip));
    chip[sizeof(chip) - 1] = '\0';
  }
  btext::setFont(&FreeSans9pt7b);
  btext::setColor(g_nrfOk ? kMuted : kRed, kBg);
  btext::drawAt(x + 10, baselineY, chip);
}

void drawStatusBar() {
  g->fillRect(0, 0, kW, kStatusH, kBg);

  glyphs::drawBmMark(kPad, 5, 14, kMuted);
  drawNrfStatusChip(kPad + 18, kStatusH - 6);

  if (g_battery >= 0) {
    uint16_t col = kGreen;
    if (g_battery <= 35) col = kAmber;
    if (g_battery <= 15) col = kRed;
    glyphs::drawBattery(kW - kPad - 22, 6, 20, 10, kMuted, col, g_battery);
  }

  g->drawFastHLine(0, kStatusH - 1, kW, kBorder);
}

// ====================== hero pill =====================================
void drawHero() {
  const uint16_t a = accent();
  g->fillRect(0, kHeroY, kW, kHeroH, kBg);

  // pill card
  const int px = kPad;
  const int py = kHeroY + 4;
  const int pw = kW - 2 * kPad;
  const int ph = kHeroH - 8;
  g->fillRoundRect(px, py, pw, ph, 12, kCard);
  g->drawRoundRect(px, py, pw, ph, 12, a);
  g->drawRoundRect(px + 1, py + 1, pw - 2, ph - 2, 11, a);

  // icon (left) + text (right)
  const int iconS = 22;
  const int iconX = px + 14;
  const int iconY = py + (ph - iconS) / 2;

  switch (g_link) {
    case LinkState::Scanning:   glyphs::drawRadar(iconX, iconY, iconS, a, g_animFrame & 0x07); break;
    case LinkState::Connecting: glyphs::drawLink(iconX, iconY, iconS, a); break;
    case LinkState::Connected:  glyphs::drawCheck(iconX, iconY, iconS, a); break;
    case LinkState::Error:      glyphs::drawWarn(iconX, iconY, iconS, a); break;
    default:
      if (g_nrfScreen) glyphs::drawLink(iconX, iconY, iconS, a);
      else             glyphs::drawCamera(iconX, iconY, iconS, a);
      break;
  }

  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(a, kCard);
  const int textX = iconX + iconS + 10;
  const int textW = (px + pw) - textX - 10;
  btext::drawTruncated(textX, py + ph - 14, textW, g_detail);
}

// ====================== footer ========================================
void drawFooter() {
  const uint16_t a = accent();
  const int y = kH - kFooterH;
  g->fillRect(0, y, kW, kFooterH, kBg);

  // Footer card — like the mockup: full-width rounded pill, sits at bottom.
  const int cx = kPad;
  const int cy = y + 4;
  const int cw = kW - 2 * kPad;
  const int ch = kFooterH - 8;
  g->fillRoundRect(cx, cy, cw, ch, 8, kCard);
  g->drawRoundRect(cx, cy, cw, ch, 8, kBorder);

  btext::setFont(&FreeSansBold9pt7b);
  const int baseY = cy + ch - 8;

  const bool muted = (g_link == LinkState::Connected);
  btext::setColor(muted ? kMuted : a, kCard);

  if (g_nameCount > 0 && g_link == LinkState::Ready) {
    btext::drawTruncated(cx + 10, baseY, cw - 20 - 30, g_footer);
    char pos[10];
    snprintf(pos, sizeof(pos), "%d/%d", g_selected + 1, g_nameCount);
    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kMuted, kCard);
    const int pw = btext::width(pos);
    btext::drawAt(cx + cw - 10 - pw, baseY, pos);
    return;
  }

  btext::drawCenteredTruncated(cx, cw, baseY, g_footer);
}

// ====================== skeleton (scanning) ===========================
namespace {
constexpr int kSkRows = 3;
constexpr int kSkRowH = 36;
constexpr int kSkGap  = 10;
constexpr int kSkShimmerW = 36;

struct SkRect { int x, y, w, h; };

SkRect skRow(int i) {
  const int listY = kHeroY + kHeroH + kPad;
  const int listH = kH - listY - kFooterH - kPad;
  const int totalH = kSkRows * kSkRowH + (kSkRows - 1) * kSkGap;
  const int top = listY + (listH - totalH) / 2;
  return { kPad, top + i * (kSkRowH + kSkGap), kW - 2 * kPad, kSkRowH };
}

int skShimmerX(int i) {
  const SkRect r = skRow(i);
  return r.x + ((r.w - kSkShimmerW) * ((g_animFrame + i * 4) % 32)) / 31;
}

uint8_t g_lastShimmerFrame = 0xFF;  // sentinel
}  // namespace

// Draws the row cards + circle indicators once (no shimmer).
void drawSkeletonStatic() {
  for (int i = 0; i < kSkRows; i++) {
    const SkRect r = skRow(i);
    g->fillRoundRect(r.x, r.y, r.w, r.h, 10, kCard);
    g->fillCircle(r.x + 14, r.y + r.h / 2, 5, kDim);
  }
  g_lastShimmerFrame = 0xFF;
}

// Draws only the moving shimmer rect, erasing the previous one. Cheap.
void drawSkeletonShimmer() {
  // If we don't know previous position (full repaint), just paint new.
  for (int i = 0; i < kSkRows; i++) {
    const SkRect r = skRow(i);

    if (g_lastShimmerFrame != 0xFF) {
      // erase previous shimmer at its old position
      const int prevX = r.x + ((r.w - kSkShimmerW) * ((g_lastShimmerFrame + i * 4) % 32)) / 31;
      g->fillRoundRect(prevX, r.y + 4, kSkShimmerW, r.h - 8, 8, kCard);
    }
    const int sx = skShimmerX(i);
    g->fillRoundRect(sx, r.y + 4, kSkShimmerW, r.h - 8, 8, kCardHi);
  }
  g_lastShimmerFrame = g_animFrame;
}

// ====================== list / scan / empty ===========================
void drawListArea() {
  const uint16_t a = accent();
  const int listY = kHeroY + kHeroH + kPad;
  const int listH = kH - listY - kFooterH - kPad;
  g->fillRect(0, listY, kW, listH, kBg);

  if (g_nameCount == 0) {
    if (g_link == LinkState::Scanning) {
      drawSkeletonStatic();
      drawSkeletonShimmer();
      btext::setFont(&FreeSans9pt7b);
      btext::setColor(kMuted, kBg);
      btext::drawCentered(0, kW, listY + listH - 6, "searching...");
      return;
    }

    // Mockup home layout: action card + status badge stacked
    const int cx = kPad;
    const int cw = kW - 2 * kPad;

    // ---- action card: "Tap SEL to scan" -------------------------------
    const int actH = 90;
    const int actY = listY + 12;
    g->fillRoundRect(cx, actY, cw, actH, 14, kCard);
    g->drawRoundRect(cx, actY, cw, actH, 14, kBorder);

    // small camera-ish icon (use camera glyph as "tap" stand-in)
    const int gs = 30;
    glyphs::drawCamera(cx + (cw - gs) / 2, actY + 14, gs, kCyan);

    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kText, kCard);
    btext::drawCentered(cx, cw, actY + actH - 12, "Tap SEL to scan");

    // ---- status badge: "No camera linked" -----------------------------
    const int badgeH = 40;
    const int badgeY = actY + actH + 14;
    g->fillRoundRect(cx, badgeY, cw, badgeH, 10, kCard);
    g->drawRoundRect(cx, badgeY, cw, badgeH, 10, kBorder);

    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kMuted, kCard);
    btext::drawCentered(cx, cw, badgeY + badgeH - 14, "No camera linked");
    return;
  }

  // camera list — up to 3 rows
  const int rowsTop = listY + 2;
  const int visible = 3;
  for (int row = 0; row < visible; row++) {
    const int idx = g_scroll + row;
    if (idx >= g_nameCount) break;
    const int yy = rowsTop + row * kRowH;
    if (yy + kRowH - 6 > kH - kFooterH - kPad) break;

    const bool sel = idx == g_selected;
    const int rx = kPad;
    const int rw = kW - 2 * kPad;
    const int rh = kRowH - 8;

    g->fillRoundRect(rx, yy, rw, rh, 10, sel ? kCardHi : kCard);
    if (sel) {
      g->drawRoundRect(rx, yy, rw, rh, 10, a);
      g->drawRoundRect(rx + 1, yy + 1, rw - 2, rh - 2, 9, a);
    } else {
      g->drawRoundRect(rx, yy, rw, rh, 10, kBorder);
    }

    const uint16_t iconC = sel ? a : kMuted;
    glyphs::drawCamera(rx + 8, yy + (rh - 20) / 2, 20, iconC);

    btext::setFont(&FreeSansBold9pt7b);
    btext::setColor(sel ? kText : kMuted, sel ? kCardHi : kCard);
    const int16_t nameBaseline = yy + (rh + btext::ascent()) / 2;
    btext::drawTruncated(rx + 8 + 20 + 8, nameBaseline, rw - 36 - 28, g_names[idx]);

    if (g_rssi[idx] != 0) {
      glyphs::drawSignal(rx + rw - 24, yy + (rh - 16) / 2, 16, iconC, g_rssi[idx]);
    }
  }
}

// ====================== linking ========================================
void drawLinking() {
  const uint16_t a = accent();
  const int y0 = kHeroY + kHeroH + kPad;
  const int areaH = kH - y0 - kFooterH;
  g->fillRect(0, y0, kW, areaH, kBg);

  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kBg);
  btext::drawCenteredTruncated(kPad, kW - 2 * kPad, y0 + 28,
                               g_active[0] ? g_active : "Camera");

  // spinner ring with rotating dot
  const int cx = kW / 2;
  const int cy = y0 + areaH / 2 + 10;
  const int r = 28;
  g->drawCircle(cx, cy, r, kBorder);
  g->drawCircle(cx, cy, r - 1, kBorder);
  const float ang = g_animFrame * (2.0f * PI / 32.0f);
  const int dx = cx + (int)(cosf(ang) * r);
  const int dy = cy + (int)(sinf(ang) * r);
  g->fillCircle(dx, dy, 5, a);
  g->fillCircle(dx, dy, 3, kWhite);

  btext::setFont(&FreeSans9pt7b);
  btext::setColor(kMuted, kBg);
  btext::drawCentered(0, kW, cy + r + 24, "Establishing link...");
}

// ====================== linked + tally =================================
namespace {
struct TallyBox { int x, y, w, h; uint16_t fill; };

TallyBox tallyBox() {
  const int y0 = kHeroY + kHeroH + kPad;
  TallyBox b{kPad, y0 + 6, kW - 2 * kPad, 116, kCard};
  if (g_tally == TallyState::Program) b.fill = kRed;
  else if (g_tally == TallyState::Preview) b.fill = kGreen;
  return b;
}

// Centered REC group at bottom of tally box. Unused since LIVE/PVW now
// fills the whole tally block on its own — kept in case we want it back.
[[maybe_unused]] void drawRecGroup(const TallyBox &b, bool brightDot) {
  btext::setFont(&FreeSansBold12pt7b);
  const int textW = btext::width("REC");
  const int dotR = 6;
  const int gap = 6;
  const int groupW = dotR * 2 + gap + textW;
  const int groupX = b.x + (b.w - groupW) / 2;
  const int dotCx = groupX + dotR;
  const int dotCy = b.y + b.h - 16;

  // clear the row area first so partial redraws don't smear
  g->fillRect(b.x + 4, dotCy - dotR - 2, b.w - 8, dotR * 2 + 4, b.fill);

  g->fillCircle(dotCx, dotCy, brightDot ? dotR : dotR - 2, kWhite);
  btext::setColor(kWhite, b.fill);
  btext::drawAt(groupX + dotR * 2 + gap, dotCy + 6, "REC");
}
}  // namespace

void drawLinked() {
  const int y0 = kHeroY + kHeroH + kPad;
  const int areaH = kH - y0 - kFooterH;
  g->fillRect(0, y0, kW, areaH, kBg);

  const TallyBox b = tallyBox();
  const char *label = "IDLE";
  uint16_t labelCol = kMuted;

  if (g_tally == TallyState::Program) { label = "LIVE"; labelCol = kWhite; }
  else if (g_tally == TallyState::Preview) { label = "PVW"; labelCol = kWhite; }

  g->fillRoundRect(b.x, b.y, b.w, b.h, 14, b.fill);
  g->drawRoundRect(b.x, b.y, b.w, b.h, 14, b.fill == kCard ? kBorder : b.fill);

  btext::setFont(&FreeSansBold24pt7b);
  btext::setColor(labelCol, b.fill);
  btext::drawCentered(b.x, b.w, b.y + b.h / 2 + 12, label);

  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kBg);
  btext::drawCenteredTruncated(kPad, kW - 2 * kPad, b.y + b.h + 26,
                               g_active[0] ? g_active : g_detail);
}

[[maybe_unused]] void partialRedrawRec() {
  if (g_tally != TallyState::Program) return;
  drawRecGroup(tallyBox(), (g_animFrame >> 3) & 1);
}

// Partial redraw — only the spinner ring's rotating dot.
// Full-screen tally — LIVE/PVW fills the panel, only camera name overlaid.
void drawTallyFullScreen() {
  uint16_t fill = kCard;
  const char *label = "IDLE";
  if (g_tally == TallyState::Program)      { fill = kRed;   label = "LIVE"; }
  else if (g_tally == TallyState::Preview) { fill = kGreen; label = "PVW";  }

  g->fillScreen(fill);

  btext::setFont(&FreeSansBold24pt7b);
  btext::setColor(kWhite, fill);
  btext::drawCentered(0, kW, kH / 2 + 8, label);

  if (g_active[0]) {
    btext::setFont(&FreeSansBold12pt7b);
    btext::setColor(kWhite, fill);
    btext::drawCenteredTruncated(kPad, kW - 2 * kPad, kH - 14, g_active);
  }
}

void partialRedrawLinkingSpinner() {
  const uint16_t a = accent();
  const int y0 = kHeroY + kHeroH + kPad;
  const int areaH = kH - y0 - kFooterH;
  const int cx = kW / 2;
  const int cy = y0 + areaH / 2 + 10;
  const int r = 28;
  // erase the dot ring band, redraw track + new dot
  g->fillRect(cx - r - 6, cy - r - 6, (r + 6) * 2, (r + 6) * 2, kBg);
  g->drawCircle(cx, cy, r, kBorder);
  g->drawCircle(cx, cy, r - 1, kBorder);
  const float ang = g_animFrame * (2.0f * PI / 32.0f);
  const int dx = cx + (int)(cosf(ang) * r);
  const int dy = cy + (int)(sinf(ang) * r);
  g->fillCircle(dx, dy, 5, a);
  g->fillCircle(dx, dy, 3, kWhite);
}

// ====================== error ==========================================
void drawError() {
  const int y0 = kHeroY + kHeroH + kPad;
  const int areaH = kH - y0 - kFooterH;
  g->fillRect(0, y0, kW, areaH, kBg);

  const int cx = kPad;
  const int cy = y0 + 8;
  const int cw = kW - 2 * kPad;
  const int ch = 132;
  g->fillRoundRect(cx, cy, cw, ch, 12, kCard);
  g->drawRoundRect(cx, cy, cw, ch, 12, kRed);

  const int innerX = cx + 12;
  const int innerW = cw - 24;

  glyphs::drawWarn(cx + (cw - 28) / 2, cy + 10, 28, kRed);

  char title[36];
  if (g_active[0]) {
    snprintf(title, sizeof(title), "Lost link to %s", g_active);
  } else {
    strncpy(title, "Lost link to camera", sizeof(title));
    title[sizeof(title) - 1] = '\0';
  }

  btext::setFont(&FreeSansBold9pt7b);
  btext::setColor(kText, kCard);
  btext::drawCenteredTruncated(innerX, innerW, cy + 52, title);

  btext::setFont(&FreeSans9pt7b);
  btext::setColor(kMuted, kCard);
  btext::drawCenteredTruncated(innerX, innerW, cy + 72,
                               "Move closer or check");
  btext::drawCenteredTruncated(innerX, innerW, cy + 86,
                               "that the camera is on.");
}

// ====================== sleep =========================================
void drawNrfSettings() {
  const int y0 = kHeroY + kHeroH + kPad;
  const int areaH = kH - y0 - kFooterH;
  g->fillRect(0, y0, kW, areaH, kBg);

  const int cx = kPad;
  const int cy = y0 + 4;
  const int cw = kW - 2 * kPad;
  const int ch = areaH - 8;
  g->fillRoundRect(cx, cy, cw, ch, 12, kCard);
  g->drawRoundRect(cx, cy, cw, ch, 12, g_nrfOk ? kGreen : kRed);

  const int lx = cx + 12;
  const int vx = cx + 78;
  int rowY = cy + 24;
  const int rowGap = 22;

  auto row = [&](const char *label, const char *value, uint16_t valCol) {
    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kMuted, kCard);
    btext::drawAt(lx, rowY, label);
    btext::setColor(valCol, kCard);
    btext::drawTruncated(vx, rowY, cw - vx - 10, value);
    rowY += rowGap;
  };

  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kCard);
  btext::drawAt(lx, cy + 14, "NRF24");

  row("Status", g_nrfOk ? "CONNECTED" : "NO LINK", g_nrfOk ? kGreen : kRed);

  char chLine[20];
  snprintf(chLine, sizeof(chLine), "%u  (%u MHz)", static_cast<unsigned>(g_nrfChannel),
           static_cast<unsigned>(2400 + g_nrfChannel));
  row("Channel", chLine, kText);

  char rateLine[16];
  snprintf(rateLine, sizeof(rateLine), "%s", g_nrfBitrate);
  row("Rate", rateLine, kText);

  row("Radio ID", "0", kMuted);

  char pins[28];
  snprintf(pins, sizeof(pins), "CE%d CSN%d", NRF_CE_PIN, NRF_CSN_PIN);
  row("Pins A", pins, kMuted);
  snprintf(pins, sizeof(pins), "SCK%d M%d I%d", NRF_SCK_PIN, NRF_MOSI_PIN, NRF_MISO_PIN);
  row("Pins B", pins, kMuted);
}

void drawSleep() {
  g->fillScreen(kBg);
  glyphs::drawMoon(kW / 2 - 18, kH / 2 - 28, 36, kDim);
  btext::setFont(&FreeSans9pt7b);
  btext::setColor(kDim, kBg);
  if (g_battery >= 0) {
    char bat[8];
    snprintf(bat, sizeof(bat), "%d%%", g_battery);
    btext::drawCentered(0, kW, kH / 2 + 30, bat);
  }
}

}  // namespace

// =======================================================================
// public API
// =======================================================================
namespace {
// Logo block geometry — used by all splash phases.
struct SplashLayout {
  int cy;       // vertical center for BM mark
  int ulY;      // underline y
  int ulW;      // underline width (animated 0..max)
  int wordY;    // BRIDGE baseline
  int verY;     // version baseline
  int checkY0;  // first boot-check line baseline
};
SplashLayout splashLayout() {
  SplashLayout s;
  s.cy = kH / 2 - 36;
  s.ulY = s.cy + 14;
  s.ulW = 70;
  s.wordY = s.cy + 46;
  s.verY = s.cy + 68;
  s.checkY0 = s.cy + 100;
  return s;
}

void drawSplashLogo(int underlineW) {
  const SplashLayout s = splashLayout();
  btext::setFont(&FreeSansBold24pt7b);
  btext::setColor(kCyan, kBg);
  btext::drawCentered(0, kW, s.cy, "BM");
  // animated underline grows from center
  if (underlineW > 0) {
    g->fillRect((kW - underlineW) / 2, s.ulY, underlineW, 2, kCyan);
  }
}

void drawCheckLine(int baselineY, const char *label, bool done) {
  // [✓] label   — or [ ] label (pending)
  const int boxX = kPad + 14;
  const int boxY = baselineY - 10;
  const int boxS = 12;
  g->drawRoundRect(boxX, boxY, boxS, boxS, 2, done ? kGreen : kBorder);
  if (done) {
    // small tick using diagonals
    g->drawLine(boxX + 2, boxY + 6, boxX + 5, boxY + 9, kGreen);
    g->drawLine(boxX + 5, boxY + 9, boxX + 10, boxY + 3, kGreen);
    g->drawLine(boxX + 2, boxY + 7, boxX + 5, boxY + 10, kGreen);
    g->drawLine(boxX + 5, boxY + 10, boxX + 10, boxY + 4, kGreen);
  }
  btext::setFont(&FreeSans9pt7b);
  btext::setColor(done ? kText : kMuted, kBg);
  btext::drawAt(boxX + boxS + 10, baselineY, label);
}

void drawCheckLineFail(int baselineY, const char *label) {
  const int boxX = kPad + 14;
  const int boxY = baselineY - 10;
  const int boxS = 12;
  g->drawRoundRect(boxX, boxY, boxS, boxS, 2, kRed);
  g->drawLine(boxX + 2, boxY + 2, boxX + boxS - 3, boxY + boxS - 3, kRed);
  g->drawLine(boxX + boxS - 3, boxY + 2, boxX + 2, boxY + boxS - 3, kRed);
  btext::setFont(&FreeSans9pt7b);
  btext::setColor(kRed, kBg);
  btext::drawAt(boxX + boxS + 10, baselineY, label);
}

void splashWaitMs(uint32_t ms) {
  const uint32_t end = millis() + ms;
  while ((int32_t)(end - millis()) > 0) {
    ledTick(millis());
    delay(10);
  }
}
}  // namespace

void bridgeUiDrawSplash(const char *version) {
  if (!g) return;
  g->fillScreen(kBg);

  const SplashLayout s = splashLayout();
  drawSplashLogo(s.ulW);

  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kBg);
  btext::drawCentered(0, kW, s.wordY, "BRIDGE");

  if (version) {
    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kMuted, kBg);
    btext::drawCentered(0, kW, s.verY, version);
  }
}

void bridgeUiPlaySplashSequence(const char *version, bool nrfOk) {
  if (!g) return;
  const SplashLayout s = splashLayout();

  // Phase 1 — fade-in underline (0..70 px in 8 steps, 400ms)
  g->fillScreen(kBg);
  for (int w = 0; w <= s.ulW; w += 9) {
    drawSplashLogo(w);
    splashWaitMs(50);
  }
  // wordmark + version
  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kBg);
  btext::drawCentered(0, kW, s.wordY, "BRIDGE");
  if (version) {
    btext::setFont(&FreeSans9pt7b);
    btext::setColor(kMuted, kBg);
    btext::drawCentered(0, kW, s.verY, version);
  }
  splashWaitMs(150);

  // Phase 2 — boot checklist, tick one item ~every 250 ms
  const char *steps[] = {"LCD", "Buttons", "Power", "BLE", "NRF24"};
  const int  stepsN = 5;
  const int  lineGap = 18;

  // Draw all pending first
  for (int i = 0; i < stepsN; i++) {
    drawCheckLine(s.checkY0 + i * lineGap, steps[i], false);
  }
  splashWaitMs(150);

  // Tick them in order — each green check also brightens the LED.
  ledBootStep(0, stepsN);  // start dim
  for (int i = 0; i < stepsN; i++) {
    splashWaitMs(180);
    const int y = s.checkY0 + i * lineGap;
    g->fillRect(0, y - 12, kW, 16, kBg);
    const bool isNrf = (i == stepsN - 1);
    if (isNrf && !nrfOk) {
      drawCheckLineFail(y, steps[i]);
    } else {
      drawCheckLine(y, steps[i], true);
    }
    ledBootStep(i + 1, stepsN);
  }

  splashWaitMs(250);
}

void bridgeUiShowNrfDebugScreen(bool ok, uint32_t holdMs) {
  if (!g) return;

  g->fillScreen(kBg);
  btext::setFont(&FreeSansBold12pt7b);
  btext::setColor(kText, kBg);
  btext::drawCentered(0, kW, 52, "NRF24 DEBUG");

  btext::setFont(&FreeSansBold18pt7b);
  btext::setColor(ok ? kGreen : kRed, kBg);
  btext::drawCentered(0, kW, 108, ok ? "CONNECTED" : "NO LINK");

  btext::setFont(&FreeSans9pt7b);
  btext::setColor(kMuted, kBg);
  btext::drawCentered(0, kW, 148, ok ? "SPI init ok" : "init failed — check wiring");

  char line1[28];
  char line2[28];
  char line3[28];
  snprintf(line1, sizeof(line1), "CE=%d  CSN=%d", NRF_CE_PIN, NRF_CSN_PIN);
  snprintf(line2, sizeof(line2), "SCK=%d MOSI=%d", NRF_SCK_PIN, NRF_MOSI_PIN);
  snprintf(line3, sizeof(line3), "MISO=%d  3V3", NRF_MISO_PIN);

  btext::setColor(kText, kBg);
  btext::drawCentered(0, kW, 188, line1);
  btext::drawCentered(0, kW, 210, line2);
  btext::drawCentered(0, kW, 232, line3);

  if (!ok) {
    btext::setColor(kAmber, kBg);
    btext::drawCentered(0, kW, 268, "not GP12/13 (USB)");
  }

  splashWaitMs(holdMs);
}

void bridgeUiInit(Arduino_GFX *display) {
  g = display;
  btext::init(display);
  glyphs::init(display);
  display->setTextColor(kText, kBg);
  for (int i = 0; i < UI_LIST_MAX; i++) g_rssi[i] = 0;
}

void bridgeUiSetLink(LinkState s, const char *detail) {
  g_link = s;
  if (detail) {
    strncpy(g_detail, detail, sizeof(g_detail) - 1);
    g_detail[sizeof(g_detail) - 1] = '\0';
  }
}

void bridgeUiSetList(const char *const *names, int count, int sel, int scroll) {
  g_nameCount = min(count, UI_LIST_MAX);
  g_selected = sel;
  g_scroll   = scroll;
  for (int i = 0; i < g_nameCount; i++) {
    strncpy(g_names[i], names[i], sizeof(g_names[i]) - 1);
    g_names[i][sizeof(g_names[i]) - 1] = '\0';
  }
}

void bridgeUiSetRssi(int idx, int8_t dbm) {
  if (idx < 0 || idx >= UI_LIST_MAX) return;
  g_rssi[idx] = dbm;
}

void bridgeUiSetFooter(const char *line) {
  strncpy(g_footer, line, sizeof(g_footer) - 1);
  g_footer[sizeof(g_footer) - 1] = '\0';
}

void bridgeUiSetBattery(int8_t p)         { g_battery = p; }
void bridgeUiSetTally(TallyState s)       { g_tally = s; }
void bridgeUiSetActiveCamera(const char *n) {
  if (!n) { g_active[0] = '\0'; return; }
  strncpy(g_active, n, sizeof(g_active) - 1);
  g_active[sizeof(g_active) - 1] = '\0';
}
void bridgeUiSetSleep(bool s) { g_sleep = s; }

void bridgeUiSetNrfInfo(bool connected, uint8_t channel, const char *bitrateLabel) {
  g_nrfOk = connected;
  g_nrfChannel = channel;
  if (bitrateLabel) {
    strncpy(g_nrfBitrate, bitrateLabel, sizeof(g_nrfBitrate) - 1);
    g_nrfBitrate[sizeof(g_nrfBitrate) - 1] = '\0';
  }
}

void bridgeUiSetNrfScreen(bool show) { g_nrfScreen = show; }
bool bridgeUiIsNrfScreen() { return g_nrfScreen; }

constexpr uint32_t kAnimPhaseMs = 60;  // fixed visual speed — independent of CPU/SPI tier

void bridgeUiTick(uint32_t nowMs) {
  // Phase advances on wall clock only. High-perf tier still speeds SPI/CPU for
  // full redraws, but scan radar / shimmer / spinner stay at ~16 fps logic.
  if (nowMs - g_tickMs < kAnimPhaseMs) return;
  g_tickMs = nowMs;
  g_animFrame = (g_animFrame + 1) & 0x1F;
  if (g_sleep) return;
  if (g_link == LinkState::Scanning && g_nameCount == 0) g_animDirty = true;
  else if (g_link == LinkState::Connecting)              g_animDirty = true;
}

bool bridgeUiAnimationsDirty() {
  if (g_animDirty) { g_animDirty = false; g_animOnly = true; return true; }
  return false;
}

void bridgeUiDraw() {
  if (!g) return;

  // Any state-shape change invalidates the partial-redraw fast path —
  // we must do a full repaint so the previous screen doesn't leak through.
  const bool shapeChanged =
      g_link != g_lastDrawnLink ||
      g_tally != g_lastDrawnTally ||
      g_sleep != g_lastDrawnSleep ||
      g_nrfScreen != g_lastDrawnNrfScreen ||
      (g_nameCount == 0) != (g_lastDrawnNameCount == 0);
  if (shapeChanged) g_animOnly = false;

  if (g_sleep) {
    drawSleep();
    g_animOnly = false;
    g_lastDrawnLink = g_link;
    g_lastDrawnTally = g_tally;
    g_lastDrawnSleep = g_sleep;
    g_lastDrawnNrfScreen = g_nrfScreen;
    g_lastDrawnNameCount = g_nameCount;
    return;
  }

  if (g_nrfScreen) {
    g->fillScreen(kBg);
    drawStatusBar();
    drawHero();
    drawNrfSettings();
    drawFooter();
    g_animOnly = false;
    g_lastDrawnLink = g_link;
    g_lastDrawnTally = g_tally;
    g_lastDrawnSleep = g_sleep;
    g_lastDrawnNrfScreen = g_nrfScreen;
    g_lastDrawnNameCount = g_nameCount;
    return;
  }

  if (g_animOnly) {
    g_animOnly = false;
    switch (g_link) {
      case LinkState::Scanning:
        // Only repaint the moving shimmer band + the radar icon.
        // Everything else is static — never touched between frames.
        if (g_nameCount == 0) drawSkeletonShimmer();
        {
          const int px = kPad;
          const int py = kHeroY + 4;
          const int ph = kHeroH - 8;
          const int iconS = 22;
          const int iconX = px + 14;
          const int iconY = py + (ph - iconS) / 2;
          g->fillRect(iconX, iconY, iconS, iconS, kCard);
          glyphs::drawRadar(iconX, iconY, iconS, accent(), g_animFrame & 0x07);
        }
        return;
      case LinkState::Connecting:
        partialRedrawLinkingSpinner();
        return;
      case LinkState::Connected:
        return;
      default: return;
    }
  }

  // Full-screen tally takeover: LIVE/PVW dominates the panel, no chrome.
  if (g_link == LinkState::Connected && g_tally != TallyState::Off) {
    drawTallyFullScreen();
  } else {
    g->fillScreen(kBg);
    drawStatusBar();
    drawHero();
    switch (g_link) {
      case LinkState::Connecting: drawLinking();  break;
      case LinkState::Connected:  drawLinked();   break;
      case LinkState::Error:      drawError();    break;
      default:                    drawListArea(); break;
    }
    drawFooter();
  }

  g_lastDrawnLink = g_link;
  g_lastDrawnTally = g_tally;
  g_lastDrawnSleep = g_sleep;
  g_lastDrawnNrfScreen = g_nrfScreen;
  g_lastDrawnNameCount = g_nameCount;
}
