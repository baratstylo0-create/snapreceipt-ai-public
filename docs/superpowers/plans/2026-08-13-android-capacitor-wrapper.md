# SnapReceipt Android Capacitor Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maintainable Capacitor Android wrapper that packages the existing SnapReceipt web dashboard into a Play-compatible Android App Bundle without duplicating the product UI or backend.

**Architecture:** The existing `public/` web frontend remains the single UI source of truth and the existing Node/Express server remains the single API source of truth. Capacitor supplies a native Android host in `android/`; production builds load a configured HTTPS deployment URL, while local development can point to an emulator-accessible HTTP URL. Android-specific behavior is limited to shell concerns such as back navigation, file picking, and release signing.

**Tech Stack:** Capacitor 8.4.x, Android Gradle Plugin 8.13, Android SDK 36, Android Studio JDK 21, Node 20+, vanilla HTML/JavaScript frontend, Gradle release bundle.

## Global Constraints

- Package ID is `com.snapreceiptai.app` and must never change after the first Play upload.
- New Google Play submissions must target Android API 36 from August 31, 2026.
- `CAPACITOR_SERVER_URL` is required for a production release; localhost and emulator URLs are development-only.
- Play App Signing remains enabled; the local upload keystore and passwords stay outside Git and chat.
- Do not edit `.env`, credential exports, or live hosting configuration.
- Do not add native receipt/OCR/business logic; those remain in the existing web/API product.
- Do not commit generated `android/app/build`, `.gradle`, `local.properties`, keystores, or release bundles.

---

### Task 1: Mobile configuration contract

**Files:**
- Create: `capacitor.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/capacitor.config.test.js`

**Interfaces:**
- Consumes: `CAPACITOR_SERVER_URL`, `CAPACITOR_DEBUG`, and the existing `public/index.html`.
- Produces: Capacitor app identity `com.snapreceiptai.app`, app name `SnapReceipt AI`, and a server URL policy that distinguishes production HTTPS from local development.

- [ ] Write tests asserting the config declares the fixed app ID/name, uses `public` as `webDir`, rejects an HTTP non-localhost URL, and permits `http://10.0.2.2:3001` for emulator development.
- [ ] Run `node --test tests/capacitor.config.test.js` and observe failure because the config and helper do not exist.
- [ ] Implement a small CommonJS URL policy helper used by the test and TypeScript Capacitor config; production URLs must be HTTPS and local development URLs must be localhost, `127.0.0.1`, or `10.0.2.2`.
- [ ] Add Capacitor 8.4.x CLI/core/android development dependencies and mobile scripts without changing runtime dependencies.
- [ ] Run the focused test and then `npm install` to update the lockfile.

### Task 2: Android project generation and shell configuration

**Files:**
- Create: `android/` via `npx cap add android`
- Modify: `android/variables.gradle`
- Modify: `android/app/build.gradle`
- Modify: `android/app/src/main/AndroidManifest.xml` only if generated defaults need the documented Internet permission
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1 Capacitor configuration and installed Capacitor packages.
- Produces: a standard Capacitor Android project with API 24 minimum, compile/target SDK 36, package ID `com.snapreceiptai.app`, and a normal `MainActivity` bridge.

- [ ] Generate the Android project and run `npx cap sync android`.
- [ ] Set `minSdkVersion = 24`, `compileSdkVersion = 36`, and `targetSdkVersion = 36`.
- [ ] Set the Android namespace/application ID and initial version to `versionCode 1`, `versionName "1.0.0"`.
- [ ] Preserve only `INTERNET` permission unless a tested feature requires another permission.
- [ ] Add Android generated/build/signing exclusions to Git while keeping source Gradle files tracked.
- [ ] Run `npx cap doctor` and Gradle’s debug compilation task.

### Task 3: Release signing and operator documentation

**Files:**
- Modify: `android/app/build.gradle`
- Create: `android/RELEASE_BUILD.md`
- Create: `.env.mobile.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `JAVA_HOME`, and `CAPACITOR_SERVER_URL`.
- Produces: a release build that fails clearly when signing or production URL configuration is absent, and produces `android/app/build/outputs/bundle/release/app-release.aab` when configured.

- [ ] Add a release Gradle guard that refuses `bundleRelease` unless all four signing variables are present.
- [ ] Add a production URL guard so a release build cannot be mistaken for a usable Play artifact when `CAPACITOR_SERVER_URL` is missing or non-HTTPS.
- [ ] Document one-time upload-key creation, Google Play App Signing, environment-variable setup, `npx cap sync android`, `bundleRelease`, and the output path.
- [ ] Document that the keystore must be backed up privately and that losing it affects future updates.
- [ ] Verify `.env.mobile.example` contains names only and no values.

### Task 4: Test and release verification

**Files:**
- Modify: `tests/capacitor.config.test.js` if verification exposes a contract gap
- Create: `docs/qa/2026-08-13-android-wrapper-test-plan.md`

**Interfaces:**
- Consumes: generated Android project and release instructions.
- Produces: repeatable checks for configuration, web regression safety, Android compilation, device installation, and Play internal testing.

- [ ] Run the focused mobile configuration tests.
- [ ] Run the complete Node test suite with the repository’s existing environment-safety procedure; do not expose `.env` contents.
- [ ] Run `npx cap sync android` and `npx cap doctor`.
- [ ] Run the Android debug build with Android Studio JDK 21.
- [ ] Check `adb devices`; install and launch on any available local device/emulator, otherwise record that device verification is pending.
- [ ] Attempt `bundleRelease` only when a real production URL and private upload keystore are available; otherwise record the exact blocker and leave the project buildable.
- [ ] Review the final diff for secrets, generated artifacts, unintended backend/UI behavior changes, and package ID consistency.
