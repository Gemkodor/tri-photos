import { Image } from 'expo-image';
import React from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TrashEntry } from '../lib/trash';
import { colors } from '../theme';

type Props = {
  entries: TrashEntry[];
  onSetAsideOne: (id: string) => void;
  onSetAsideAll: () => void;
  onRestoreOne: (id: string) => void;
  onRestoreAll: () => void;
  onBack: () => void;
};

export default function TrashScreen({
  entries,
  onSetAsideOne,
  onSetAsideAll,
  onRestoreOne,
  onRestoreAll,
  onBack,
}: Props) {
  function confirmSetAsideOne(id: string, name: string) {
    Alert.alert(
      'Ranger cette photo ?',
      `"${name}" sera déplacée dans un dossier "De côté", à l'intérieur du dossier analysé. Rien n'est supprimé, tu pourras toujours la retrouver.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Ranger', onPress: () => onSetAsideOne(id) },
      ]
    );
  }

  function confirmSetAsideAll() {
    Alert.alert(
      'Ranger ces photos ?',
      `Les ${entries.length} photo${entries.length > 1 ? 's' : ''} seront déplacées dans un dossier "De côté", à l'intérieur du dossier analysé. Rien n'est supprimé, tu pourras toujours les retrouver.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Tout ranger', onPress: onSetAsideAll },
      ]
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.backLink}>‹ Retour</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Corbeille</Text>
        <Text style={styles.headerSubtitle}>
          Ces photos ont été retirées de leur dossier. Elles restent sur ton téléphone, en
          sécurité. Range-les dans "De côté" pour vraiment libérer de la place dans le dossier
          d'origine, ou restaure-les si tu as changé d'avis - rien n'est jamais supprimé.
        </Text>
      </View>

      {entries.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>La corbeille est vide.</Text>
        </View>
      ) : (
        <>
          <FlatList
            data={entries}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.originalName}
                </Text>
                <View style={styles.rowActions}>
                  <Pressable
                    style={styles.restoreRowButton}
                    onPress={() => onRestoreOne(item.id)}
                  >
                    <Text style={styles.restoreRowButtonText}>Restaurer</Text>
                  </Pressable>
                  <Pressable
                    style={styles.setAsideRowButton}
                    onPress={() => confirmSetAsideOne(item.id, item.originalName)}
                  >
                    <Text style={styles.setAsideRowButtonText}>Ranger</Text>
                  </Pressable>
                </View>
              </View>
            )}
          />
          <View style={styles.bottomBar}>
            <Pressable style={styles.setAsideAllButton} onPress={confirmSetAsideAll}>
              <Text style={styles.setAsideAllButtonText}>Tout ranger dans "De côté"</Text>
            </Pressable>
            <Pressable style={styles.restoreAllButton} onPress={onRestoreAll}>
              <Text style={styles.restoreAllButtonText}>Tout restaurer</Text>
            </Pressable>
          </View>
        </>
      )}
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
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 6,
  },
  headerSubtitle: {
    fontSize: 14,
    color: colors.subtleText,
    lineHeight: 20,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: colors.subtleText,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 130,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  rowName: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
    fontSize: 14,
    color: colors.text,
  },
  rowActions: {
    alignItems: 'flex-end',
  },
  restoreRowButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  restoreRowButtonText: {
    color: colors.subtleText,
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  setAsideRowButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  setAsideRowButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
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
  setAsideAllButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: colors.primary,
  },
  setAsideAllButtonText: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: '600',
  },
  restoreAllButton: {
    marginTop: 10,
    alignItems: 'center',
  },
  restoreAllButtonText: {
    color: colors.subtleText,
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
