import type { CapacitorConfig } from "@capacitor/cli";

/** Native workflow: see `native/README.md`, ADR in `native/ADR-shell-capacitor.md`. */
const config: CapacitorConfig = {
  appId: 'com.almiro.bluetooth.camera',
  appName: 'Almiro Bluetooth Camera Control',
  webDir: 'dist'
};

export default config;
