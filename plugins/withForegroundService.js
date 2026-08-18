// Custom Expo config plugin: @notifee/react-native doesn't ship its own
// Expo config plugin, and its bundled AndroidManifest.xml only declares its
// content provider - not the foreground-service permissions/declaration a
// long-running photo scan needs to keep going while the user switches to
// another app. This adds exactly that to the manifest during prebuild/EAS
// build.
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

function addPermission(androidManifest, name) {
  androidManifest.manifest['uses-permission'] = androidManifest.manifest['uses-permission'] || [];
  const exists = androidManifest.manifest['uses-permission'].some(
    (entry) => entry.$['android:name'] === name
  );
  if (!exists) {
    androidManifest.manifest['uses-permission'].push({ $: { 'android:name': name } });
  }
}

function withForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;

    if (!androidManifest.manifest.$['xmlns:tools']) {
      androidManifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    addPermission(androidManifest, 'android.permission.FOREGROUND_SERVICE');
    addPermission(androidManifest, 'android.permission.FOREGROUND_SERVICE_DATA_SYNC');
    addPermission(androidManifest, 'android.permission.POST_NOTIFICATIONS');
    addPermission(androidManifest, 'android.permission.WAKE_LOCK');

    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
    mainApplication.service = mainApplication.service || [];
    const hasForegroundService = mainApplication.service.some(
      (entry) => entry.$['android:name'] === 'app.notifee.core.ForegroundService'
    );
    if (!hasForegroundService) {
      mainApplication.service.push({
        $: {
          'android:name': 'app.notifee.core.ForegroundService',
          'android:foregroundServiceType': 'dataSync',
          'android:exported': 'false',
          'tools:replace': 'android:foregroundServiceType',
        },
      });
    }

    return config;
  });
}

module.exports = withForegroundService;
