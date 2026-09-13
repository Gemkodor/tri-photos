import { useKeepAwake } from 'expo-keep-awake';
import { Image } from 'expo-image';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export type ScanStatus = {
  phase: 'listing' | 'hashing';
  foundImages: number;
  hashedCount: number;
  /** The photo currently being looked at, shown as a live preview so there's
   *  something to watch during a long analysis. */
  currentPhotoUri?: string | null;
};

export default function ScanningScreen({ status }: { status: ScanStatus }) {
  // The actual photo analysis runs inside a hidden WebView (see HashWorker) -
  // Android pauses a WebView's own JavaScript the moment its screen turns
  // off or the app is backgrounded, regardless of any foreground service,
  // which is what was actually stopping the scan (not the missing
  // notification alone). This can't prevent that for a deliberate lock or
  // app-switch, but it does stop the screen from timing out and locking on
  // its own while this screen is showing, which was likely happening too.
  useKeepAwake();
  const isHashing = status.phase === 'hashing';
  const total = Math.max(status.foundImages, 1);
  const progress = isHashing ? Math.min(status.hashedCount / total, 1) : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {status.currentPhotoUri && (
        <View style={styles.previewCard}>
          <Image
            key={status.currentPhotoUri}
            source={{ uri: status.currentPhotoUri }}
            style={styles.previewImage}
            contentFit="cover"
          />
        </View>
      )}

      <Text style={styles.title}>
        {isHashing ? 'Analyse visuelle des photos…' : 'Recherche des photos…'}
      </Text>
      <Text style={styles.subtitle}>
        {isHashing
          ? `${status.hashedCount} / ${status.foundImages} photos analysées`
          : `${status.foundImages} photo${status.foundImages > 1 ? 's' : ''} trouvée${
              status.foundImages > 1 ? 's' : ''
            } pour l'instant…`}
      </Text>

      {isHashing && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      )}

      <Text style={styles.hint}>
        Ça peut prendre un moment si le dossier contient beaucoup de photos et de sous-dossiers.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.background,
    padding: 24,
    paddingTop: 32,
    alignItems: 'center',
  },
  previewCard: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.subtleText,
    textAlign: 'center',
    marginBottom: 18,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 5,
  },
  hint: {
    marginTop: 20,
    fontSize: 13,
    color: colors.subtleText,
    textAlign: 'center',
  },
});
