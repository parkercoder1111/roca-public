import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.roca.app',
  appName: 'ROCA',
  webDir: 'dist/mobile',
  ios: {
    backgroundColor: '#000000',
    contentInset: 'always',
    preferredContentMode: 'mobile',
  },
  server: {
    // Allow WebSocket connections to any host (needed for LAN connection to Mac)
    allowNavigation: ['*'],
  },
};

export default config;
