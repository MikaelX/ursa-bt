# ESP32 NRF24 Bridge — development context

Living reference for PlatformIO, wiring, and firmware conventions. **Pin numbers:** `include/bridge_config.h` (code) + tables below (bench).

Parent repo: `bm-bluetooth` — Blackmagic camera control over BLE (web + relay). This firmware is a **hardware bridge**: BLE to camera on-device, NRF24 for future wireless relay to a second unit.

---

## PlatformIO

### Install (macOS)

```bash
pip install --user 'platformio>=6.1.0'
export PATH="$HOME/.local/bin:$PATH"
```

**Do not use Homebrew PlatformIO** — broken on recent macOS (Python 3.14 / pip).

### Commands (always from this directory)

```bash
cd firmware/esp32-nrf24-bridge

platformio run -e waveshare_c6_lcd_147 -t upload --upload-port /dev/cu.usbmodem1401
platformio device monitor -e waveshare_c6_lcd_147    # serial 115200
```

### Agent / dev workflow — **always flash**

After **any** firmware change (UI, BLE, pins, power, `platformio.ini`), **build and upload** to the Waveshare board — do not stop at compile-only unless the user says no hardware is connected.

```bash
export PATH="$HOME/.local/bin:$PATH"
cd firmware/esp32-nrf24-bridge
platformio run -e waveshare_c6_lcd_147 -t upload --upload-port /dev/cu.usbmodem1401
```

- Default port: `/dev/cu.usbmodem1401` (adjust if `platformio device list` shows another `cu.usbmodem*`)
- If upload fails with **port busy**, close serial monitor / other tools using the port, then retry
- Optional: `platformio device monitor -e waveshare_c6_lcd_147` after flash for logs (115200, from this directory)

Alias env: `esp32c6_lcd_147` → same as `waveshare_c6_lcd_147`.

### Environments

| Env | Board | Role |
|-----|-------|------|
| `waveshare_c6_lcd_147` | Waveshare ESP32-C6-LCD-1.47 | **Primary** — ST7789 panel + buttons + NimBLE |
| `esp32dev` | Generic ESP32 | Legacy / NRF24 experiments (U8g2, ArduinoBLE) |
| `heltec_lora_32_v3` | Heltec WiFi LoRa 32 V3 | OLED + different NRF24 pinout |

### C6 platform note

Official `espressif32` PlatformIO platform **does not ship Arduino for ESP32-C6** yet. Use **pioarduino**:

```ini
platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip
```

### Flash size (4 MB Waveshare)

Default Arduino partition (~1.25 MB app) is **too small** for NimBLE + GFX (~1.4 MB). This project uses:

`partitions/waveshare_4mb.csv` — single ~4 MB factory app, no OTA slot.

Re-add `NRFLite` to `lib_deps` when NRF24 code lands; watch binary size.

### Upload / monitor

- Upload: **921600** (`platformio.ini`)
- Monitor: **115200** — run monitor from **this folder** or baud is wrong (garbled serial)
- Port busy: stop open `device monitor` / close serial tools before upload

---

## Primary hardware — Waveshare ESP32-C6-LCD-1.47

- **Display only** (no touch), **4 MB flash**, ST7789 **172×320** portrait
- **Not** the Touch-LCD variant — touch demo pins / I2C touch chip do not apply
- CPU run: **80 MHz** (`board_build.f_cpu` + `setCpuFrequencyMhz(80)`)

### LCD (fixed on PCB)

| Signal | GPIO |
|--------|------|
| MOSI | 6 |
| SCK | 7 |
| CS | 14 |
| DC | 15 |
| RST | 21 |
| BL | 22 (PWM via `power_manager`) |

Init: `src/waveshare_lcd_init.cpp` — `Arduino_HWSPI(15, 14, 7, 6)`.

### Header pinout (breakout holes)

Official diagram: `docs/waveshare-c6-lcd-147-pinout.jpg` (Waveshare W28563-005).

