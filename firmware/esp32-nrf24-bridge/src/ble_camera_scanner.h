#pragma once

#include <Arduino.h>

struct CameraDevice {
  char name[32];
  char address[18];
  bool hasBmService;
};

bool bleScannerEnsureReady();
void bleScannerShutdown();
void bleScannerStart();
bool bleScannerIsActive();
void bleScannerLoop();
int bleScannerCount();
bool bleScannerGet(int index, CameraDevice &out);
void bleScannerClear();
