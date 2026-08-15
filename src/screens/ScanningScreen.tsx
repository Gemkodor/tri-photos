import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export type ScanStatus = {
  phase: 'listing' | 'hashing';
  foundImages: number;
  hashedCount: number;
};

export default function ScanningScreen({ status }: { status: ScanStatus }) {
  const isHashing = status.phase === 'hashing';
  const total = Math.max(status.foundImages, 1);
  const progress = isHashing ? Math.min(status.hashedCount / total, 1) : 0;

  return (
    <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: colors.subtleText,
    textAlign: 'center',
    marginBottom: 24,
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
    marginTop: 28,
    fontSize: 13,
    color: colors.subtleText,
    textAlign: 'center',
  },
});