![ESP32-C6-LCD-1.47 header pinout](docs/waveshare-c6-lcd-147-pinout.jpg)

USB-C at top; **BOOT** top-left, **RST** top-right. Only the GPIO below are on the 2×9 headers — LCD (6, 7, 14, 15, 21, 22), onboard LED (8), and **GP10/GP11 are not broken out**.

| Side | # | Label | GPIO | Notes |
|------|---|-------|------|-------|
| Left | 1 | 5V | — | |
| Left | 2 | GND | — | NRF white |
| Left | 3 | 3V3(OUT) | — | NRF red |
| Left | 4 | GP0 | 0 | NRF blue (MISO) |
| Left | 5 | GP1 | 1 | BTN UP |
| Left | 6 | GP2 | 2 | |
| Left | 7 | GP3 | 3 | BTN DOWN |
| Left | 8 | GP4 | 4 | BTN SEL (when wired) |
| Left | 9 | GP5 | 5 | |
| Right | 1 | TX | UART0 TX | |
| Right | 2 | RX | UART0 RX | serial monitor |
| Right | 3 | GP13 | 13 | **USB D+ — do not wire NRF** |
| Right | 4 | GP12 | 12 | **USB D- — do not wire NRF** |
| Right | 5 | GP23 | 23 | NRF purple (SCK) |
| Right | 6 | GP20 | 20 | NRF orange (CSN) |
| Right | 7 | GP19 | 19 | NRF grey (CE) |
| Right | 8 | GP18 | 18 | NRF yellow (MOSI) |
| Right | 9 | GP9 | 9 | onboard BOOT (SEL fallback) |

**NRF24:** power left, SPI right + GP0/GP18. **Never use GP12/GP13** — native USB Serial/JTAG.

### Buttons (active LOW, `INPUT_PULLUP`)

**Interim (`BTN_USE_BOOT_FALLBACK 1`):** onboard **BOOT = GPIO 9** on ESP32-C6 (not GPIO 0). Active LOW, internal pull-up. Short = SEL, long = rescan. UP/DOWN disabled until wired on 1/3/4.

| Button | GPIO | Short press | Long press (≥800 ms) |
|--------|------|-------------|----------------------|
| UP | 1 | Previous list row | — |
| DOWN | 3 | Next list row | — |
| SELECT | 4 (or **0** = BOOT) | Scan / stop scan / connect | Rescan |

**Note:** Holding BOOT at power-on enters USB bootloader — normal after boot.

### UI / UX (current firmware)

- Boot: animated splash sequence (BM mark + underline reveal + boot checklist) → **READY** (no IDLE state — direct to ready with empty card).
- `SEL` → BLE scan ~3 s; `SEL` again → stop; list + `UP`/`DOWN`; `SEL` on row → connect (**GATT TODO**)
- **172×320 modern dark UI** with **custom Adafruit GFX fonts** (`src/fonts/FreeSans*.h`, included verbatim with `<Adafruit_GFX.h>` swapped to `<gfxfont.h>`). Text helper in `src/bridge_text.{h,cpp}` (measure / center / truncate). Procedural vector icons in `src/bridge_glyphs.{h,cpp}` (camera lens, radar, link rings, warn, moon, signal bars, battery, BM mark).
- Screens: splash, READY (home: action card + "no camera linked" badge), SCAN (skeleton + radar), LIST (rows with RSSI bars), LINKING (spinner), LINKED (compact tally block or full-screen LIVE/PVW takeover), ERROR (card with recovery hint), SLEEP (zZz + battery).
- Palette (RGB565, in `bridge_ui.cpp`): **bg MUST be `0x0000` true black** (any near-black value renders white on this panel — see ST7789 IPS note below). Card `0x10A2`, card-hover `0x18E3`, border `0x2945`, accents cyan `0x3D9F` / amber `0xFD20` / indigo `0x632C` / green `0x2604` / red `0xDA29`.
- **ST7789 init must use `IPS=true`** in `Arduino_ST7789(...)` constructor. With `IPS=false` the panel renders nearly monochrome (confirmed on hardware). Do **not** call `gfx->invertDisplay(true)` — it flips it back. See defensive comment in `src/waveshare_lcd_init.cpp`.
- Top **compact status bar** (16 px): battery icon only, color-graded green/amber/red.
- **Tally block** (Connected screen): big colored rectangle, `TallyState::Program`=LIVE red w/ pulsing REC dot, `Preview`=PVW green, `Off`=muted IDLE. Pushed via `bridgeUiSetTally()` from ATEM source (TODO wiring).
- **Animations:** `bridgeUiTick(millis())` advances 8 fps frame; `bridgeUiAnimationsDirty()` returns true when scan-skeleton / linking-spinner / REC-pulse needs a redraw. Main loop checks it and calls `markDirty()`.
- **Typography:** minimum `setTextSize(2)` (~12×16 px) for user-facing text — never size 1. Hero uses size 3, tally label size 5.
- `setTextColor(fg)` alone sets bg=fg → white boxes; always use `setTextColor(fg, kBg)`.
- **Icons:** `include/bridge_icons.h` — 16×16 bitmaps + procedural scan arcs / link rings.
- **Public API** (`bridge_ui.h`): `bridgeUiSetLink`, `SetList`, `SetRssi`, `SetFooter`, `SetBattery`, `SetTally`, `SetActiveCamera`, `SetSleep`, `Tick`, `AnimationsDirty`, `Draw`.

