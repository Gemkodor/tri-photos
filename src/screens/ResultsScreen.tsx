import Slider from '@react-native-community/slider';
import { Image } from 'expo-image';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import PhotoViewer from '../components/PhotoViewer';
import {
  bestPhotoReason,
  computeSharpnessBaseline,
  findClosestPair,
  groupHasLargeSizeDifference,
  groupIsSameFolder,
  groupKey,
  isBlurryPhoto,
  nextSortMode,
  partSteps,
  percentToThreshold,
  similarityDescription,
  thresholdToPercent,
  SORT_STEPS,
  type DuplicateGroup,
  type SortMode,
} from '../lib/duplicateGroups';
import { formatBytes } from '../lib/format';
import type { HashedPhoto } from '../lib/perceptualHash';
import { colors } from '../theme';

type Props = {
  mode: SortMode;
  photoCount: number;
  allPhotos: HashedPhoto[];
  groups: DuplicateGroup[];
  selected: Set<string>;
  laterUris: Set<string>;
  onSetPhotoStatus: (uri: string, status: 'keep' | 'later' | 'trash') => void;
  deleting: boolean;
  similarityThreshold: number;
  trashCount: number;
  trashReminder: string | null;
  reviewedGroupKeys: Set<string>;
  onChangeSimilarity: (threshold: number) => void;
  onToggleSelect: (uri: string) => void;
  onSelectExceptBest: (uris: string[]) => void;
  onMarkGroupReviewed: (key: string) => void;
  onDeleteSelected: () => void;
  onBack: () => void;
  onOpenTrash: () => void;
  onSwitchMode: (mode: SortMode) => void;
  onFinishSorting: () => void;
  /** Debug: why face detection did or didn't come up during the last scan. */
  faceModelDiagnostic: string | null;
};

type FlatViewer = { photos: HashedPhoto[]; index: number; title: string };

