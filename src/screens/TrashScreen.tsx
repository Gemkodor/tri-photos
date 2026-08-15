import { Image } from 'expo-image';
import React from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TrashEntry } from '../lib/trash';
import { colors } from '../theme';

type Props = {
  entries: TrashEntry[];
  onDeleteOne: (id: string) => void;
  onEmptyAll: () => void;
  onBack: () => void;
};

export default function TrashScreen({ entries, onDeleteOne, onEmptyAll, onBack }: Props) {
  function confirmDeleteOne(id: string, name: string) {
    Alert.alert(
      'Supprimer pour de bon ?',
      `"${name}" sera supprimée définitivement de ton téléphone.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => onDeleteOne(id) },
      ]
    );
  }

  function confirmEmptyAll() {
    Alert.alert(
      'Vider la corbeille ?',
      `Les ${entries.length} photo${entries.length > 1 ? 's' : ''} seront supprimées définitivement de ton téléphone.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Tout supprimer', style: 'destructive', onPress: onEmptyAll },
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
          sécurité, tant que tu ne les supprimes pas ici pour de bon.
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
                <Pressable
                  style={styles.deleteRowButton}
                  onPress={() => confirmDeleteOne(item.id, item.originalName)}
                >
                  <Text style={styles.deleteRowButtonText}>Supprimer</Text>
                </Pressable>
              </View>
            )}
          />
          <View style={styles.bottomBar}>
            <Pressable style={styles.emptyAllButton} onPress={confirmEmptyAll}>
              <Text style={styles.emptyAllButtonText}>Vider la corbeille</Text>
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
    paddingBottom: 100,
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
  deleteRowButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.dangerBackground,
  },
  deleteRowButtonText: {
    color: colors.danger,
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
  emptyAllButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  emptyAllButtonText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
});