---

## NRF24 — cable colors & GPIO

**Bench mnemonic:** *“White ground, red power, purple clock, yellow out, blue in, orange chip-select, grey chip-enable, green interrupt.”*

### Power & mechanical

| Wire color | NRF24 pin | Connect to |
|------------|-----------|------------|
| **white** | GND | GND |
| **red** | VCC | **3.3 V** (not 5 V) |
| — | — | **10 µF** cap across VCC/GND at module |

### Data (Waveshare C6 — `bridge_config.h`)

| Wire color | NRF24 pin | GPIO | Header hole | Notes |
|------------|-----------|------|-------------|--------|
| **purple** | SCK | 23 | Right #5 | |
| **yellow** | MOSI | 18 | Right #8 | **not GP12 (USB D-)** |
| **blue** | MISO | 0 | Left #4 | **not GP13 (USB D+)** |
| **orange** | CSN | 20 | Right #6 | |
| **grey** | CE | 19 | Right #7 | |
| **green** | IRQ | *(optional)* | — | Unconnected OK for bring-up |

**No overlap** with buttons (1, 3, 4) or LCD (6, 7, 14, 15, 21, 22). **Never GP12/GP13** — ESP32-C6 USB data; wiring/SPI there kills USB flash + serial.

**SPI bus:** LCD and NRF share the Arduino `SPI` object. Init LCD first; `nrf24Init()` remaps SPI to NRF pins, then `waveshareLcdSetPerformance(true)` restores the panel bus.

NRF24 init in `src/bridge_nrf24.cpp` (NRFLite); boot logs `[nrf] init ok` or `FAILED` on serial.

### Heltec LoRa 32 V3 (alternate harness)

Same **color → NRF24 function**; different GPIO:

| Wire | NRF24 | GPIO |
|------|-------|------|
| white | GND | GND |
| red | VCC | 3.3V + cap |
| purple | SCK | 14 |
| yellow | MOSI | 13 |
| blue | MISO | 12 |
| orange | CSN | 27 |
| grey | CE | 26 |
| green | IRQ | 25 |

---

## Onboard RGB LED (WS2812)