export default function ResultsScreen({
  mode,
  photoCount,
  allPhotos,
  groups,
  selected,
  laterUris,
  onSetPhotoStatus,
  deleting,
  similarityThreshold,
  trashCount,
  trashReminder,
  reviewedGroupKeys,
  onChangeSimilarity,
  onToggleSelect,
  onSelectExceptBest,
  onMarkGroupReviewed,
  onDeleteSelected,
  onBack,
  onOpenTrash,
  onSwitchMode,
  onFinishSorting,
  faceModelDiagnostic,
}: Props) {
  const [viewerGroupIndex, setViewerGroupIndex] = useState<number | null>(null);
  const [viewerPhotoIndex, setViewerPhotoIndex] = useState(0);
  const [flatViewer, setFlatViewer] = useState<FlatViewer | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [keepMode, setKeepMode] = useState(false);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [hideUnhearted, setHideUnhearted] = useState(false);
  // The slider works directly in percent (not the raw 0-64 hash distance):
  // that distance is an integer, so converting it to percent and back loses
  // precision at some values (26 -> "59%", but nothing maps back to a clean
  // "60%") - tracking the percent the user actually chose avoids the thumb
  // snapping to a different-looking number right after they let go.
  const [sliderPercent, setSliderPercent] = useState(() => thresholdToPercent(similarityThreshold));

  useEffect(() => {
    setSliderPercent(thresholdToPercent(similarityThreshold));
    // Only resync when switching steps (a genuinely new context) - not on
    // every threshold change, which would undo the fix above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const selectedCount = selected.size;
  const hasGroups = mode === 'duplicates' || mode === 'similar';
  const currentPartSteps = partSteps(mode);

  // Blur is judged two ways: relative to a photo's own group (catches a
  // blurry shot among otherwise-sharp near-duplicates) and relative to the
  // scan's reference sharpness (catches a lone blurry photo with nothing
  // similar to compare it against) - see isBlurryPhoto.
  const sharpnessBaseline = useMemo(() => computeSharpnessBaseline(allPhotos), [allPhotos]);
  const groupByUri = useMemo(() => {
    const map = new Map<string, DuplicateGroup>();
    groups.forEach((g) => g.photos.forEach((p) => map.set(p.uri, g)));
    return map;
  }, [groups]);
  const blurryPhotos = useMemo(
    () =>
      allPhotos.filter((p) => isBlurryPhoto(p, groupByUri.get(p.uri) ?? null, sharpnessBaseline)),
    [allPhotos, groupByUri, sharpnessBaseline]
  );
  const blurryUris = useMemo(() => new Set(blurryPhotos.map((p) => p.uri)), [blurryPhotos]);
  // The dedicated "blurry" step is only for photos with no group of their
  // own to be judged against (isBlurryInGroup can't run for those at all) -
  // grouped ones already get their chance to be reviewed in "similar".
  const standaloneBlurryPhotos = useMemo(
    () => blurryPhotos.filter((p) => !groupByUri.has(p.uri)),
    [blurryPhotos, groupByUri]
  );
  const laterPhotos = useMemo(
    () => allPhotos.filter((p) => laterUris.has(p.uri)),
    [allPhotos, laterUris]
  );

  function isBlurry(photo: HashedPhoto): boolean {
    return isBlurryPhoto(photo, groupByUri.get(photo.uri) ?? null, sharpnessBaseline);
  }

  const reviewedCount = groups.filter((g) => reviewedGroupKeys.has(groupKey(g))).length;
  const visibleGroups = useMemo(() => {
    const base = showReviewed ? groups : groups.filter((g) => !reviewedGroupKeys.has(groupKey(g)));
    // Duplicates only, ordered in three tiers: groups spread across
    // different sub-folders first (need a closer look before picking which
    // to keep), then same-folder groups with photos of similar size, then
    // same-folder groups with a big size gap (Mo next to Ko) - the ones
    // most likely to need a closer look despite matching folders.
    if (mode !== 'duplicates') return base;
    return [...base].sort((a, b) => {
      const folderDiff = Number(groupIsSameFolder(a)) - Number(groupIsSameFolder(b));
      if (folderDiff !== 0) return folderDiff;
      return Number(groupHasLargeSizeDifference(a)) - Number(groupHasLargeSizeDifference(b));
    });
  }, [groups, showReviewed, reviewedGroupKeys, mode]);

  const viewerGroup = viewerGroupIndex !== null ? (visibleGroups[viewerGroupIndex] ?? null) : null;
  const nextMode = nextSortMode(mode);

  function goToGroup(index: number) {
    if (index < 0 || index >= visibleGroups.length) return;
    setViewerGroupIndex(index);
    setViewerPhotoIndex(0);
  }

  /** Opens the group-aware viewer (with ‹ Groupe › navigation) at a specific photo. */
  function openGroupViewer(groupIndex: number, photoIndex: number) {
    if (groupIndex < 0 || groupIndex >= visibleGroups.length) return;
    setViewerGroupIndex(groupIndex);
    setViewerPhotoIndex(photoIndex);
  }

  function openFlatViewer(photos: HashedPhoto[], index: number, title: string) {
    setFlatViewer({ photos, index, title });
  }

  function toggleKept(uri: string) {
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) {
        next.delete(uri);
      } else {
        next.add(uri);
      }
      return next;
    });
  }

  function heartAllStars() {
    setKept((prev) => {
      const next = new Set(prev);
      visibleGroups.forEach((g) => next.add(g.photos[0].uri));
      return next;
    });
  }

  function enterKeepMode() {
    setKeepMode(true);
  }

  function exitKeepMode() {
    setKeepMode(false);
    setKept(new Set());
    setHideUnhearted(false);
  }

  // Only groups where at least one photo was hearted are touched - an
  // untouched group means "not decided yet", never "throw it all away".
  function groupHasHeart(group: DuplicateGroup): boolean {
    return group.photos.some((p) => kept.has(p.uri));
  }

  const keptCount = kept.size;
  const wouldTrashCount = visibleGroups.reduce((sum, g) => {
    if (!groupHasHeart(g)) return sum;
    return sum + g.photos.filter((p) => !kept.has(p.uri)).length;
  }, 0);

  function validateKeepSelection() {
    const toTrash: string[] = [];
    visibleGroups.forEach((g) => {
      if (!groupHasHeart(g)) return;
      g.photos.forEach((p) => {
        if (!kept.has(p.uri)) toTrash.push(p.uri);
      });
    });
    onSelectExceptBest(toTrash);
    exitKeepMode();
  }

  // Only computed to help make sense of an empty "duplicates" result: shows
  // how close the nearest two photos actually got, so there's a concrete
  // number to check instead of guessing why a pair wasn't grouped.
  const closestPair = useMemo(
    () => (mode === 'duplicates' && groups.length === 0 ? findClosestPair(allPhotos) : null),
    [mode, groups.length, allPhotos]
  );

  const headerTitle = (() => {
    if (mode === 'final') {
      return `${allPhotos.length} photo${allPhotos.length > 1 ? 's' : ''} dans le dossier`;
    }
    if (mode === 'blurry') {
      return standaloneBlurryPhotos.length === 0
        ? 'Aucune photo floue sans groupe'
        : `${standaloneBlurryPhotos.length} photo${standaloneBlurryPhotos.length > 1 ? 's' : ''} floue${standaloneBlurryPhotos.length > 1 ? 's' : ''} sans groupe`;
    }
    if (groups.length === 0) return 'Aucun doublon trouvé';
    const noun = mode === 'duplicates' ? 'identiques' : 'semblables';
    return `${groups.length} groupe${groups.length > 1 ? 's' : ''} de photos ${noun}`;
  })();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={styles.backLink}>‹ Nouvelle analyse</Text>
          </Pressable>
          {trashCount > 0 && (
            <Pressable onPress={onOpenTrash} hitSlop={12} style={styles.trashLink}>
              <Text style={styles.trashLinkText}>
                🗑 Corbeille ({trashCount})
              </Text>
            </Pressable>
          )}
        </View>
        {currentPartSteps.length > 1 && (
          <View style={styles.stepNav}>
            {/* Only ever the steps within the current part - this never offers
                a jump into the other part's analysis, which used to trigger a
                confusing, silent re-analysis. */}
            {currentPartSteps.map((stepMode) => {
              const active = stepMode === mode;
              return (
                <Pressable
                  key={stepMode}
                  style={[styles.stepNavItem, active && styles.stepNavItemActive]}
                  onPress={() => !active && onSwitchMode(stepMode)}
                >
                  <Text style={[styles.stepNavItemText, active && styles.stepNavItemTextActive]}>
                    {SORT_STEPS[stepMode].shortTitle}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        <Text style={styles.headerTitle}>{headerTitle}</Text>
        {hasGroups && (
          <Text style={styles.closestPairHint}>
            {allPhotos.length} photo{allPhotos.length > 1 ? 's' : ''} analysée
            {allPhotos.length > 1 ? 's' : ''} au total
          </Text>
        )}
        {closestPair && (
          <Text style={styles.closestPairHint}>
            Les 2 photos les plus proches : {closestPair.a.name} et {closestPair.b.name} (
            {thresholdToPercent(closestPair.distance)}% pareilles)
          </Text>
        )}
        {mode !== 'duplicates' && (
          <Text style={styles.closestPairHint}>
            Reconnaissance de visages :{' '}
            {faceModelDiagnostic === null
              ? 'en cours...'
              : faceModelDiagnostic === 'ok'
                ? 'ok'
                : `échec (${faceModelDiagnostic})`}
          </Text>
        )}
        {hasGroups && reviewedCount > 0 && (
          <Pressable onPress={() => setShowReviewed((v) => !v)} hitSlop={8}>
            <Text style={styles.reviewedToggle}>
              {reviewedCount} déjà vu{reviewedCount > 1 ? 's' : ''} ·{' '}
              {showReviewed ? 'masquer' : 'afficher'}
            </Text>
          </Pressable>
        )}
        {trashReminder && (
          <Pressable onPress={onOpenTrash} style={styles.reminderBanner}>
            <Text style={styles.reminderBannerText}>🗑 {trashReminder}</Text>
          </Pressable>
        )}
      </View>

      {mode === 'similar' && (
        <View style={styles.similaritySection}>
          <View style={styles.similarityLabelRow}>
            <Text style={styles.similarityLabel}>Niveau de ressemblance</Text>
            <Text style={styles.similarityPercent}>{sliderPercent}%</Text>
          </View>
          <Slider
            minimumValue={60}
            maximumValue={100}
            step={1}
            value={sliderPercent}
            onValueChange={setSliderPercent}
            onSlidingComplete={(percent) => onChangeSimilarity(percentToThreshold(percent))}
            minimumTrackTintColor={colors.primary}
            maximumTrackTintColor={colors.border}
            thumbTintColor={colors.primary}
          />
          <View style={styles.similarityRow}>
            <Text style={styles.similarityEdgeLabel}>Large</Text>
            <Text style={styles.similarityEdgeLabel}>Identique</Text>
          </View>
          <Text style={styles.similarityDescription}>
            {similarityDescription(similarityThreshold)}
          </Text>
        </View>
      )}

      {mode === 'duplicates' && (
        <View style={styles.similaritySection}>
          <View style={styles.similarityLabelRow}>
            <Text style={styles.similarityLabel}>Niveau de ressemblance</Text>
            <Text style={styles.similarityPercent}>
              {thresholdToPercent(similarityThreshold)}%
            </Text>
          </View>
          <Text style={styles.similarityDescription}>
            {similarityDescription(similarityThreshold)}
          </Text>
        </View>
      )}

      {mode === 'final' ? (
        allPhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Il n'y a plus de photo dans ce dossier.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.instructions}>
              Toutes les photos qui restent dans le dossier analysé (hors corbeille) - les floues
              restent grisées. Touche une photo pour la sélectionner à jeter, ou la loupe pour la
              voir en grand.
            </Text>
            <View style={styles.bulkActionsRow}>
              <Pressable
                style={styles.selectAllButton}
                onPress={() =>
                  onSelectExceptBest(allPhotos.filter(isBlurry).map((p) => p.uri))
                }
              >
                <Text style={styles.selectAllButtonText}>🌫 Toutes les photos floues</Text>
              </Pressable>
              <Pressable style={styles.finishButton} onPress={onFinishSorting}>
                <Text style={styles.finishButtonText}>✅ Terminer le tri</Text>
              </Pressable>
            </View>
            <View style={styles.blurGrid}>
              {allPhotos.map((photo, index) => {
                const isSelected = selected.has(photo.uri);
                const photoIsBlurry = isBlurry(photo);
                return (
                  <Pressable
                    key={photo.uri}
                    style={styles.blurGridItem}
                    onPress={() => onToggleSelect(photo.uri)}
                  >
                    <Image
                      source={{ uri: photo.uri }}
                      style={[
                        styles.thumb,
                        !isSelected && photoIsBlurry && styles.thumbBlurry,
                        isSelected && styles.thumbSelected,
                      ]}
                      contentFit="cover"
                    />
                    {isSelected ? (
                      <View style={styles.trashBadge}>
                        <Text style={styles.trashBadgeText}>🗑</Text>
                      </View>
                    ) : (
                      photoIsBlurry && (
                        <View style={styles.blurBadge}>
                          <Text style={styles.blurBadgeText}>🌫 flou</Text>
                        </View>
                      )
                    )}
                    <Pressable
                      style={styles.magnifyBadge}
                      hitSlop={8}
                      onPress={() => openFlatViewer(allPhotos, index, 'Toutes les photos')}
                    >
                      <Text style={styles.magnifyBadgeText}>🔍</Text>
                    </Pressable>
                    <Text style={styles.thumbSize} numberOfLines={1}>
                      {formatBytes(photo.sizeBytes)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        )
      ) : mode === 'blurry' ? (
        standaloneBlurryPhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Aucune photo floue sans groupe repérée ! 🎉</Text>
            {nextMode && (
              <Pressable
                onPress={() => onSwitchMode(nextMode)}
                hitSlop={8}
                style={styles.reviewAgainLink}
              >
                <Text style={styles.selectAllButtonText}>
                  ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.instructions}>
              Ces photos semblent floues mais n'ont pas de photo semblable à côté pour comparer.
              Touche une photo pour la sélectionner à jeter, ou la loupe pour la voir en grand.
            </Text>
            <View style={styles.bulkActionsRow}>
              <Pressable
                style={styles.selectAllButton}
                onPress={() => onSelectExceptBest(standaloneBlurryPhotos.map((p) => p.uri))}
              >
                <Text style={styles.selectAllButtonText}>🌫 Toutes les sélectionner</Text>
              </Pressable>
              {nextMode && (
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              )}
            </View>
            <View style={styles.blurGrid}>
              {standaloneBlurryPhotos.map((photo, index) => {
                const isSelected = selected.has(photo.uri);
                return (
                  <Pressable
                    key={photo.uri}
                    style={styles.blurGridItem}
                    onPress={() => onToggleSelect(photo.uri)}
                  >
                    <Image
                      source={{ uri: photo.uri }}
                      style={[styles.thumb, styles.thumbBlurry, isSelected && styles.thumbSelected]}
                      contentFit="cover"
                    />
                    {isSelected && (
                      <View style={styles.trashBadge}>
                        <Text style={styles.trashBadgeText}>🗑</Text>
                      </View>
                    )}
                    <Pressable
                      style={styles.magnifyBadge}
                      hitSlop={8}
                      onPress={() => openFlatViewer(standaloneBlurryPhotos, index, 'Photos floues sans groupe')}
                    >
                      <Text style={styles.magnifyBadgeText}>🔍</Text>
                    </Pressable>
                    <Text style={styles.thumbSize} numberOfLines={1}>
                      net. {Math.round(photo.sharpness)} ({photo.facesFound ? 'visage' : 'photo'})
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        )
      ) : mode === 'decide' ? (
        allPhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Il n'y a plus de photo dans ce dossier.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.instructions}>
              Pour chaque photo : ❤️ à garder, 🕐 à revoir plus tard, ou 🗑 à la poubelle. Touche la
              loupe pour voir en grand.
            </Text>
            {nextMode && (
              <View style={styles.bulkActionsRow}>
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              </View>
            )}
            <View style={styles.blurGrid}>
              {allPhotos.map((photo, index) => {
                const status = selected.has(photo.uri) ? 'trash' : laterUris.has(photo.uri) ? 'later' : 'keep';
                const photoIsBlurry = isBlurry(photo);
                return (
                  <View key={photo.uri} style={styles.blurGridItem}>
                    <Image
                      source={{ uri: photo.uri }}
                      style={[
                        styles.thumb,
                        photoIsBlurry && status === 'keep' && styles.thumbBlurry,
                        status === 'trash' && styles.thumbSelected,
                        status === 'later' && styles.thumbLater,
                      ]}
                      contentFit="cover"
                    />
                    {status === 'trash' ? (
                      <View style={styles.trashBadge}>
                        <Text style={styles.trashBadgeText}>🗑</Text>
                      </View>
                    ) : status === 'later' ? (
                      <View style={styles.laterBadge}>
                        <Text style={styles.laterBadgeText}>🕐 plus tard</Text>
                      </View>
                    ) : (
                      photoIsBlurry && (
                        <View style={styles.blurBadge}>
                          <Text style={styles.blurBadgeText}>🌫 flou</Text>
                        </View>
                      )
                    )}
                    <Pressable
                      style={styles.magnifyBadge}
                      hitSlop={8}
                      onPress={() => openFlatViewer(allPhotos, index, 'Garder, plus tard ou poubelle')}
                    >
                      <Text style={styles.magnifyBadgeText}>🔍</Text>
                    </Pressable>
                    <View style={styles.statusRow}>
                      <Pressable
                        style={[styles.statusButton, status === 'keep' && styles.statusButtonActiveKeep]}
                        hitSlop={4}
                        onPress={() => onSetPhotoStatus(photo.uri, 'keep')}
                      >
                        <Text style={styles.statusButtonText}>❤️</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.statusButton, status === 'later' && styles.statusButtonActiveLater]}
                        hitSlop={4}
                        onPress={() => onSetPhotoStatus(photo.uri, 'later')}
                      >
                        <Text style={styles.statusButtonText}>🕐</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.statusButton, status === 'trash' && styles.statusButtonActiveTrash]}
                        hitSlop={4}
                        onPress={() => onSetPhotoStatus(photo.uri, 'trash')}
                      >
                        <Text style={styles.statusButtonText}>🗑</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )
      ) : mode === 'later' ? (
        laterPhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Rien à revoir pour l'instant ! 🎉</Text>
            {nextMode && (
              <Pressable
                onPress={() => onSwitchMode(nextMode)}
                hitSlop={8}
                style={styles.reviewAgainLink}
              >
                <Text style={styles.selectAllButtonText}>
                  ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.instructions}>
              Les photos que tu as mises de côté pour plus tard. Choisis maintenant : ❤️ à garder ou
              🗑 à la poubelle.
            </Text>
            {nextMode && (
              <View style={styles.bulkActionsRow}>
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              </View>
            )}
            <View style={styles.blurGrid}>
              {laterPhotos.map((photo, index) => {
                const isSelected = selected.has(photo.uri);
                const photoIsBlurry = isBlurry(photo);
                return (
                  <View key={photo.uri} style={styles.blurGridItem}>
                    <Image
                      source={{ uri: photo.uri }}
                      style={[
                        styles.thumb,
                        photoIsBlurry && !isSelected && styles.thumbBlurry,
                        isSelected && styles.thumbSelected,
                      ]}
                      contentFit="cover"
                    />
                    {isSelected ? (
                      <View style={styles.trashBadge}>
                        <Text style={styles.trashBadgeText}>🗑</Text>
                      </View>
                    ) : (
                      photoIsBlurry && (
                        <View style={styles.blurBadge}>
                          <Text style={styles.blurBadgeText}>🌫 flou</Text>
                        </View>
                      )
                    )}
                    <Pressable
                      style={styles.magnifyBadge}
                      hitSlop={8}
                      onPress={() => openFlatViewer(laterPhotos, index, 'À revoir plus tard')}
                    >
                      <Text style={styles.magnifyBadgeText}>🔍</Text>
                    </Pressable>
                    <View style={styles.statusRow}>
                      <Pressable
                        style={styles.statusButton}
                        hitSlop={4}
                        onPress={() => onSetPhotoStatus(photo.uri, 'keep')}
                      >
                        <Text style={styles.statusButtonText}>❤️</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.statusButton, isSelected && styles.statusButtonActiveTrash]}
                        hitSlop={4}
                        onPress={() => onSetPhotoStatus(photo.uri, 'trash')}
                      >
                        <Text style={styles.statusButtonText}>🗑</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )
      ) : groups.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Je n'ai pas trouvé de photos qui se ressemblent à ce niveau de ressemblance. Essaie un
            réglage plus large ci-dessus, ou un autre dossier.
          </Text>
          <Text style={styles.debugHint}>
            ({photoCount} photo{photoCount > 1 ? 's' : ''} analysée{photoCount > 1 ? 's' : ''} au
            total)
          </Text>
          {nextMode && (
            <Pressable
              onPress={() => onSwitchMode(nextMode)}
              hitSlop={8}
              style={styles.reviewAgainLink}
            >
              <Text style={styles.selectAllButtonText}>
                ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
              </Text>
            </Pressable>
          )}
        </View>
      ) : visibleGroups.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Tu as déjà tout revu ! 🎉</Text>
          <Pressable onPress={() => setShowReviewed(true)} hitSlop={8} style={styles.reviewAgainLink}>
            <Text style={styles.selectAllButtonText}>Revoir les groupes déjà vus</Text>
          </Pressable>
          {nextMode && (
            <Pressable
              onPress={() => onSwitchMode(nextMode)}
              hitSlop={8}
              style={styles.reviewAgainLink}
            >
              <Text style={styles.selectAllButtonText}>
                ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.instructions}>
            {keepMode
              ? "Touche les photos que tu veux garder : elles reçoivent un cœur. Tout ce qui n'a pas de cœur sera jeté à la validation."
              : "Touche une photo pour la sélectionner à jeter, ou la loupe pour la voir en grand. L'étoile repère la version qui a l'air la meilleure, et « flou » repère celles qui ont l'air floues."}
          </Text>

          <Pressable
            style={styles.modeToggle}
            onPress={() => (keepMode ? exitKeepMode() : enterKeepMode())}
          >
            <Text style={styles.modeToggleText}>
              {keepMode ? '🗑 Revenir au choix des photos à jeter' : '❤️ Choisir plutôt celles à garder'}
            </Text>
          </Pressable>

          {keepMode ? (
            <View style={styles.bulkActionsRow}>
              <Pressable style={styles.selectAllButton} onPress={heartAllStars}>
                <Text style={styles.selectAllButtonText}>❤️ Cœur sur les étoilées</Text>
              </Pressable>
              <Pressable
                style={styles.selectAllButton}
                onPress={() => setHideUnhearted((v) => !v)}
              >
                <Text style={styles.selectAllButtonText}>
                  {hideUnhearted ? '👁 Montrer celles sans cœur' : '🙈 Cacher celles sans cœur'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.bulkActionsRow}>
              <Pressable
                style={styles.selectAllButton}
                onPress={() =>
                  onSelectExceptBest(
                    visibleGroups.flatMap((g) => g.photos.slice(1).map((p) => p.uri))
                  )
                }
              >
                <Text style={styles.selectAllButtonText}>⚡ Sauf la meilleure de chaque groupe</Text>
              </Pressable>
              <Pressable
                style={styles.selectAllButton}
                onPress={() =>
                  onSelectExceptBest(
                    visibleGroups.flatMap((g) => g.photos.filter(isBlurry).map((p) => p.uri))
                  )
                }
              >
                <Text style={styles.selectAllButtonText}>🌫 Toutes les photos floues</Text>
              </Pressable>
              {nextMode && (
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {visibleGroups.map((group, groupIndex) => {
            const isReviewed = reviewedGroupKeys.has(groupKey(group));
            return (
              <View
                key={group.id}
                style={[styles.groupCard, isReviewed && styles.groupCardReviewed]}
              >
                <View style={styles.groupHeaderRow}>
                  <View style={styles.groupLabelColumn}>
                    <Text style={styles.groupLabel}>
                      Groupe {groupIndex + 1} · {group.photos.length} photos semblables
                      {isReviewed ? ' · vu' : ''}
                    </Text>
                    {mode === 'duplicates' &&
                      (groupIsSameFolder(group) ? (
                        <Text style={styles.sameFolderHint}>
                          📁 même dossier - tu peux jeter n'importe laquelle
                        </Text>
                      ) : (
                        <Text style={styles.differentFolderHint}>
                          ⚠️ dossiers différents - vérifie laquelle garder
                        </Text>
                      ))}
                  </View>
                  <View style={styles.groupHeaderLinks}>
                    {!keepMode && (
                      <Pressable
                        hitSlop={8}
                        onPress={() => onSelectExceptBest(group.photos.slice(1).map((p) => p.uri))}
                      >
                        <Text style={styles.groupSelectLink}>Sauf la meilleure</Text>
                      </Pressable>
                    )}
                    <Pressable hitSlop={8} onPress={() => onMarkGroupReviewed(groupKey(group))}>
                      <Text style={styles.groupSelectLink}>✓ Marquer vu</Text>
                    </Pressable>
                  </View>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {(hideUnhearted && groupHasHeart(group)
                    ? group.photos.filter((p) => kept.has(p.uri))
                    : group.photos
                  ).map((photo) => {
                    const photoIndex = group.photos.indexOf(photo);
                    const isSelected = selected.has(photo.uri);
                    const photoIsBlurry = isBlurry(photo);
                    const isHearted = kept.has(photo.uri);
                    return (
                      <Pressable
                        key={photo.uri}
                        style={styles.thumbWrapper}
                        onPress={() => {
                          if (keepMode) {
                            toggleKept(photo.uri);
                          } else {
                            onToggleSelect(photo.uri);
                          }
                        }}
                      >
                        <Image
                          source={{ uri: photo.uri }}
                          style={[
                            styles.thumb,
                            !keepMode && isSelected && styles.thumbSelected,
                            keepMode && !isHearted && styles.thumbUnhearted,
                            !keepMode && !isSelected && photoIsBlurry && styles.thumbBlurry,
                          ]}
                          contentFit="cover"
                        />
                        {photoIndex === 0 && (
                          <View style={styles.bestBadge}>
                            <Text style={styles.bestBadgeText}>★</Text>
                          </View>
                        )}
                        {keepMode ? (
                          isHearted && (
                            <View style={styles.heartBadge}>
                              <Text style={styles.heartBadgeText}>❤️</Text>
                            </View>
                          )
                        ) : isSelected ? (
                          <View style={styles.trashBadge}>
                            <Text style={styles.trashBadgeText}>🗑</Text>
                          </View>
                        ) : (
                          photoIsBlurry && (
                            <View style={styles.blurBadge}>
                              <Text style={styles.blurBadgeText}>🌫 flou</Text>
                            </View>
                          )
                        )}
                        <Pressable
                          style={styles.magnifyBadge}
                          hitSlop={8}
                          onPress={() => openGroupViewer(groupIndex, photoIndex)}
                        >
                          <Text style={styles.magnifyBadgeText}>🔍</Text>
                        </Pressable>
                        <Text style={styles.thumbSize}>
                          {formatBytes(photo.sizeBytes)} · net. {Math.round(photo.sharpness)} (
                          {photo.facesFound ? 'visage' : 'photo'})
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      )}

      {hasGroups && groups.length > 0 && visibleGroups.length > 0 && keepMode && (
        <View style={styles.bottomBar}>
          <Pressable
            style={[styles.deleteButton, keptCount === 0 && styles.deleteButtonDisabled]}
            disabled={keptCount === 0}
            onPress={validateKeepSelection}
          >
            <Text style={styles.deleteButtonText}>
              {keptCount === 0
                ? 'Touche les photos à garder (❤️)'
                : `Valider : garder ${keptCount}, jeter ${wouldTrashCount}`}
            </Text>
          </Pressable>
        </View>
      )}

      {!keepMode &&
        (mode === 'final' || mode === 'decide'
          ? allPhotos.length > 0
          : mode === 'blurry'
            ? standaloneBlurryPhotos.length > 0
            : mode === 'later'
              ? laterPhotos.length > 0
              : groups.length > 0) && (
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
                    ? 'Choisis les photos à jeter'
                    : `Jeter ${selectedCount} photo${selectedCount > 1 ? 's' : ''}`}
                </Text>
              )}
            </Pressable>
          </View>
        )}

      <Modal
        visible={viewerGroup !== null}
        animationType="slide"
        onRequestClose={() => setViewerGroupIndex(null)}
        statusBarTranslucent
      >
        {viewerGroup && viewerGroupIndex !== null && (
          <PhotoViewer
            key={groupKey(viewerGroup)}
            photos={viewerGroup.photos}
            initialIndex={viewerPhotoIndex}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onClose={() => setViewerGroupIndex(null)}
            showGroupControls
            groupLabel={`Groupe ${viewerGroupIndex + 1} / ${visibleGroups.length}`}
            starReason={bestPhotoReason(viewerGroup)}
            blurryUris={blurryUris}
            isGroupReviewed={reviewedGroupKeys.has(groupKey(viewerGroup))}
            onMarkGroupReviewed={() => onMarkGroupReviewed(groupKey(viewerGroup))}
            hasPrevGroup={viewerGroupIndex > 0}
            hasNextGroup={viewerGroupIndex < visibleGroups.length - 1}
            onPrevGroup={() => goToGroup(viewerGroupIndex - 1)}
            onNextGroup={() => goToGroup(viewerGroupIndex + 1)}
          />
        )}
      </Modal>

      <Modal
        visible={flatViewer !== null}
        animationType="slide"
        onRequestClose={() => setFlatViewer(null)}
        statusBarTranslucent
      >
        {flatViewer && (
          <PhotoViewer
            key={flatViewer.photos[flatViewer.index]?.uri}
            photos={flatViewer.photos}
            initialIndex={flatViewer.index}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onClose={() => setFlatViewer(null)}
            showGroupControls={false}
            groupLabel={flatViewer.title}
            starReason=""
            blurryUris={blurryUris}
            isGroupReviewed={false}
            onMarkGroupReviewed={() => {}}
            hasPrevGroup={false}
            hasNextGroup={false}
            onPrevGroup={() => {}}
            onNextGroup={() => {}}
          />
        )}
      </Modal>
    </View>
  );
}

const THUMB_SIZE = 150;

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
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  backLink: {
    color: colors.primary,
    fontSize: 15,
  },
  trashLink: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: colors.dangerBackground,
  },
  trashLinkText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  stepNav: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  stepNavItem: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    marginRight: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepNavItemActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stepNavItemText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.subtleText,
  },
  stepNavItemTextActive: {
    color: colors.primaryText,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  reviewedToggle: {
    marginTop: 6,
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  closestPairHint: {
    marginTop: 6,
    fontSize: 13,
    color: colors.subtleText,
  },
  reminderBanner: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.dangerBackground,
  },
  reminderBannerText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  similaritySection: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  similarityLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  similarityLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.subtleText,
  },
  similarityPercent: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  similarityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  similarityEdgeLabel: {
    fontSize: 11,
    color: colors.subtleText,
  },
  similarityDescription: {
    fontSize: 13,
    color: colors.subtleText,
    lineHeight: 18,
    marginTop: 6,
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
  reviewAgainLink: {
    marginTop: 16,
    alignSelf: 'center',
  },
  debugHint: {
    marginTop: 10,
    fontSize: 12,
    color: colors.subtleText,
    textAlign: 'center',
  },
  list: {
    padding: 20,
    paddingBottom: 100,
  },
  instructions: {
    fontSize: 14,
    color: colors.subtleText,
    marginBottom: 12,
    lineHeight: 20,
  },
  modeToggle: {
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  modeToggleText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  bulkActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  selectAllButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    marginRight: 8,
    marginBottom: 8,
  },
  selectAllButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  finishButton: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: colors.success,
    marginBottom: 8,
  },
  finishButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  groupCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupCardReviewed: {
    opacity: 0.6,
  },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  groupLabelColumn: {
    flexShrink: 1,
    marginRight: 8,
  },
  groupLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  sameFolderHint: {
    fontSize: 12,
    color: colors.success,
    marginTop: 2,
  },
  differentFolderHint: {
    fontSize: 12,
    color: colors.danger,
    marginTop: 2,
    fontWeight: '600',
  },
  groupHeaderLinks: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupSelectLink: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
    marginLeft: 12,
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
    opacity: 0.5,
  },
  thumbUnhearted: {
    opacity: 0.35,
  },
  thumbBlurry: {
    borderWidth: 3,
    borderColor: 'rgba(107,107,123,0.9)',
  },
  thumbLater: {
    opacity: 0.6,
  },
  blurGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  blurGridItem: {
    width: THUMB_SIZE,
    marginRight: 10,
    marginBottom: 16,
    alignItems: 'center',
  },
  magnifyBadge: {
    position: 'absolute',
    bottom: 30,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  magnifyBadgeText: {
    fontSize: 14,
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
  trashBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trashBadgeText: {
    fontSize: 14,
  },
  heartBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartBadgeText: {
    fontSize: 15,
  },
  blurBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(107,107,123,0.85)',
  },
  blurBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  thumbSize: {
    marginTop: 6,
    fontSize: 12,
    color: colors.subtleText,
  },
  laterBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: colors.badge,
  },
  laterBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  statusButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusButtonActiveKeep: {
    borderColor: colors.success,
    backgroundColor: '#E7F7EE',
  },
  statusButtonActiveLater: {
    borderColor: colors.badge,
    backgroundColor: '#FFF4E0',
  },
  statusButtonActiveTrash: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerBackground,
  },
  statusButtonText: {
    fontSize: 15,
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
