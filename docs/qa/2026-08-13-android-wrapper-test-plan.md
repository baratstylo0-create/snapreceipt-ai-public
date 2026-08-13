# SnapReceipt Android Wrapper Test Plan

## Local build checks

1. Run `node --test tests/capacitor.config.test.js`.
2. Run the complete Node test suite with the existing repository procedure that keeps local secrets out of test output.
3. Run `npx cap doctor`.
4. Set `CAPACITOR_SERVER_URL=http://10.0.2.2:3001` for emulator development and run `npx cap sync android`.
5. Run `android\gradlew.bat assembleDebug` with Android Studio JDK 21.

## Device checks

Install the debug APK on an available Android device or emulator and verify:

- App launches without a blank screen.
- Login/signup or token gate works.
- Receipt image and PDF upload reaches the server.
- OCR result appears and can be edited.
- Review queue, reports, and exports work.
- Android back navigation does not exit unexpectedly from an open screen.
- Logout and expired-session handling return to the correct auth screen.
- Offline/server-unavailable states show a usable error rather than a blank page.

## Play release checks

- `CAPACITOR_SERVER_URL` is a real HTTPS production URL.
- The bundle is signed with the SnapReceipt upload key.
- Package name is `com.snapreceiptai.app`.
- Version code is greater than the last uploaded version for every update.
- Internal-testing install works from the Play opt-in link before wider release.