- **GPIO 8** drives the onboard WS2812B (per Waveshare wiki).
- Driver: arduino-esp32 `rgbLedWrite(pin, r, g, b)` (RMT-based, no `pinMode` needed).
- **Color order quirk:** This board's LED is wired such that the default GRB ordering of `rgbLedWrite` produces swapped colors — passing R=255 lights green and vice versa. `src/bridge_led.cpp` works around it with `rgbLedWrite(pin, c.g, c.r, c.b)`. **Do not "fix" this back — it's empirically required.**
- **Breathe math gotcha:** When modulating a channel with base < depth/2, naive `base + delta - depth/2` underflows on `uint16_t` → wraps to ~65535 → clamps to 255 → spurious color leak (e.g. orange scanning would flash cyan/blue at the trough). The current `breathe()` cleanly scales each channel 0..base, so any channel set to 0 stays 0.
- **State → color** mirrors the UI accent palette: Ready=cyan, Scanning=orange (faster breathe — ~1 Hz), Connecting=indigo (breathe), Connected=green-cyan, Error=red (breathe), Program=solid red, Preview=solid green, Sleep=off.
- API in `src/bridge_led.h`: `ledInit`, `ledSetLink`, `ledSetTally`, `ledOff`, `ledResume` (after wake), `ledTick` (call from loop for breathe).
- `ledSetLink`/`ledSetTally` write immediately so the LED reflects state during blocking `delay()` (used by the boot demo).
- After `powerEnterDisplaySleep()` → `ledOff()`. After wake (button or tally) → `ledResume()` to re-assert color.

---

## UI redraw pipeline

The hot path is built around a state-change invalidator + partial redraws:

- `bridgeUiDraw()` tracks `g_lastDrawn{Link,Tally,Sleep,NameCount}`; if any "shape" differs from current state, the partial-redraw fast path is suppressed and a full `fillScreen` + repaint runs. **This is what prevents artifacts when transitioning between screens.**
- Animation tick = **60 ms (~16 fps)**. Frame counter is 5-bit (0..31) for smooth spinner rotation / shimmer sweep.
- Partial-redraw entries:
  - **Scanning**: `drawSkeletonStatic()` paints row cards once, then `drawSkeletonShimmer()` erases the previous shimmer block position (using a small `fillRoundRect`) and paints the new — no row repaint between frames. Plus the radar icon in the hero.
  - **Connecting**: `partialRedrawLinkingSpinner()` repaints only the spinner ring area.
  - **Connected**: tally is static (no animation), zero per-tick work.
  - **Tally Program/Preview**: full-screen takeover (`drawTallyFullScreen`), no chrome.
- Footer behaves as a rounded card (`kCard` fill, `kBorder` outline) sitting at the bottom. Hint left, counter right on list screens; centered on others. Muted color on LINKED, accent everywhere else. Slim height (32 px) with `FreeSansBold9pt7b`.

---

## Power & thermal

Board runs hot if CPU, backlight, WiFi, and BLE scan run continuously. Current policy (`src/power_manager.cpp`, `main.cpp`):

| Mechanism | Behavior |
|-----------|----------|
| WiFi | Off at boot (`esp_wifi_stop` / `deinit`) |
| CPU | **160 MHz** when panel active (bright); **80 MHz** when dimmed/asleep |
| LCD SPI | **80 MHz** active; **40 MHz** save |
| UI anim | **~16 fps** phase (fixed); SPI/CPU tier affects redraw speed only |
| Backlight | ~28% normal; dim (~9%) after **15 s** idle |
| BLE | Lazy init; lowest TX; **no** scan at boot |
| Post-scan | Radio shutdown **15 s** after scan ends — **not** while camera GATT session active |
| Display sleep | `zZz` overlay + backlight **0** after **60 s** idle; BLE stays up if linked; any button wakes (event is swallowed) |
| Keep-awake | `powerSetKeepAwake(true)` while ATEM tally is LIVE/PVW — forces full brightness, blocks dim/sleep. Call `onTallyChanged()` to update. |
| UI | Redraw only when dirty (`g_uiDirty`); animation ticks do **partial** redraw (no full `fillScreen`) to prevent flicker |

If still hot: check whether heat is at idle vs during scan; measure with BLE off.

---

## Software layout

