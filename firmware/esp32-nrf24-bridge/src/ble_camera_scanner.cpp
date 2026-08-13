#include "ble_camera_scanner.h"

#include <NimBLEDevice.h>

#include "bridge_config.h"

namespace {
constexpr int kMaxDevices = UI_LIST_MAX;
CameraDevice g_devices[kMaxDevices];
int g_count = 0;
bool g_scanning = false;
bool g_bleUp = false;
NimBLEScan *g_scan = nullptr;

bool shouldIncludeDevice(const NimBLEAdvertisedDevice *device) {
#if BLE_SCAN_ALL_DEVICES
  (void)device;
  return true;
#else
  if (device->isAdvertisingService(NimBLEUUID(BM_CAMERA_SERVICE_UUID))) return true;
  const std::string &name = device->getName();
  if (name.empty()) return false;
  if (name.find("Blackmagic") != std::string::npos) return true;
  if (name.find("blackmagic") != std::string::npos) return true;
  if (name.find("URSA") != std::string::npos) return true;
  if (name.find("Pocket") != std::string::npos) return true;
  return false;
#endif
}

int findIndex(const std::string &addr) {
  for (int i = 0; i < g_count; i++) {
    if (strcmp(g_devices[i].address, addr.c_str()) == 0) return i;
  }
  return -1;
}

class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice *advertisedDevice) override {
    if (!shouldIncludeDevice(advertisedDevice)) return;

    const std::string addr = advertisedDevice->getAddress().toString();
    int idx = findIndex(addr);
    if (idx < 0) {
      if (g_count >= kMaxDevices) return;
      idx = g_count++;
    }

    CameraDevice &d = g_devices[idx];
    strncpy(d.address, addr.c_str(), sizeof(d.address) - 1);
    d.address[sizeof(d.address) - 1] = '\0';

    const std::string &name = advertisedDevice->getName();
    if (!name.empty()) {
      strncpy(d.name, name.c_str(), sizeof(d.name) - 1);
    } else {
      snprintf(d.name, sizeof(d.name), "Unknown %s", d.address);
    }
    d.name[sizeof(d.name) - 1] = '\0';
    d.hasBmService = advertisedDevice->isAdvertisingService(NimBLEUUID(BM_CAMERA_SERVICE_UUID));

    Serial.printf("[ble] found %s (%s)\n", d.name, d.address);
  }

  void onScanEnd(const NimBLEScanResults &results, int reason) override {
    (void)results;
    (void)reason;
    g_scanning = false;
    Serial.printf("[ble] scan done, %d device(s)\n", g_count);
  }
};

ScanCallbacks g_callbacks;
}  // namespace

bool bleScannerEnsureReady() {
  if (g_bleUp) return true;
  NimBLEDevice::init("BM-Bridge");
  NimBLEDevice::setPower(ESP_PWR_LVL_N0);  // lowest TX — enough for bench
  g_scan = NimBLEDevice::getScan();
  g_scan->setScanCallbacks(&g_callbacks);
  g_scan->setActiveScan(true);
  g_scan->setInterval(200);
  g_scan->setWindow(70);
  g_bleUp = true;
  Serial.println("[ble] radio on");
  return true;
}

void bleScannerShutdown() {
  if (g_scanning && g_scan != nullptr) {
    g_scan->stop();
    g_scanning = false;
  }
  if (!g_bleUp) return;
  NimBLEDevice::deinit(true);
  g_scan = nullptr;
  g_bleUp = false;
  Serial.println("[ble] radio off");
}

void bleScannerStart() {
  if (!bleScannerEnsureReady()) return;
  bleScannerClear();
  g_scanning = true;
  g_scan->start(3, false, true);  // 3 s scan window
  Serial.println("[ble] scan started");
}

bool bleScannerIsActive() { return g_scanning; }

void bleScannerLoop() {
  if (!g_scanning) return;
  g_scan->stop();
  g_scanning = false;
}

int bleScannerCount() { return g_count; }

bool bleScannerGet(int index, CameraDevice &out) {
  if (index < 0 || index >= g_count) return false;
  out = g_devices[index];
  return true;
}

void bleScannerClear() {
  g_count = 0;
  memset(g_devices, 0, sizeof(g_devices));
}
