#pragma once

#include <Arduino.h>

enum class BtnEvent { None, Up, Down, Select, LongSelect };

void buttonsInit();
bool buttonsHasUpDown();
BtnEvent buttonsPoll();