```
include/bridge_config.h       # pins, UUIDs, UI limits
include/bridge_icons.h        # legacy 16x16 bitmap icons (unused; kept)
src/main.cpp                  # loop: buttons, scan timing, sleep, demo cycle
src/power_manager.cpp         # backlight PWM, idle/dim/sleep, keep-awake override
src/waveshare_lcd_init.cpp    # ST7789 bus (IPS=true)
src/bridge_ui.{h,cpp}         # GFX drawing + state machine
src/bridge_text.{h,cpp}       # custom-font text helper (measure/center/truncate)
src/bridge_glyphs.{h,cpp}     # procedural vector icons
src/bridge_led.{h,cpp}        # onboard WS2812 driver (GPIO 8, R/G swapped)
src/fonts/FreeSans*.h         # Adafruit GFX fonts (9/12pt + Bold 9/12/18/24pt)
src/ble_camera_scanner.cpp    # NimBLE scan + BM filter
src/input_buttons.cpp         # debounce + long press
partitions/waveshare_4mb.csv
platformio.ini
```

**BLE stack (C6):** `h2zero/NimBLE-Arduino` — not ArduinoBLE.

**Display:** `moononournation/GFX Library for Arduino`.

---

## Blackmagic BLE (shared with web app)

- Protocol: `docs/BlackmagicCameraControl.pdf`
- Camera service UUID: `291D567A-6D75-11E6-8B77-86F30CA893D3` (lowercase in firmware)
- Outgoing control: `5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB`
- Incoming control: `B864E140-76A0-416A-BF30-5876504537D9`
- Status: `7FE8691D-95DC-4FC5-8ABD-CA74339B51B9`
- Encrypted characteristics → **pairing** (6-digit PIN on camera)

Scanner: set `BLE_SCAN_ALL_DEVICES` to `1` in `bridge_config.h` for bench (any advertiser); `0` for BM service / name filter only.

---

## Pitfalls (learned)

| Symptom | Likely cause |
|---------|----------------|
| Serial garbage | Monitor not 115200 or wrong cwd |
| Upload fails “port busy” | Monitor still open |
| Build > 100% flash | Default partition; need `waveshare_4mb.csv` |
| I2C errors on C6 | Flashed **touch** demo on **non-touch** board |
| Wrong display | Spotpear vs Waveshare pinout — use GPIO 6,7,14,15,21,22 |
| Chip mismatch | Must use `waveshare_c6_lcd_147`, not `esp32dev` |
| Panel renders monochrome | ST7789 constructor `IPS=false` — set `true`. Do not also invertDisplay |
| Near-black bg shows white | Use exactly `0x0000` for chassis bg — non-zero RGB565 trends white here |
| Flicker on animated screens | Full `fillScreen` per tick. Use the partial-redraw path; check `bridgeUiDraw()` shape invalidator |
| LED colors swapped (R↔G) | Expected on this board — `bridge_led.cpp` swaps at write site |
| LED flashes wrong color at trough | Underflow in breathe math — never compute `base - depth/2` on uint, scale 0..base |
| LED stays off during demo | `setLink/setTally` now writes immediately; `demoDelay()` ticks LED too |
| USB / flash dead after NRF wired | **GP12/GP13 = USB D-/D+** — move MOSI/MISO off header 12/13 |

---

## Roadmap (firmware)

1. **GATT connect + pair** to selected camera
2. **NRF24** link (NRFLite, harness above); bridge BLE ↔ RF protocol TBD
3. Optional: IRQ pin, **NVS** last camera, connect status on panel
4. Align with relay / session model in parent repo when RF path is clear

---

## Related docs

- `README.md` — quick commands
- `docs/bridge-panel-ui.md` — screen layout & button UX
- `docs/waveshare-c6-lcd-147-pinout.jpg` — Waveshare header GPIO diagram (W28563-005)
- Repo root `.cursor/context.md` — web app, relay, PRDs
- `docs/BlackmagicCameraControl.pdf` — BLE packet format

**When changing pins or colors:** update `bridge_config.h`, this file, and `README.md` together.
