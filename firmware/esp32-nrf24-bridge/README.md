# ESP32 NRF24 Camera Bridge

PlatformIO firmware for the BM hardware bridge (BLE camera panel + future NRF24 relay).

**Full dev context:** [CONTEXT.md](./CONTEXT.md) — PlatformIO setup, **cable color → pin** tables, power policy, pitfalls.

## Setup

```bash
# Install PlatformIO (use pip, not Homebrew — brew build is broken on macOS)
pip install --user 'platformio>=6.1.0'
export PATH="$HOME/.local/bin:$PATH"
```

## Build & flash

```bash
cd firmware/esp32-nrf24-bridge
platformio run -e waveshare_c6_lcd_147   # Waveshare ESP32-C6-LCD-1.47 (no touch)
platformio run -e esp32dev           # plain ESP32
platformio run -e heltec_lora_32_v3  # Heltec S3

platformio run -e esp32c6_lcd_147 -t upload
cd firmware/esp32-nrf24-bridge
platformio device monitor -e esp32c6_lcd_147   # must be 115200 baud
```

C6 uses **pioarduino** platform (official `espressif32` has no Arduino on C6 yet).

## Waveshare ESP32-C6-LCD-1.47 (your board)

**Display only — no touch.** Portrait UI + 3-button BLE camera picker. See `docs/bridge-panel-ui.md`.

| Function | GPIO |
|----------|------|
| LCD MOSI | 6    |
| LCD SCK  | 7    |
| LCD CS   | 14   |
| LCD DC   | 15   |
| LCD RST  | 21   |
| LCD BL   | 22   |
| BTN UP   | 1    |
| BTN DOWN | 3    |
| BTN SEL  | 4    |

**Header pinout:** `docs/waveshare-c6-lcd-147-pinout.jpg` — full table in [CONTEXT.md](./CONTEXT.md#header-pinout-breakout-holes).

**NRF24** (later; separate from buttons):

| Wire   | NRF24 | GPIO | Header |
|--------|-------|------|--------|
| white  | GND   | GND  | Left #2 |
| red    | VCC   | 3V3  | Left #3 |
| purple | SCK   | 23   | Right #5 |
| yellow | MOSI  | 18   | Right #8 |
| blue   | MISO  | 0    | Left #4 |
| orange | CSN   | 20   | Right #6 |
| grey   | CE    | 19   | Right #7 |

**Do not use GP12/GP13** — ESP32-C6 native USB (flash/serial dies if NRF wired there).

## NRF24 wiring (Heltec LoRa 32 V3)

| Wire   | NRF24 | GPIO |
|--------|-------|------|
| white  | GND   | GND  |
| red    | VCC   | 3.3V (+ 10µF cap) |
| purple | SCK   | 14   |
| yellow | MOSI  | 13   |
| blue   | MISO  | 12   |
| orange | CSN   | 27   |
| grey   | CE    | 26   |
| green  | IRQ   | 25   |

## Targets

- `heltec_lora_32_v3` — Heltec WiFi LoRa 32 V3 (default)
