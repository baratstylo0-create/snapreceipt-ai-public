# SnapReceipt AI Android Release Build

The Android project is a Capacitor shell around the existing SnapReceipt web app. The production bundle must load a deployed HTTPS URL and must be signed with the private upload key enrolled in Google Play App Signing.

## One-time upload key

Run this in PowerShell. Keep the `.jks` file and both passwords in a password manager. Do not commit or send them in chat.

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore "$env:USERPROFILE\snapreceipt-upload-key.jks" `
  -alias snapreceipt-upload `
  -keyalg RSA -keysize 2048 -validity 10000
```

In Play Console, keep Google Play App Signing enabled. The key generated above is the upload key, not the Google-managed app-signing key.

## Build the signed bundle

Use the real deployed HTTPS URL for the SnapReceipt server. Do not use `localhost`, `127.0.0.1`, or `10.0.2.2` for a Play release.

```powershell
$env:CAPACITOR_SERVER_URL = "https://YOUR-SNAPRECEIPT-DOMAIN"
$env:ANDROID_KEYSTORE_PATH = "$env:USERPROFILE\snapreceipt-upload-key.jks"
$env:ANDROID_KEYSTORE_PASSWORD = Read-Host "Keystore password"
$env:ANDROID_KEY_ALIAS = "snapreceipt-upload"
$env:ANDROID_KEY_PASSWORD = Read-Host "Key password"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

cd "C:\Users\Asus\OneDrive - wsm llc\Documents\ChatGPT\SnapReceiptAI"
npx cap sync android
cd android
.\gradlew.bat bundleRelease
```

The bundle is created at:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

Upload that `.aab` to the SnapReceipt internal-testing track. The package name must remain `com.snapreceiptai.app` for every future update.
