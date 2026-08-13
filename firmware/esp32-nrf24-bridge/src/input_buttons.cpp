#include "input_buttons.h"

#include "bridge_config.h"

namespace {
constexpr uint32_t kDebounceMs = 35;
constexpr uint32_t kLongPressMs = 800;
constexpr uint8_t kPinNone = 255;

struct BtnState {
  uint8_t pin;
  uint32_t pressStartMs;
  bool longFired;
};

uint8_t pinOrNone(int pin) { return pin < 0 ? kPinNone : static_cast<uint8_t>(pin); }

BtnState g_btns[3] = {
    {pinOrNone(BTN_PIN_UP), 0, false},
    {pinOrNone(BTN_PIN_DOWN), 0, false},
    {pinOrNone(BTN_PIN_SELECT), 0, false},
};

bool pinValid(uint8_t pin) { return pin != kPinNone; }

bool isPressed(uint8_t pin) {
  const int level = digitalRead(pin);
#if BTN_ACTIVE_LOW
  return level == LOW;
#else
  return level == HIGH;
#endif
}

BtnEvent pollOne(BtnState &b, BtnEvent shortEvent, BtnEvent longEvent) {
  if (!pinValid(b.pin)) return BtnEvent::None;

  const bool pressed = isPressed(b.pin);
  const uint32_t now = millis();

  if (pressed) {
    if (b.pressStartMs == 0) {
      b.pressStartMs = now;
      b.longFired = false;
    } else if (!b.longFired && longEvent != BtnEvent::None && (now - b.pressStartMs) >= kLongPressMs) {
      b.longFired = true;
      return longEvent;
    }
    return BtnEvent::None;
  }

  if (b.pressStartMs == 0) return BtnEvent::None;

  const uint32_t held = now - b.pressStartMs;
  b.pressStartMs = 0;

  if (b.longFired) {
    b.longFired = false;
    return BtnEvent::None;
  }

  if (held >= kDebounceMs && held < kLongPressMs) {
    return shortEvent;
  }
  return BtnEvent::None;
}
}  // namespace

void buttonsInit() {
  if (pinValid(g_btns[0].pin)) pinMode(g_btns[0].pin, INPUT_PULLUP);
  if (pinValid(g_btns[1].pin)) pinMode(g_btns[1].pin, INPUT_PULLUP);
  if (pinValid(g_btns[2].pin)) pinMode(g_btns[2].pin, INPUT_PULLUP);
}

bool buttonsHasUpDown() {
  return pinValid(g_btns[0].pin) && pinValid(g_btns[1].pin);
}

BtnEvent buttonsPoll() {
  BtnEvent e = BtnEvent::None;
  e = pollOne(g_btns[0], BtnEvent::Up, BtnEvent::None);
  if (e != BtnEvent::None) return e;
  e = pollOne(g_btns[1], BtnEvent::Down, BtnEvent::None);
  if (e != BtnEvent::None) return e;
  e = pollOne(g_btns[2], BtnEvent::Select, BtnEvent::LongSelect);
  return e;
}
