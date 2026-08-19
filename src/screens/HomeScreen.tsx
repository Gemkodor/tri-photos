import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SORT_PART_ORDER, SORT_PARTS, type SortMode } from '../lib/duplicateGroups';
import { colors } from '../theme';

type Props = {
  hasLastFolder: boolean;
  trashCount: number;
  trashReminder: string | null;
  onPickFolder: (mode: SortMode) => void;
  onRescanLastFolder: (mode: SortMode) => void;
  onOpenTrash: () => void;
};

export default function HomeScreen({
  hasLastFolder,
  trashCount,
  trashReminder,
  onPickFolder,
  onRescanLastFolder,
  onOpenTrash,
}: Props) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.hero}>
        <Text style={styles.title}>Tri Photos</Text>
        <Text style={styles.subtitle}>
          Ton assistant de tri, en deux parties indépendantes. Choisis celle par laquelle
          commencer.
        </Text>
      </View>

      {SORT_PART_ORDER.map((part, index) => {
        const info = SORT_PARTS[part];
        return (
          <View key={part} style={styles.stepCard}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepBadgeText}>{index + 1}</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepTitle}>{info.title}</Text>
              <Text style={styles.stepDescription}>{info.description}</Text>
              <Pressable style={styles.stepButton} onPress={() => onPickFolder(info.entryMode)}>
                <Text style={styles.stepButtonText}>Choisir un dossier</Text>
              </Pressable>
              {hasLastFolder && (
                <Pressable
                  style={styles.stepLink}
                  onPress={() => onRescanLastFolder(info.entryMode)}
                >
                  <Text style={styles.stepLinkText}>Relancer sur le dernier dossier</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}

      {trashCount > 0 && (
        <Pressable style={styles.trashButton} onPress={onOpenTrash}>
          <Text style={styles.trashButtonText}>
            Voir la corbeille ({trashCount} photo{trashCount > 1 ? 's' : ''})
          </Text>
        </Pressable>
      )}

      {trashReminder && (
        <Pressable style={styles.reminderBanner} onPress={onOpenTrash}>
          <Text style={styles.reminderBannerText}>🗑 {trashReminder}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  contentContainer: {
    padding: 24,
    paddingTop: 32,
    flexGrow: 1,
    justifyContent: 'center',
  },
  hero: {
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.subtleText,
    lineHeight: 21,
  },
  stepCard: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  stepBadgeText: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: '700',
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 6,
  },
  stepDescription: {
    fontSize: 13,
    color: colors.subtleText,
    lineHeight: 18,
    marginBottom: 14,
  },
  stepButton: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  stepButtonText: {
    color: colors.primaryText,
    fontSize: 14,
    fontWeight: '600',
  },
  stepLink: {
    marginTop: 10,
    alignItems: 'center',
  },
  stepLinkText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  trashButton: {
    marginTop: 14,
    alignItems: 'center',
  },
  trashButtonText: {
    color: colors.subtleText,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  reminderBanner: {
    marginTop: 20,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.dangerBackground,
  },
  reminderBannerText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
});
