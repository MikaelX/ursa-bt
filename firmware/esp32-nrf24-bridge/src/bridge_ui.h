#pragma once

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

enum class LinkState { Disconnected, Scanning, Ready, Connecting, Connected, Error };

// Tally pushed from ATEM (or any future source). Off = no overlay block drawn.
enum class TallyState { Off, Preview, Program };

void bridgeUiInit(Arduino_GFX *display);
void bridgeUiDrawSplash(const char *version);  // initial frame
void bridgeUiPlaySplashSequence(const char *version, bool nrfOk);  // intro anim + boot checks
void bridgeUiShowNrfDebugScreen(bool ok, uint32_t holdMs = 2500);  // temp wiring/status card
void bridgeUiSetLink(LinkState state, const char *detail = nullptr);
void bridgeUiSetList(const char *const *names, int count, int selectedIndex, int scrollOffset);
void bridgeUiSetRssi(int index, int8_t dbm);
void bridgeUiSetFooter(const char *line);
void bridgeUiSetBattery(int8_t percent);   // -1 = unknown / hide
void bridgeUiSetTally(TallyState state);
void bridgeUiSetActiveCamera(const char *name);  // for Linked/Linking/Error screens
void bridgeUiSetSleep(bool sleeping);
void bridgeUiSetNrfInfo(bool connected, uint8_t channel, const char *bitrateLabel);
void bridgeUiSetNrfScreen(bool show);  // full-page NRF settings (demo / detail)
bool bridgeUiIsNrfScreen();
void bridgeUiTick(uint32_t nowMs);         // advances animations; mark dirty externally if needed
bool bridgeUiAnimationsDirty();            // true when a redraw is due to animation
void bridgeUiDraw();
