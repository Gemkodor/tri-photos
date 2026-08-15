import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

type Props = {
  hasLastFolder: boolean;
  trashCount: number;
  onPickFolder: () => void;
  onRescanLastFolder: () => void;
  onOpenTrash: () => void;
};

export default function HomeScreen({
  hasLastFolder,
  trashCount,
  onPickFolder,
  onRescanLastFolder,
  onOpenTrash,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.title}>Tri Photos</Text>
        <Text style={styles.subtitle}>
          Choisis un dossier de photos sur ton téléphone. L'appli regarde chaque photo et te
          montre celles qui se ressemblent, pour t'aider à repérer les doublons avant de faire ton
          album.
        </Text>
      </View>

      <Pressable style={styles.primaryButton} onPress={onPickFolder}>
        <Text style={styles.primaryButtonText}>Choisir un dossier à analyser</Text>
      </Pressable>

      {hasLastFolder && (
        <Pressable style={styles.secondaryButton} onPress={onRescanLastFolder}>
          <Text style={styles.secondaryButtonText}>Relancer l'analyse du dernier dossier</Text>
        </Pressable>
      )}

      {trashCount > 0 && (
        <Pressable style={styles.trashButton} onPress={onOpenTrash}>
          <Text style={styles.trashButtonText}>
            Voir la corbeille ({trashCount} photo{trashCount > 1 ? 's' : ''})
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 24,
    justifyContent: 'center',
  },
  hero: {
    marginBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: colors.subtleText,
    lineHeight: 22,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: colors.primaryText,
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  trashButton: {
    marginTop: 28,
    alignItems: 'center',
  },
  trashButtonText: {
    color: colors.subtleText,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});
