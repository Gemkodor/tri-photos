import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SubfolderEntry } from '../lib/imageFiles';
import { colors } from '../theme';

type Props = {
  subfolders: SubfolderEntry[];
  onConfirm: (selectedUris: string[]) => void;
  onCancel: () => void;
};

/**
 * Shown right after picking a folder, only when it actually has sub-folders
 * (see App.tsx's maybeAskSubfolders) - lets the user include just some of
 * them in this analysis (e.g. 2 out of 4), instead of always scanning
 * everything underneath. All checked by default, so a single tap keeps
 * today's "scan everything" behavior for anyone who doesn't need to narrow it.
 */
export default function SubfolderPickerScreen({ subfolders, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(subfolders.map((f) => f.uri))
  );

  function toggle(uri: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }

  const allChecked = selected.size === subfolders.length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={12}>
          <Text style={styles.backLink}>‹ Annuler</Text>
        </Pressable>
        <Text style={styles.title}>Quels dossiers analyser ?</Text>
        <Text style={styles.subtitle}>
          Ce dossier contient plusieurs sous-dossiers. Décoche ceux à laisser de côté pour cette
          analyse - tu pourras toujours relancer plus tard avec un autre choix.
        </Text>
        <Pressable
          onPress={() => setSelected(allChecked ? new Set() : new Set(subfolders.map((f) => f.uri)))}
          hitSlop={8}
        >
          <Text style={styles.selectAllLink}>{allChecked ? 'Tout décocher' : 'Tout cocher'}</Text>
        </Pressable>
      </View>

      <FlatList
        data={subfolders}
        keyExtractor={(item) => item.uri}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const isChecked = selected.has(item.uri);
          return (
            <Pressable style={styles.row} onPress={() => toggle(item.uri)}>
              <View style={[styles.checkbox, isChecked && styles.checkboxOn]}>
                {isChecked && <Text style={styles.checkboxText}>✓</Text>}
              </View>
              <Text style={styles.rowText} numberOfLines={1}>
                📁 {item.name}
              </Text>
            </Pressable>
          );
        }}
      />

      <View style={styles.bottomBar}>
        <Pressable
          style={[styles.confirmButton, selected.size === 0 && styles.confirmButtonDisabled]}
          disabled={selected.size === 0}
          onPress={() => onConfirm(Array.from(selected))}
        >
          <Text style={styles.confirmButtonText}>
            {selected.size === 0
              ? 'Coche au moins un dossier'
              : `Analyser ${selected.size} dossier${selected.size > 1 ? 's' : ''}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backLink: {
    color: colors.primary,
    fontSize: 15,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: colors.subtleText,
    lineHeight: 20,
    marginBottom: 12,
  },
  selectAllLink: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 120,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  rowText: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  confirmButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  confirmButtonDisabled: {
    backgroundColor: colors.border,
  },
  confirmButtonText: {
    color: colors.primaryText,
    fontSize: 16,
    fontWeight: '600',
  },
});
