import Constants, { ExecutionEnvironment } from 'expo-constants';

const CHANNEL_ID = 'triPhotos.scanning';
const NOTIFICATION_ID = 'triPhotos.scanningProgress';

// Notifee needs real native code, which Expo Go can't provide (it ships a
// fixed set of native modules and can't include ones added after the fact).
// Everything in this file is therefore best-effort: it lets the "real",
// installed app keep analyzing photos while the user is in another app, but
// quietly does nothing while testing through Expo Go, or if anything about
// notifications/foreground services fails for any other reason - a photo
// scan must never break because of this.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

async function loadNotifee() {
  if (isExpoGo) return null;
  try {
    return await import('@notifee/react-native');
  } catch {
    return null;
  }
}

let serviceStarted = false;

/**
 * Starts a foreground service with a progress notification, so Android
 * knows this work matters and keeps it running even if the user switches to
 * another app. No-op (returns quietly) if unavailable.
 */
export async function startScanningService(total: number): Promise<void> {
  const mod = await loadNotifee();
  if (!mod) return;

  try {
    const notifee = mod.default;
    const { AndroidImportance, AndroidForegroundServiceType } = mod;

    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Analyse de photos',
      importance: AndroidImportance.LOW,
    });

    notifee.registerForegroundService(() => {
      return new Promise(() => {
        // Resolves only when stopForegroundService() is called - keeps the
        // service (and the app's process) alive for the length of the scan.
      });
    });

    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Tri Photos analyse tes photos',
      body: `0 / ${total} photos analysées`,
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        ongoing: true,
        onlyAlertOnce: true,
        progress: { max: total, current: 0 },
      },
    });
    serviceStarted = true;
  } catch {
    serviceStarted = false;
  }
}

/** Updates the progress notification. No-op if the service never started. */
export async function updateScanningProgress(current: number, total: number): Promise<void> {
  if (!serviceStarted) return;
  const mod = await loadNotifee();
  if (!mod) return;

  try {
    await mod.default.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Tri Photos analyse tes photos',
      body: `${current} / ${total} photos analysées`,
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        ongoing: true,
        onlyAlertOnce: true,
        progress: { max: total, current },
      },
    });
  } catch {
    // Not critical - the scan itself keeps going regardless.
  }
}

/** Stops the foreground service and clears the notification. Safe to call even if never started. */
export async function stopScanningService(): Promise<void> {
  if (!serviceStarted) return;
  serviceStarted = false;
  const mod = await loadNotifee();
  if (!mod) return;

  try {
    await mod.default.stopForegroundService();
    await mod.default.cancelNotification(NOTIFICATION_ID);
  } catch {
    // Nothing more we can do - the scan has already finished either way.
  }
}
