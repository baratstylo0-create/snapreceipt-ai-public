import type { CapacitorConfig } from '@capacitor/cli'
import { isAllowedServerUrl } from './scripts/mobile-config'

const appUrl = (process.env.CAPACITOR_SERVER_URL || 'http://10.0.2.2:3001').replace(/\/$/, '')
const isLocalUrl = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(appUrl)

if (!isAllowedServerUrl(appUrl)) {
  throw new Error('CAPACITOR_SERVER_URL must be HTTPS, localhost, 127.0.0.1, or 10.0.2.2')
}

const config: CapacitorConfig = {
  appId: 'com.snapreceiptai.app',
  appName: 'SnapReceipt AI',
  webDir: 'public',
  server: {
    url: appUrl,
    cleartext: isLocalUrl,
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: process.env.CAPACITOR_DEBUG === '1',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#fbfaf7',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
}

export default config
