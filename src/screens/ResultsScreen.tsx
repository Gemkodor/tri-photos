import { Image } from 'expo-image';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SIMILARITY_LEVELS, type DuplicateGroup } from '../lib/duplicateGroups';
import { formatBytes } from '../lib/format';
import { colors } from '../theme';

type Props = {
  groups: DuplicateGroup[];
  selected: Set<string>;
  deleting: boolean;
  similarityThreshold: number;
  onChangeSimilarity: (threshold: number) => void;
  onToggleSelect: (uri: string) => void;
  onDeleteSelected: () => void;
  onBack: () => void;
};

export default function ResultsScreen({
  groups,
  selected,
  deleting,
  similarityThreshold,
  onChangeSimilarity,
  onToggleSelect,
  onDeleteSelected,
  onBack,
}: Props) {
  const selectedCount = selected.size;
  const currentLevel =
    SIMILARITY_LEVELS.find((l) => l.threshold === similarityThreshold) ?? SIMILARITY_LEVELS[1];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.backLink}>‹ Autre dossier</Text>
        </Pressable>
        <Text style={styles.headerTitle}>
          {groups.length === 0
            ? 'Aucun doublon trouvé'
            : `${groups.length} groupe${groups.length > 1 ? 's' : ''} de photos semblables`}
        </Text>
      </View>

      <View style={styles.similaritySection}>
        <Text style={styles.similarityLabel}>Niveau de ressemblance</Text>
        <View style={styles.similarityRow}>
          {SIMILARITY_LEVELS.map((level) => {
            const active = level.threshold === similarityThreshold;
            return (
              <Pressable
                key={level.id}
                style={[styles.similarityChip, active && styles.similarityChipActive]}
                onPress={() => onChangeSimilarity(level.threshold)}
              >
                <Text
                  style={[styles.similarityChipText, active && styles.similarityChipTextActive]}
                >
                  {level.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.similarityDescription}>{currentLevel.description}</Text>
      </View>

      {groups.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Je n'ai pas trouvé de photos qui se ressemblent à ce niveau de ressemblance. Essaie un
            réglage plus large ci-dessus, ou un autre dossier.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.instructions}>
            Touche les photos que tu veux mettre de côté. La plus grande (souvent la meilleure
            qualité) est repérée par une étoile.
          </Text>
          {groups.map((group, groupIndex) => (
            <View key={group.id} style={styles.groupCard}>
              <Text style={styles.groupLabel}>
                Groupe {groupIndex + 1} · {group.photos.length} photos semblables
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {group.photos.map((photo, photoIndex) => {
                  const isSelected = selected.has(photo.uri);
                  return (
                    <Pressable
                      key={photo.uri}
                      style={styles.thumbWrapper}
                      onPress={() => onToggleSelect(photo.uri)}
                    >
                      <Image
                        source={{ uri: photo.uri }}
                        style={[styles.thumb, isSelected && styles.thumbSelected]}
                        contentFit="cover"
                      />
                      {photoIndex === 0 && (
                        <View style={styles.bestBadge}>
                          <Text style={styles.bestBadgeText}>★</Text>
                        </View>
                      )}
                      <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
                        {isSelected && <Text style={styles.checkboxMark}>✓</Text>}
                      </View>
                      <Text style={styles.thumbSize}>{formatBytes(photo.sizeBytes)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      )}

      {groups.length > 0 && (
        <View style={styles.bottomBar}>
          <Pressable
            style={[styles.deleteButton, selectedCount === 0 && styles.deleteButtonDisabled]}
            disabled={selectedCount === 0 || deleting}
            onPress={onDeleteSelected}
          >
            {deleting ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <Text style={styles.deleteButtonText}>
                {selectedCount === 0
                  ? 'Choisis les photos à mettre de côté'
                  : `Mettre de côté ${selectedCount} photo${selectedCount > 1 ? 's' : ''}`}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const THUMB_SIZE = 120;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  backLink: {
    color: colors.primary,
    fontSize: 15,
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  similaritySection: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  similarityLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.subtleText,
    marginBottom: 8,
  },
  similarityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  similarityChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginRight: 8,
    marginBottom: 8,
  },
  similarityChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  similarityChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  similarityChipTextActive: {
    color: colors.primaryText,
  },
  similarityDescription: {
    fontSize: 13,
    color: colors.subtleText,
    lineHeight: 18,
  },
  empty: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: colors.subtleText,
    textAlign: 'center',
    lineHeight: 22,
  },
  list: {
    padding: 20,
    paddingBottom: 100,
  },
  instructions: {
    fontSize: 14,
    color: colors.subtleText,
    marginBottom: 16,
    lineHeight: 20,
  },
  groupCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 10,
  },
  thumbWrapper: {
    marginRight: 10,
    alignItems: 'center',
    width: THUMB_SIZE,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 12,
    backgroundColor: colors.border,
  },
  thumbSelected: {
    opacity: 0.4,
  },
  bestBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: colors.badge,
    borderRadius: 10,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bestBadgeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  checkbox: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  checkboxMark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  thumbSize: {
    marginTop: 6,
    fontSize: 12,
    color: colors.subtleText,
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
  deleteButton: {
    backgroundColor: colors.danger,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  deleteButtonDisabled: {
    backgroundColor: colors.border,
  },
  deleteButtonText: {
    color: colors.primaryText,
    fontSize: 16,
    fontWeight: '600',
  },
});
