import Slider from '@react-native-community/slider';
import { Image } from 'expo-image';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import FolderDestinationModal from '../components/FolderDestinationModal';
import PhotoViewer from '../components/PhotoViewer';
import {
  bestPhotoReason,
  clusterBySimilarity,
  colorMinForPercent,
  DEFAULT_MOMENT_SIMILARITY_PERCENT,
  computeSharpnessBaseline,
  findClosestPair,
  groupHasLargeSizeDifference,
  groupIsSameFolder,
  groupKey,
  isLowQualitySize,
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
  /** Photos explicitly marked ❤️ "garder" - deliberately separate from "untouched", see status() below. */
  keptUris: Set<string>;
  onSetPhotoStatus: (uri: string, status: 'keep' | 'later' | 'trash' | 'undecided') => void;
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
  /** Jette an explicit list of photos (with its own confirmation), regardless of `selected`. */
  onDeleteUris: (uris: string[]) => void;
  onBack: () => void;
  onOpenTrash: () => void;
  onSwitchMode: (mode: SortMode) => void;
  onFinishSorting: () => void;
  /** Debug: why face detection did or didn't come up during the last scan. */
  faceModelDiagnostic: string | null;
  /** "moments" only: moves one or more photos into another moment group, or 'new' for a fresh group together. */
  onMoveMomentPhotos: (photoUris: string[], targetGroupId: string | 'new') => void;
  /** "moments" only: nudges a group up or down in the list. */
  onMoveMomentGroup: (groupId: string, direction: 'up' | 'down') => void;
  /** "moments": puts a photo right before another one in its moment (null = at the end). */
  onReorderMomentPhoto: (groupId: string, photoUri: string, beforeUri: string | null) => void;
  /** "moments": puts a moment right after another (or at the start / end) in one step. */
  onMoveMomentGroupTo: (groupId: string, afterGroupId: string | 'start' | 'end') => void;
  /** "moments": puts similar photos side by side in one moment (or 'all'), sorted or split into several moments. */
  onRegroupBySimilarity: (scope: string | 'all', percent: number, how: 'sort' | 'split') => void;
  /** ♥ favorites, also pre-selected for the album. */
  favoriteUris: Set<string>;
  onToggleFavorite: (uri: string) => void;
  /**
   * "album" only: the moments grouping (if any was ever computed this
   * session), used purely to order the album grid the same way - so a
   * moment's photos stay together and in sequence, without needing the
   * horizontal-scroll grouped view "moments" itself uses.
   */
  momentGroups: DuplicateGroup[];
  /** "album"/"quality" only: photos picked to copy into a new folder. */
  albumUris: Set<string>;
  onToggleAlbum: (uri: string) => void;
  albumExporting: boolean;
  albumExportProgress: { current: number; total: number } | null;
  onCreateAlbum: (name: string) => void;
  onCopyToExistingFolder: () => void;
  /**
   * Secondary "déplacer"/"copier vers un dossier" actions, reachable from
   * any step via the "⋯" menu - e.g. for a photo that turns out to be
   * sitting in the wrong sub-folder. Share one selection set (only one of
   * the two is ever in progress at a time) - independent of every other
   * selection concept.
   */
  secondaryActionUris: Set<string>;
  onToggleSecondaryAction: (uri: string) => void;
  secondaryActionRunning: boolean;
  secondaryActionProgress: { current: number; total: number } | null;
  onMoveToNewFolder: (name: string) => void;
  onMoveToExistingFolder: () => void;
  onCopySelectedToNewFolder: (name: string) => void;
  onCopySelectedToExistingFolder: () => void;
  /** Replaces the whole secondary-action selection at once - for "moments"'s quick move/copy from photos already checked there. */
  onSeedSecondaryAction: (uris: string[]) => void;
};

/** Last folder of a path like "Pictures/Vacances/Plage" -> "Plage", short enough to show under a thumbnail. */
function shortFolderName(folderPath: string): string {
  const parts = folderPath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '(dossier racine)';
}

function GroupPill({
  label,
  onPress,
  disabled,
  active,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      hitSlop={4}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.groupPill,
        active && styles.groupPillActive,
        disabled && styles.groupPillDisabled,
      ]}
    >
      <Text style={[styles.groupPillText, active && styles.groupPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

type FlatViewer = { photos: HashedPhoto[]; index: number; title: string };

export default function ResultsScreen({
  mode,
  photoCount,
  allPhotos,
  groups,
  selected,
  laterUris,
  keptUris,
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
  onDeleteUris,
  onBack,
  onOpenTrash,
  onSwitchMode,
  onFinishSorting,
  faceModelDiagnostic,
  onMoveMomentPhotos,
  onMoveMomentGroup,
  onReorderMomentPhoto,
  onMoveMomentGroupTo,
  onRegroupBySimilarity,
  favoriteUris,
  onToggleFavorite,
  momentGroups,
  albumUris,
  onToggleAlbum,
  albumExporting,
  albumExportProgress,
  onCreateAlbum,
  onCopyToExistingFolder,
  secondaryActionUris,
  onToggleSecondaryAction,
  secondaryActionRunning,
  secondaryActionProgress,
  onMoveToNewFolder,
  onMoveToExistingFolder,
  onCopySelectedToNewFolder,
  onCopySelectedToExistingFolder,
  onSeedSecondaryAction,
}: Props) {
  const [viewerGroupIndex, setViewerGroupIndex] = useState<number | null>(null);
  const [viewerPhotoIndex, setViewerPhotoIndex] = useState(0);
  const [flatViewer, setFlatViewer] = useState<FlatViewer | null>(null);
  // "album"/"quality": whether the grid is filtered down to just the
  // current selection, and the destination-choice modal for the copy.
  const [showOnlyAlbum, setShowOnlyAlbum] = useState(false);
  const [albumFolderModalOpen, setAlbumFolderModalOpen] = useState(false);
  // Secondary "déplacer"/"copier vers un dossier" actions, available from
  // any step - reached either via the "⋯" menu's own dedicated selection
  // screen (showSecondaryScreen), or, from "moments", straight from photos
  // already checked there (see the move-picker modal below) - Flavie found
  // having to re-pick photos on a separate screen painful when she'd just
  // spotted misplaced ones while already looking at a moment. secondaryMode
  // alone (not showSecondaryScreen) decides the wording/handlers either way.
  const [secondaryMenuOpen, setSecondaryMenuOpen] = useState(false);
  const [secondaryMode, setSecondaryMode] = useState<'move' | 'copy' | null>(null);
  const [showSecondaryScreen, setShowSecondaryScreen] = useState(false);
  const [secondaryFolderModalOpen, setSecondaryFolderModalOpen] = useState(false);
  // "moments" hand-editing: photos picked to move together, and whether
  // the "choose a group" picker is currently open for them.
  const [moveSelection, setMoveSelection] = useState<Set<string>>(new Set());
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  // "moments": quick reorder of one moment's photos (tap the photo to move,
  // then the one it should go in front of), the "place this moment..."
  // picker, and the similarity-grouping dialog (one moment, or 'all').
  const [reorderGroupId, setReorderGroupId] = useState<string | null>(null);
  const [reorderPickedUri, setReorderPickedUri] = useState<string | null>(null);
  const [placeGroupId, setPlaceGroupId] = useState<string | null>(null);
  const [similarityScope, setSimilarityScope] = useState<string | null>(null);
  const [similarityPercent, setSimilarityPercent] = useState(DEFAULT_MOMENT_SIMILARITY_PERCENT);

  function handleReorderTap(groupId: string, uri: string) {
    if (!reorderPickedUri) {
      setReorderPickedUri(uri);
    } else if (reorderPickedUri === uri) {
      setReorderPickedUri(null);
    } else {
      onReorderMomentPhoto(groupId, reorderPickedUri, uri);
      setReorderPickedUri(null);
    }
  }

  function toggleMoveSelection(uri: string) {
    setMoveSelection((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }
  // "moments": a single "jeter" count covering both ways a photo can end up
  // marked for the trash there - ❤️/🕐/🗑-marked (full-screen or the status
  // row) and ticked in the grid (otherwise used to move between moments) -
  // so there's only ever one "Jeter N" button, not two overlapping ones.
  const trashCandidateUris = useMemo(
    () => new Set([...selected, ...moveSelection]),
    [selected, moveSelection]
  );
  const [showReviewed, setShowReviewed] = useState(false);
  // "decide"/"moments": photos explicitly marked ❤️ hide themselves (like a
  // reviewed group does) so the screen only ever shows what's left to
  // decide - this brings them back.
  const [showKeptPhotos, setShowKeptPhotos] = useState(false);
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
  const hasGroups = mode === 'duplicates' || mode === 'similar' || mode === 'moments';
  // "album" is reachable from both "sorting" and "moments", so it has no
  // fixed step list of its own (see partSteps) - once actually on it,
  // showing whichever flow's steps got it here (guessed from whether a
  // moments grouping exists this session) lets Flavie jump back to any of
  // them, instead of "album" being a dead end with no way back except
  // "Nouvelle analyse".
  const currentPartSteps =
    mode === 'album'
      ? momentGroups.length > 0
        ? partSteps('moments')
        : partSteps('final')
      : partSteps(mode);

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
  // Every photo's position in the moments classification, e.g. for laying
  // out "album"/"À revoir plus tard" (moments part) in that same order
  // instead of whatever order the scan happened to produce - so a moment's
  // photos stay together and in sequence there too, the way "Tri par
  // moments" itself already shows them. Empty (so ordering is a no-op) when
  // no moments grouping exists this session (e.g. "album" reached from
  // "similar" instead).
  const momentOrderIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    momentGroups.forEach((g) => g.photos.forEach((p) => map.set(p.uri, i++)));
    return map;
  }, [momentGroups]);
  function sortByMomentOrder(photos: HashedPhoto[]): HashedPhoto[] {
    if (momentOrderIndex.size === 0) return photos;
    // Anything not part of a moment (e.g. added/rescanned since) sorts after everything that is.
    return [...photos].sort(
      (a, b) =>
        (momentOrderIndex.get(a.uri) ?? Infinity) - (momentOrderIndex.get(b.uri) ?? Infinity)
    );
  }
  const laterPhotos = useMemo(() => {
    const base = allPhotos.filter((p) => laterUris.has(p.uri));
    return mode === 'momentsLater' ? sortByMomentOrder(base) : base;
  }, [allPhotos, laterUris, mode, momentOrderIndex]);
  // "decide": ❤️-marked photos hide themselves once decided, same as a
  // reviewed group - only what's left undecided (or later/trash-marked)
  // stays on screen by default.
  const decideKeptCount = useMemo(
    () => allPhotos.filter((p) => keptUris.has(p.uri)).length,
    [allPhotos, keptUris]
  );
  const decideVisiblePhotos = useMemo(
    () => (showKeptPhotos ? allPhotos : allPhotos.filter((p) => !keptUris.has(p.uri))),
    [allPhotos, keptUris, showKeptPhotos]
  );
  // "moments": same idea, counted across every group's photos.
  const momentsKeptCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.photos.filter((p) => keptUris.has(p.uri)).length, 0),
    [groups, keptUris]
  );
  const albumGridPhotos = useMemo(() => {
    const base = mode === 'album' ? sortByMomentOrder(allPhotos) : allPhotos;
    return showOnlyAlbum ? base.filter((p) => albumUris.has(p.uri)) : base;
  }, [allPhotos, mode, momentOrderIndex, albumUris, showOnlyAlbum]);
  // "déplacer"/"copier vers un dossier": every photo still in this
  // analysis, regardless of which step it's normally organized under -
  // moment order when one exists, same as the album.
  const secondaryModePhotos = useMemo(() => sortByMomentOrder(allPhotos), [allPhotos, momentOrderIndex]);

  function isBlurry(photo: HashedPhoto): boolean {
    return isBlurryPhoto(photo, groupByUri.get(photo.uri) ?? null, sharpnessBaseline);
  }

  type PhotoStatus = 'keep' | 'later' | 'trash' | 'undecided';

  /**
   * "keep" only ever comes from an explicit ❤️ tap (see keptUris) - a photo
   * nobody has touched yet is "undecided", not "keep". They used to be the
   * same thing, which made the ❤️ button look pre-activated on every
   * untouched photo (confirmed confusing by Flavie).
   */
  function photoStatus(uri: string): PhotoStatus {
    if (selected.has(uri)) return 'trash';
    if (laterUris.has(uri)) return 'later';
    if (keptUris.has(uri)) return 'keep';
    return 'undecided';
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

  // "moments" on a big folder (Flavie: 800+ photos, 100+ moments) was
  // unusable to scroll - a plain ScrollView + .map() mounts every single
  // group's photos at once, hundreds of Image views deep, right away. A
  // FlatList (see the "moments" render branch) only ever mounts the groups
  // near the visible area, so this precomputes each group's already-visible
  // photos once per data change instead of redoing that filter on every
  // scroll-driven re-render.
  const momentsRenderData = useMemo(() => {
    if (mode !== 'moments') return [];
    return visibleGroups
      .map((group, groupIndex) => ({
        group,
        groupIndex,
        visiblePhotos: showKeptPhotos ? group.photos : group.photos.filter((p) => !keptUris.has(p.uri)),
      }))
      .filter((entry) => entry.visiblePhotos.length > 0);
  }, [mode, visibleGroups, showKeptPhotos, keptUris]);

  // Reordering moments (⤒ Début, 📍 Placer, ▲▼...) made the list flicker
  // between neighbouring moments, until the app was restarted: the list
  // remembers each row's measured position by its key, and after a reorder
  // those remembered positions belong to the wrong rows, so which rows it
  // thinks should be on screen keeps flipping. A new `key` (only when the
  // relative order of the moments actually changed - not for marking one
  // "vu", which just hides a row) makes it start from clean measurements;
  // it then jumps back to where she was, or to the top when the first
  // moment changed (e.g. she sent one to the start).
  const momentsListRef = useRef<FlatList<(typeof momentsRenderData)[number]>>(null);
  const momentsScrollOffset = useRef(0);
  const momentsPendingScroll = useRef<{ target: number; until: number } | null>(null);
  const momentsOrderRef = useRef<{ ids: string[]; listKey: number }>({ ids: [], listKey: 0 });
  const momentsListKey = useMemo(() => {
    const ids = momentsRenderData.map((entry) => entry.group.id);
    const previous = momentsOrderRef.current;
    const idSet = new Set(ids);
    const previousSet = new Set(previous.ids);
    const commonNow = ids.filter((id) => previousSet.has(id)).join('|');
    const commonBefore = previous.ids.filter((id) => idSet.has(id)).join('|');
    let listKey = previous.listKey;
    if (previous.ids.length > 0 && commonNow !== commonBefore) {
      listKey += 1;
      momentsPendingScroll.current = {
        target: ids[0] !== previous.ids[0] ? 0 : momentsScrollOffset.current,
        until: Date.now() + 1500,
      };
    }
    momentsOrderRef.current = { ids, listKey };
    return listKey;
  }, [momentsRenderData]);

  // Live preview for the "Ressemblance" dialog: which sets of similar photos
  // the current slider position would put together - recomputed as the
  // slider moves, so what it changes is visible before validating.
  const similarityPreview = useMemo(() => {
    if (similarityScope === null) return null;
    const threshold = percentToThreshold(similarityPercent);
    const colorMin = colorMinForPercent(similarityPercent);
    const sets: HashedPhoto[][] = [];
    for (const g of groups) {
      if (similarityScope !== 'all' && g.id !== similarityScope) continue;
      for (const cluster of clusterBySimilarity(g.photos, threshold, colorMin)) {
        if (cluster.length >= 2) sets.push(cluster);
      }
    }
    return { sets, photoCount: sets.reduce((n, c) => n + c.length, 0) };
  }, [similarityScope, similarityPercent, groups]);

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
    if (mode === 'final' || mode === 'momentsFinal') {
      return `${allPhotos.length} photo${allPhotos.length > 1 ? 's' : ''} dans le dossier`;
    }
    if (mode === 'blurry') {
      return standaloneBlurryPhotos.length === 0
        ? 'Aucune photo floue sans groupe'
        : `${standaloneBlurryPhotos.length} photo${standaloneBlurryPhotos.length > 1 ? 's' : ''} floue${standaloneBlurryPhotos.length > 1 ? 's' : ''} sans groupe`;
    }
    if (mode === 'decide') {
      return `${allPhotos.length} photo${allPhotos.length > 1 ? 's' : ''} à trier`;
    }
    if (mode === 'later' || mode === 'momentsLater') {
      return laterPhotos.length === 0
        ? 'Rien à revoir pour l’instant'
        : `${laterPhotos.length} photo${laterPhotos.length > 1 ? 's' : ''} à revoir`;
    }
    if (mode === 'moments') {
      return groups.length === 0
        ? 'Aucune photo'
        : `${groups.length} moment${groups.length > 1 ? 's' : ''}`;
    }
    if (mode === 'album' || mode === 'quality') {
      return allPhotos.length === 0
        ? 'Aucune photo'
        : `${allPhotos.length} photo${allPhotos.length > 1 ? 's' : ''}${albumUris.size > 0 ? ` · ${albumUris.size} sélectionnée${albumUris.size > 1 ? 's' : ''}` : ''}`;
    }
    if (groups.length === 0) return 'Aucun doublon trouvé';
    const noun = 'semblables';
    return `${groups.length} groupe${groups.length > 1 ? 's' : ''} de photos ${noun}`;
  })();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={styles.backLink}>‹ Nouvelle analyse</Text>
          </Pressable>
          <View style={styles.headerTopRowRight}>
            {trashCount > 0 && (
              <Pressable onPress={onOpenTrash} hitSlop={12} style={styles.trashLink}>
                <Text style={styles.trashLinkText}>
                  🗑 Corbeille ({trashCount})
                </Text>
              </Pressable>
            )}
            {!showSecondaryScreen && (
              <Pressable onPress={() => setSecondaryMenuOpen(true)} hitSlop={12} style={styles.moreButton}>
                <Text style={styles.moreButtonText}>⋯</Text>
              </Pressable>
            )}
          </View>
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

      {showSecondaryScreen && (
        <>
          {allPhotos.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Il n'y a plus de photo dans ce dossier.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.list}>
              <Text style={styles.instructions}>
                {secondaryMode === 'move'
                  ? "Touche les photos à déplacer vers un autre dossier - pratique si tu remarques que certaines sont mal placées."
                  : 'Touche les photos à copier vers un autre dossier.'}{' '}
                Touche la loupe pour voir en grand.
              </Text>
              <View style={styles.bulkActionsRow}>
                <Pressable
                  style={styles.selectAllButton}
                  onPress={() => {
                    setShowSecondaryScreen(false);
                    setSecondaryMode(null);
                  }}
                >
                  <Text style={styles.selectAllButtonText}>✕ Annuler</Text>
                </Pressable>
              </View>
              <View style={styles.blurGrid}>
                {secondaryModePhotos.map((photo, index) => {
                  const isMarked = secondaryActionUris.has(photo.uri);
                  return (
                    <Pressable
                      key={photo.uri}
                      style={styles.blurGridItem}
                      onPress={() => onToggleSecondaryAction(photo.uri)}
                    >
                      <Image
                        source={{ uri: photo.uri }}
                        recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
                        style={[
                          styles.thumb,
                          styles.thumbWithBorderSlot,
                          isMarked && styles.thumbAlbumSelected,
                        ]}
                        contentFit="cover"
                      />
                      {isMarked && (
                        <View style={styles.albumBadge}>
                          <Text style={styles.albumBadgeText}>
                            {secondaryMode === 'move' ? '📦' : '📄'}
                          </Text>
                        </View>
                      )}
                      <Pressable
                        style={styles.magnifyBadge}
                        hitSlop={8}
                        onPress={() =>
                          openFlatViewer(
                            secondaryModePhotos,
                            index,
                            secondaryMode === 'move' ? 'Déplacer vers un dossier' : 'Copier vers un dossier'
                          )
                        }
                      >
                        <Text style={styles.magnifyBadgeText}>🔍</Text>
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )}
          {allPhotos.length > 0 && (
            <View style={styles.bottomBar}>
              {secondaryActionRunning ? (
                <View style={styles.progressBlock}>
                  <Text style={styles.progressText}>
                    {secondaryMode === 'move' ? 'Déplacement' : 'Copie'} en cours…{' '}
                    {secondaryActionProgress?.current ?? 0} / {secondaryActionProgress?.total ?? 0}
                  </Text>
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${Math.round(
                            ((secondaryActionProgress?.current ?? 0) /
                              Math.max(secondaryActionProgress?.total ?? 1, 1)) *
                              100
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              ) : (
                <Pressable
                  style={[
                    styles.deleteButton,
                    styles.albumCreateButton,
                    secondaryActionUris.size === 0 && styles.deleteButtonDisabled,
                  ]}
                  disabled={secondaryActionUris.size === 0}
                  onPress={() => setSecondaryFolderModalOpen(true)}
                >
                  <Text style={styles.deleteButtonText}>
                    {secondaryActionUris.size === 0
                      ? 'Touche des photos pour les choisir'
                      : `${secondaryMode === 'move' ? '📦 Déplacer' : '📄 Copier'} ${secondaryActionUris.size} photo${secondaryActionUris.size > 1 ? 's' : ''} vers un dossier`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}

      {!showSecondaryScreen && (
        <>
      {(mode === 'similar' || mode === 'duplicates') && (
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

      {mode === 'final' || mode === 'momentsFinal' ? (
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
              {nextMode && (
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              )}
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
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
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
                    {mode === 'momentsFinal' && (
                      <Pressable
                        style={styles.favHeart}
                        hitSlop={6}
                        onPress={() => onToggleFavorite(photo.uri)}
                      >
                        <Text
                          style={[
                            styles.favHeartText,
                            favoriteUris.has(photo.uri) && styles.favHeartTextOn,
                          ]}
                        >
                          {favoriteUris.has(photo.uri) ? '♥' : '♡'}
                        </Text>
                      </Pressable>
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
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
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
        ) : decideVisiblePhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Tu as décidé pour toutes les photos ! 🎉</Text>
            {decideKeptCount > 0 && (
              <Pressable
                onPress={() => setShowKeptPhotos(true)}
                hitSlop={8}
                style={styles.reviewAgainLink}
              >
                <Text style={styles.selectAllButtonText}>Revoir les gardées</Text>
              </Pressable>
            )}
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
              Pour chaque photo : ❤️ à garder, 🕐 à revoir plus tard, ou 🗑 à la poubelle. Une photo
              gardée disparaît de la liste, comme un groupe marqué vu. Touche la loupe pour voir en
              grand.
            </Text>
            <View style={styles.bulkActionsRow}>
              {decideKeptCount > 0 && (
                <Pressable
                  style={styles.selectAllButton}
                  onPress={() => setShowKeptPhotos((v) => !v)}
                >
                  <Text style={styles.selectAllButtonText}>
                    {decideKeptCount} gardée{decideKeptCount > 1 ? 's' : ''} ·{' '}
                    {showKeptPhotos ? 'masquer' : 'afficher'}
                  </Text>
                </Pressable>
              )}
              {nextMode && (
                <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                  <Text style={styles.selectAllButtonText}>
                    ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                  </Text>
                </Pressable>
              )}
            </View>
            <View style={styles.blurGrid}>
              {decideVisiblePhotos.map((photo, index) => {
                const status = photoStatus(photo.uri);
                const photoIsBlurry = isBlurry(photo);
                return (
                  <View key={photo.uri} style={styles.blurGridItem}>
                    <Image
                      source={{ uri: photo.uri }}
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
                      style={[
                        styles.thumb,
                        photoIsBlurry &&
                          status !== 'trash' &&
                          status !== 'later' &&
                          styles.thumbBlurry,
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
                      onPress={() =>
                        openFlatViewer(decideVisiblePhotos, index, 'Garder, plus tard ou poubelle')
                      }
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
      ) : mode === 'later' || mode === 'momentsLater' ? (
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
              Les photos que tu as mises de côté pour plus tard. Choisis maintenant : ✅ à garder ou
              🗑 à la poubelle (♡ pour la mettre en favori).
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
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
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
                      style={styles.favHeart}
                      hitSlop={6}
                      onPress={() => onToggleFavorite(photo.uri)}
                    >
                      <Text
                        style={[
                          styles.favHeartText,
                          favoriteUris.has(photo.uri) && styles.favHeartTextOn,
                        ]}
                      >
                        {favoriteUris.has(photo.uri) ? '♥' : '♡'}
                      </Text>
                    </Pressable>
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
                        <Text style={styles.statusButtonText}>✅</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.statusButton, isSelected && styles.statusButtonActiveTrash]}
                        hitSlop={4}
                        // Back to "plus tard" (not "undecided", which would
                        // drop it out of this very list) when un-trashing.
                        onPress={() => onSetPhotoStatus(photo.uri, isSelected ? 'later' : 'trash')}
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
      ) : mode === 'moments' ? (
        groups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Il n'y a plus de photo dans ce dossier.</Text>
          </View>
        ) : !showKeptPhotos && groups.every((g) => g.photos.every((p) => keptUris.has(p.uri))) ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Tu as gardé toutes les photos ! 🎉</Text>
            <Pressable
              onPress={() => setShowKeptPhotos(true)}
              hitSlop={8}
              style={styles.reviewAgainLink}
            >
              <Text style={styles.selectAllButtonText}>Revoir les gardées</Text>
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
          <FlatList
            key={momentsListKey}
            ref={momentsListRef}
            data={momentsRenderData}
            keyExtractor={(entry) => entry.group.id}
            removeClippedSubviews={false}
            scrollEventThrottle={64}
            onScroll={(event) => {
              momentsScrollOffset.current = event.nativeEvent.contentOffset.y;
              const pending = momentsPendingScroll.current;
              if (pending && Math.abs(momentsScrollOffset.current - pending.target) < 2) {
                momentsPendingScroll.current = null;
              }
            }}
            onContentSizeChange={() => {
              const pending = momentsPendingScroll.current;
              if (!pending) return;
              if (Date.now() > pending.until) {
                momentsPendingScroll.current = null;
                return;
              }
              momentsListRef.current?.scrollToOffset({ offset: pending.target, animated: false });
            }}
            contentContainerStyle={styles.list}
            // Big folders (Flavie: 800+ photos, 100+ moments) made scrolling
            // unusable with every group mounted at once - only render what's
            // near the visible area, and a bit less eagerly than the default
            // since each group is itself a whole row of photos.
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={5}
            extraData={[
              selected,
              laterUris,
              keptUris,
              favoriteUris,
              moveSelection,
              reviewedGroupKeys,
              reorderGroupId,
              reorderPickedUri,
              showKeptPhotos,
            ]}
            ListHeaderComponent={
              <>
                <Text style={styles.instructions}>
                  Les photos sont regroupées par moment (quand elles ont été prises), celles sans
                  date en premier. Pour chaque photo : ✅ garder, 🕐 plus tard ou 🗑 jeter (retouche
                  le bouton pour annuler), et ♡ pour la mettre en favori (elle sera déjà cochée pour
                  l'album). « ≋ Ressemblance » range côte à côte les photos qui se ressemblent, « ⇅
                  Ordre » change l'ordre des photos d'un moment, « 📍 Placer » déplace un moment
                  d'un coup. Coche des photos (le rond en haut à gauche) pour les déplacer vers un
                  autre moment ou un autre dossier.
                </Text>
                <View style={styles.bulkActionsRow}>
                  <Pressable
                    style={styles.selectAllButton}
                    onPress={() => setSimilarityScope('all')}
                  >
                    <Text style={styles.selectAllButtonText}>
                      ≋ Rapprocher les similaires (tous les moments)
                    </Text>
                  </Pressable>
                  {momentsKeptCount > 0 && (
                    <Pressable
                      style={styles.selectAllButton}
                      onPress={() => setShowKeptPhotos((v) => !v)}
                    >
                      <Text style={styles.selectAllButtonText}>
                        {momentsKeptCount} gardée{momentsKeptCount > 1 ? 's' : ''} ·{' '}
                        {showKeptPhotos ? 'masquer' : 'afficher'}
                      </Text>
                    </Pressable>
                  )}
                  {nextMode && (
                    <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                      <Text style={styles.selectAllButtonText}>
                        ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </>
            }
            renderItem={({ item }) => {
              const { group, groupIndex, visiblePhotos } = item;
              const allChecked = visiblePhotos.every((p) => moveSelection.has(p.uri));
              const isReviewed = reviewedGroupKeys.has(groupKey(group));
              const inReorder = reorderGroupId === group.id;
              return (
                <View style={[styles.groupCard, isReviewed && styles.groupCardReviewed]}>
                  <Text style={styles.groupLabel}>
                    Moment {groupIndex + 1} · {group.photos.length} photo
                    {group.photos.length > 1 ? 's' : ''}
                    {isReviewed ? ' · vu' : ''}
                  </Text>
                  <View style={styles.groupActionsRow}>
                    <GroupPill
                      label="▲"
                      disabled={groupIndex === 0}
                      onPress={() => onMoveMomentGroup(group.id, 'up')}
                    />
                    <GroupPill
                      label="▼"
                      disabled={groupIndex === visibleGroups.length - 1}
                      onPress={() => onMoveMomentGroup(group.id, 'down')}
                    />
                    <GroupPill
                      label="⤒ Début"
                      disabled={groupIndex === 0}
                      onPress={() => onMoveMomentGroupTo(group.id, 'start')}
                    />
                    <GroupPill
                      label="⤓ Fin"
                      disabled={groupIndex === visibleGroups.length - 1}
                      onPress={() => onMoveMomentGroupTo(group.id, 'end')}
                    />
                    <GroupPill label="📍 Placer…" onPress={() => setPlaceGroupId(group.id)} />
                    <GroupPill
                      label={allChecked ? '☑ Tout décocher' : '☐ Tout cocher'}
                      onPress={() =>
                        setMoveSelection((prev) => {
                          const next = new Set(prev);
                          visiblePhotos.forEach((p) => {
                            if (allChecked) next.delete(p.uri);
                            else next.add(p.uri);
                          });
                          return next;
                        })
                      }
                    />
                    <GroupPill label="≋ Ressemblance" onPress={() => setSimilarityScope(group.id)} />
                    <GroupPill
                      label="⇅ Ordre"
                      active={inReorder}
                      onPress={() => {
                        setReorderPickedUri(null);
                        setReorderGroupId(inReorder ? null : group.id);
                      }}
                    />
                    <GroupPill
                      label={isReviewed ? '✓ Vu' : '✓ Marquer vu'}
                      onPress={() => onMarkGroupReviewed(groupKey(group))}
                    />
                  </View>
                  {inReorder && (
                    <Text style={styles.reorderHint}>
                      {reorderPickedUri
                        ? 'Touche la photo devant laquelle la placer (ou « à la fin »). Retouche la même pour annuler.'
                        : 'Touche la photo à déplacer.'}
                    </Text>
                  )}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {visiblePhotos.map((photo) => {
                      const photoIndex = group.photos.indexOf(photo);
                      const status = photoStatus(photo.uri);
                      const photoIsBlurry = isBlurry(photo);
                      const isChecked = moveSelection.has(photo.uri);
                      const isFavorite = favoriteUris.has(photo.uri);
                      const isPicked = inReorder && reorderPickedUri === photo.uri;
                      return (
                        <View key={photo.uri} style={styles.thumbWrapper}>
                          <Image
                            source={{ uri: photo.uri }}
                            recyclingKey={photo.uri}
                            cachePolicy="memory-disk"
                            style={[
                              styles.thumb,
                              styles.thumbWithBorderSlot,
                              photoIsBlurry &&
                                status !== 'trash' &&
                                status !== 'later' &&
                                styles.thumbBlurry,
                              status === 'trash' && styles.thumbSelected,
                              status === 'later' && styles.thumbLater,
                              isPicked && styles.thumbPicked,
                            ]}
                            contentFit="cover"
                          />
                          {inReorder ? (
                            <Pressable
                              style={styles.reorderOverlay}
                              onPress={() => handleReorderTap(group.id, photo.uri)}
                            >
                              <View style={styles.reorderNumber}>
                                <Text style={styles.reorderNumberText}>{photoIndex + 1}</Text>
                              </View>
                            </Pressable>
                          ) : (
                            <>
                              <Pressable
                                style={styles.checkBadge}
                                hitSlop={8}
                                onPress={() => toggleMoveSelection(photo.uri)}
                              >
                                <View
                                  style={[styles.checkCircle, isChecked && styles.checkCircleOn]}
                                >
                                  {isChecked && <Text style={styles.checkCircleText}>✓</Text>}
                                </View>
                              </Pressable>
                              <Pressable
                                style={styles.favHeart}
                                hitSlop={6}
                                onPress={() => onToggleFavorite(photo.uri)}
                              >
                                <Text
                                  style={[styles.favHeartText, isFavorite && styles.favHeartTextOn]}
                                >
                                  {isFavorite ? '♥' : '♡'}
                                </Text>
                              </Pressable>
                              {status === 'trash' ? (
                                <View style={styles.trashBadge}>
                                  <Text style={styles.trashBadgeText}>🗑</Text>
                                </View>
                              ) : status === 'later' ? (
                                <View style={styles.trashBadge}>
                                  <Text style={styles.trashBadgeText}>🕐</Text>
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
                            </>
                          )}
                          <View style={styles.statusRow}>
                            <Pressable
                              style={[
                                styles.statusButton,
                                status === 'keep' && styles.statusButtonActiveKeep,
                              ]}
                              hitSlop={4}
                              onPress={() =>
                                onSetPhotoStatus(photo.uri, status === 'keep' ? 'undecided' : 'keep')
                              }
                            >
                              <Text style={styles.statusButtonText}>✅</Text>
                            </Pressable>
                            <Pressable
                              style={[
                                styles.statusButton,
                                status === 'later' && styles.statusButtonActiveLater,
                              ]}
                              hitSlop={4}
                              onPress={() =>
                                onSetPhotoStatus(photo.uri, status === 'later' ? 'undecided' : 'later')
                              }
                            >
                              <Text style={styles.statusButtonText}>🕐</Text>
                            </Pressable>
                            <Pressable
                              style={[
                                styles.statusButton,
                                status === 'trash' && styles.statusButtonActiveTrash,
                              ]}
                              hitSlop={4}
                              onPress={() =>
                                onSetPhotoStatus(photo.uri, status === 'trash' ? 'undecided' : 'trash')
                              }
                            >
                              <Text style={styles.statusButtonText}>🗑</Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                    {inReorder && reorderPickedUri && (
                      <Pressable
                        style={styles.reorderEndTile}
                        onPress={() => {
                          onReorderMomentPhoto(group.id, reorderPickedUri, null);
                          setReorderPickedUri(null);
                        }}
                      >
                        <Text style={styles.reorderEndTileText}>à la fin</Text>
                      </Pressable>
                    )}
                  </ScrollView>
                </View>
              );
            }}
          />
        )
      ) : mode === 'album' || mode === 'quality' ? (
        allPhotos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Il n'y a plus de photo dans ce dossier.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <Text style={styles.instructions}>
              {mode === 'album'
                ? "Touche les photos que tu veux mettre dans ton album. 🌫 repère celles de qualité moyenne, à éviter pour un album. Touche la loupe pour voir en grand."
                : 'Chaque photo est marquée si elle semble de qualité moyenne (🌫). Touche celles que tu veux copier ailleurs.'}
            </Text>
            {albumUris.size > 0 && (
              <View style={styles.bulkActionsRow}>
                <Pressable style={styles.selectAllButton} onPress={() => setShowOnlyAlbum((v) => !v)}>
                  <Text style={styles.selectAllButtonText}>
                    {showOnlyAlbum
                      ? '👁 Voir toutes les photos'
                      : `👁 Voir seulement la sélection (${albumUris.size})`}
                  </Text>
                </Pressable>
              </View>
            )}
            <View style={styles.blurGrid}>
              {albumGridPhotos.map((photo, index) => {
                const isAlbumSelected = albumUris.has(photo.uri);
                const photoIsMediocre = isBlurry(photo);
                return (
                  <Pressable
                    key={photo.uri}
                    style={styles.blurGridItem}
                    onPress={() => onToggleAlbum(photo.uri)}
                  >
                    <Image
                      source={{ uri: photo.uri }}
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
                      style={[
                        styles.thumb,
                        styles.thumbWithBorderSlot,
                        isAlbumSelected
                          ? styles.thumbAlbumSelected
                          : photoIsMediocre && styles.thumbBlurry,
                      ]}
                      contentFit="cover"
                    />
                    {isAlbumSelected ? (
                      <View style={styles.albumBadge}>
                        <Text style={styles.albumBadgeText}>📁</Text>
                      </View>
                    ) : (
                      photoIsMediocre && (
                        <View style={styles.blurBadge}>
                          <Text style={styles.blurBadgeText}>🌫 qualité moyenne</Text>
                        </View>
                      )
                    )}
                    <Pressable
                      style={styles.magnifyBadge}
                      hitSlop={8}
                      onPress={() =>
                        openFlatViewer(
                          albumGridPhotos,
                          index,
                          mode === 'album' ? 'Choisir un album' : 'Qualité des photos'
                        )
                      }
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
        <FlatList
          data={visibleGroups}
          keyExtractor={(group) => group.id}
          contentContainerStyle={styles.list}
          // Thousands of photos can make hundreds of groups - only mount the
          // ones near the visible area instead of every group's photos at once.
          initialNumToRender={5}
          maxToRenderPerBatch={4}
          windowSize={5}
          extraData={[selected, keepMode, kept, hideUnhearted, reviewedGroupKeys]}
          ListHeaderComponent={
            <>
              <Text style={styles.instructions}>
                {keepMode
                  ? "Touche les photos que tu veux garder : elles reçoivent un cœur. Tout ce qui n'a pas de cœur sera jeté à la validation."
                  : mode === 'duplicates'
                    ? "Touche une photo pour la sélectionner à jeter, ou la loupe pour la voir en grand. L'étoile repère la meilleure version (souvent la plus lourde) et « < 1 Mo » repère les petites copies de faible qualité. Le curseur du haut règle la ressemblance : commence haut, puis baisse-le pour être moins strict."
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
                  {mode === 'duplicates' ? (
                    <Pressable
                      style={styles.selectAllButton}
                      onPress={() =>
                        onSelectExceptBest(
                          visibleGroups.flatMap((g) =>
                            g.photos
                              .slice(1)
                              .filter((p) => isLowQualitySize(p))
                              .map((p) => p.uri)
                          )
                        )
                      }
                    >
                      <Text style={styles.selectAllButtonText}>
                        📉 Les &lt; 1 Mo (sauf la meilleure)
                      </Text>
                    </Pressable>
                  ) : (
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
                  )}
                  {nextMode && (
                    <Pressable style={styles.selectAllButton} onPress={() => onSwitchMode(nextMode)}>
                      <Text style={styles.selectAllButtonText}>
                        ✨ Passer à {SORT_STEPS[nextMode].shortTitle.toLowerCase()}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </>
          }
          renderItem={({ item: group, index: groupIndex }) => {
            const isReviewed = reviewedGroupKeys.has(groupKey(group));
            return (
              <View style={[styles.groupCard, isReviewed && styles.groupCardReviewed]}>
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
                    const photoIsLow = mode === 'duplicates' && isLowQualitySize(photo);
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
                          recyclingKey={photo.uri}
                          cachePolicy="memory-disk"
                          style={[
                            styles.thumb,
                            !keepMode && isSelected && styles.thumbSelected,
                            keepMode && !isHearted && styles.thumbUnhearted,
                            !keepMode && !isSelected && photoIsBlurry && styles.thumbBlurry,
                            !keepMode && !isSelected && photoIsLow && styles.thumbLowQuality,
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
                        ) : photoIsLow ? (
                          <View style={styles.lowQualityBadge}>
                            <Text style={styles.lowQualityBadgeText}>📉 &lt; 1 Mo</Text>
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
                        {mode === 'duplicates' ? (
                          <>
                            <Text style={[styles.thumbSize, photoIsLow && styles.thumbSizeLow]}>
                              {formatBytes(photo.sizeBytes)}
                            </Text>
                            <Text style={styles.thumbFolder} numberOfLines={1}>
                              📁 {shortFolderName(photo.folderPath)}
                            </Text>
                          </>
                        ) : (
                          <Text style={styles.thumbSize}>
                            {formatBytes(photo.sizeBytes)} · net. {Math.round(photo.sharpness)} (
                            {photo.facesFound ? 'visage' : 'photo'})
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            );
          }}
        />
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

      {mode === 'moments' && groups.length > 0 && (
        <View style={styles.bottomBar}>
          {/* One single "jeter" count, whichever way those photos got
              marked - photos ❤️/🕐/🗑-marked full-screen and photos ticked
              in the grid used to show as two separate, confusingly
              overlapping "Jeter N" buttons (confirmed by Flavie). */}
          {trashCandidateUris.size > 0 && (
            <Pressable
              style={[styles.deleteButton, styles.bottomBarStackedButton]}
              disabled={deleting}
              onPress={() => {
                const uris = Array.from(trashCandidateUris);
                setMoveSelection(new Set());
                onDeleteUris(uris);
              }}
            >
              {deleting ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <Text style={styles.deleteButtonText}>
                  🗑 Jeter {trashCandidateUris.size} photo{trashCandidateUris.size > 1 ? 's' : ''}
                </Text>
              )}
            </Pressable>
          )}
          <Pressable
            style={[
              styles.deleteButton,
              styles.albumCreateButton,
              moveSelection.size === 0 && styles.deleteButtonDisabled,
            ]}
            disabled={moveSelection.size === 0}
            onPress={() => setMovePickerOpen(true)}
          >
            <Text style={styles.deleteButtonText}>
              {moveSelection.size === 0
                ? 'Coche des photos à déplacer'
                : `Déplacer ${moveSelection.size} photo${moveSelection.size > 1 ? 's' : ''}`}
            </Text>
          </Pressable>
        </View>
      )}

      {(mode === 'album' || mode === 'quality') && allPhotos.length > 0 && (
        <View style={styles.bottomBar}>
          {albumExporting ? (
            <View style={styles.progressBlock}>
              <Text style={styles.progressText}>
                Copie en cours… {albumExportProgress?.current ?? 0} / {albumExportProgress?.total ?? 0}
              </Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.round(
                        ((albumExportProgress?.current ?? 0) /
                          Math.max(albumExportProgress?.total ?? 1, 1)) *
                          100
                      )}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ) : (
            <Pressable
              style={[
                styles.deleteButton,
                styles.albumCreateButton,
                albumUris.size === 0 && styles.deleteButtonDisabled,
              ]}
              disabled={albumUris.size === 0}
              onPress={() => setAlbumFolderModalOpen(true)}
            >
              <Text style={styles.deleteButtonText}>
                {albumUris.size === 0
                  ? 'Touche des photos pour les choisir'
                  : `📁 Copier ${albumUris.size} photo${albumUris.size > 1 ? 's' : ''} dans un dossier`}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {!keepMode &&
        mode !== 'moments' &&
        mode !== 'album' &&
        mode !== 'quality' &&
        (mode === 'final' || mode === 'momentsFinal' || mode === 'decide'
          ? allPhotos.length > 0
          : mode === 'blurry'
            ? standaloneBlurryPhotos.length > 0
            : mode === 'later' || mode === 'momentsLater'
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
        </>
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
            groupLabel={`${mode === 'moments' ? 'Moment' : 'Groupe'} ${viewerGroupIndex + 1} / ${visibleGroups.length}`}
            starReason={bestPhotoReason(viewerGroup)}
            blurryUris={blurryUris}
            isGroupReviewed={reviewedGroupKeys.has(groupKey(viewerGroup))}
            onMarkGroupReviewed={() => onMarkGroupReviewed(groupKey(viewerGroup))}
            hasPrevGroup={viewerGroupIndex > 0}
            hasNextGroup={viewerGroupIndex < visibleGroups.length - 1}
            onPrevGroup={() => goToGroup(viewerGroupIndex - 1)}
            onNextGroup={() => goToGroup(viewerGroupIndex + 1)}
            laterUris={laterUris}
            keptUris={keptUris}
            onSetPhotoStatus={mode === 'moments' ? onSetPhotoStatus : undefined}
            favoriteUris={mode === 'moments' ? favoriteUris : undefined}
            onToggleFavorite={mode === 'moments' ? onToggleFavorite : undefined}
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
            laterUris={laterUris}
            keptUris={keptUris}
            onSetPhotoStatus={
              !secondaryMode && (mode === 'decide' || mode === 'later' || mode === 'momentsLater')
                ? onSetPhotoStatus
                : undefined
            }
            showLaterOption={mode !== 'later' && mode !== 'momentsLater'}
            albumUris={
              !secondaryMode && (mode === 'album' || mode === 'quality') ? albumUris : undefined
            }
            onToggleAlbum={
              !secondaryMode && (mode === 'album' || mode === 'quality') ? onToggleAlbum : undefined
            }
            secondaryActionUris={secondaryMode ? secondaryActionUris : undefined}
            onToggleSecondaryAction={secondaryMode ? onToggleSecondaryAction : undefined}
            secondaryActionKind={secondaryMode ?? undefined}
            favoriteUris={
              !secondaryMode && (mode === 'momentsLater' || mode === 'momentsFinal')
                ? favoriteUris
                : undefined
            }
            onToggleFavorite={
              !secondaryMode && (mode === 'momentsLater' || mode === 'momentsFinal')
                ? onToggleFavorite
                : undefined
            }
          />
        )}
      </Modal>

      <Modal
        visible={movePickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setMovePickerOpen(false)}
      >
        <Pressable style={styles.movePickerBackdrop} onPress={() => setMovePickerOpen(false)}>
          <Pressable style={styles.movePickerSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.movePickerTitle}>
              Déplacer {moveSelection.size} photo{moveSelection.size > 1 ? 's' : ''} vers…
            </Text>
            <ScrollView>
              <View style={styles.movePickerGrid}>
                <Pressable
                  style={styles.movePickerTile}
                  onPress={() => {
                    onMoveMomentPhotos(Array.from(moveSelection), 'new');
                    setMoveSelection(new Set());
                    setMovePickerOpen(false);
                  }}
                >
                  <View style={styles.movePickerNewTile}>
                    <Text style={styles.movePickerNewTileText}>➕</Text>
                  </View>
                  <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                    Nouveau groupe séparé
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.movePickerTile}
                  onPress={() => {
                    const uris = Array.from(moveSelection);
                    setMoveSelection(new Set());
                    setMovePickerOpen(false);
                    onSeedSecondaryAction(uris);
                    setSecondaryMode('move');
                    setSecondaryFolderModalOpen(true);
                  }}
                >
                  <View style={styles.movePickerNewTile}>
                    <Text style={styles.movePickerNewTileText}>📦</Text>
                  </View>
                  <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                    Déplacer vers un dossier
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.movePickerTile}
                  onPress={() => {
                    const uris = Array.from(moveSelection);
                    setMoveSelection(new Set());
                    setMovePickerOpen(false);
                    onSeedSecondaryAction(uris);
                    setSecondaryMode('copy');
                    setSecondaryFolderModalOpen(true);
                  }}
                >
                  <View style={styles.movePickerNewTile}>
                    <Text style={styles.movePickerNewTileText}>📄</Text>
                  </View>
                  <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                    Copier vers un dossier
                  </Text>
                </Pressable>
                {groups.map((g, i) => {
                  const first = g.photos[0];
                  const label = first?.capturedAt
                    ? new Date(first.capturedAt).toLocaleString('fr-FR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Sans date';
                  return (
                    <Pressable
                      key={g.id}
                      style={styles.movePickerTile}
                      onPress={() => {
                        onMoveMomentPhotos(Array.from(moveSelection), g.id);
                        setMoveSelection(new Set());
                        setMovePickerOpen(false);
                      }}
                    >
                      <Image
                        source={{ uri: first?.uri }}
                        recyclingKey={first?.uri}
                        cachePolicy="memory-disk"
                        style={styles.movePickerThumb}
                        contentFit="cover"
                      />
                      <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                        Moment {i + 1} · {label} · {g.photos.length} photo
                        {g.photos.length > 1 ? 's' : ''}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            <Pressable style={styles.movePickerCancel} onPress={() => setMovePickerOpen(false)}>
              <Text style={styles.movePickerCancelText}>Annuler</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={similarityScope !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setSimilarityScope(null)}
      >
        <Pressable style={styles.movePickerBackdrop} onPress={() => setSimilarityScope(null)}>
          <Pressable style={styles.similaritySheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.movePickerTitle}>
              {similarityScope === 'all'
                ? 'Rapprocher les photos similaires (tous les moments)'
                : 'Rapprocher les photos similaires de ce moment'}
            </Text>
            <Text style={styles.similarityDialogHint}>
              Compare la forme ET les couleurs des photos à l'intérieur de chaque moment (une main, un visage et un cadrage en pied du même bébé partagent les mêmes couleurs). C'est instantané.
            </Text>
            <View style={styles.similarityLabelRow}>
              <Text style={styles.similarityLabel}>Niveau de ressemblance</Text>
              <Text style={styles.similarityPercent}>{similarityPercent}%</Text>
            </View>
            <Slider
              minimumValue={60}
              maximumValue={95}
              step={1}
              value={similarityPercent}
              onValueChange={setSimilarityPercent}
              minimumTrackTintColor={colors.primary}
              maximumTrackTintColor={colors.border}
              thumbTintColor={colors.primary}
            />
            <View style={styles.similarityRow}>
              <Text style={styles.similarityEdgeLabel}>Large</Text>
              <Text style={styles.similarityEdgeLabel}>Très proches</Text>
            </View>
            <Text style={styles.similarityPreviewCount}>
              {!similarityPreview || similarityPreview.sets.length === 0
                ? 'Aucun ensemble de photos similaires à ce niveau - baisse le curseur.'
                : `${similarityPreview.sets.length} ensemble${similarityPreview.sets.length > 1 ? 's' : ''} de photos similaires · ${similarityPreview.photoCount} photos concernées`}
            </Text>
            {/* Every set is shown and the list scrolls (it used to stop at 8,
                with no way down) - thumbnails wrap instead of scrolling
                sideways so vertical swipes never fight a nested scroller. */}
            <FlatList
              style={styles.similarityPreviewList}
              data={similarityPreview?.sets ?? []}
              keyExtractor={(set, i) => `${i}-${set[0].uri}`}
              nestedScrollEnabled
              initialNumToRender={6}
              windowSize={5}
              renderItem={({ item: set }) => (
                <View style={styles.similarityPreviewRow}>
                  {set.slice(0, 12).map((photo) => (
                    <Image
                      key={photo.uri}
                      source={{ uri: photo.uri }}
                      recyclingKey={photo.uri}
                      cachePolicy="memory-disk"
                      style={styles.similarityPreviewThumb}
                      contentFit="cover"
                    />
                  ))}
                  {set.length > 12 && (
                    <Text style={styles.similarityPreviewMore}>+{set.length - 12}</Text>
                  )}
                </View>
              )}
            />
            <Pressable
              style={[
                styles.deleteButton,
                styles.albumCreateButton,
                styles.similarityDialogButton,
                (!similarityPreview || similarityPreview.sets.length === 0) &&
                  styles.deleteButtonDisabled,
              ]}
              disabled={!similarityPreview || similarityPreview.sets.length === 0}
              onPress={() => {
                if (similarityScope) onRegroupBySimilarity(similarityScope, similarityPercent, 'sort');
                setSimilarityScope(null);
              }}
            >
              <Text style={styles.deleteButtonText}>↔ Les mettre côte à côte dans le même moment</Text>
            </Pressable>
            <Pressable
              style={[
                styles.deleteButton,
                styles.albumCreateButton,
                styles.similarityDialogButton,
                (!similarityPreview || similarityPreview.sets.length === 0) &&
                  styles.deleteButtonDisabled,
              ]}
              disabled={!similarityPreview || similarityPreview.sets.length === 0}
              onPress={() => {
                if (similarityScope) onRegroupBySimilarity(similarityScope, similarityPercent, 'split');
                setSimilarityScope(null);
              }}
            >
              <Text style={styles.deleteButtonText}>✂ Découper en plusieurs moments</Text>
            </Pressable>
            <Pressable style={styles.movePickerCancel} onPress={() => setSimilarityScope(null)}>
              <Text style={styles.movePickerCancelText}>Annuler</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={placeGroupId !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setPlaceGroupId(null)}
      >
        <Pressable style={styles.movePickerBackdrop} onPress={() => setPlaceGroupId(null)}>
          <Pressable style={styles.movePickerSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.movePickerTitle}>Placer ce moment après…</Text>
            <ScrollView>
              <View style={styles.movePickerGrid}>
                <Pressable
                  style={styles.movePickerTile}
                  onPress={() => {
                    if (placeGroupId) onMoveMomentGroupTo(placeGroupId, 'start');
                    setPlaceGroupId(null);
                  }}
                >
                  <View style={styles.movePickerNewTile}>
                    <Text style={styles.movePickerNewTileText}>⤒</Text>
                  </View>
                  <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                    Tout au début
                  </Text>
                </Pressable>
                {groups
                  .filter((g) => g.id !== placeGroupId)
                  .map((g) => {
                    const first = g.photos[0];
                    const number = groups.indexOf(g) + 1;
                    return (
                      <Pressable
                        key={g.id}
                        style={styles.movePickerTile}
                        onPress={() => {
                          if (placeGroupId) onMoveMomentGroupTo(placeGroupId, g.id);
                          setPlaceGroupId(null);
                        }}
                      >
                        <Image
                          source={{ uri: first?.uri }}
                          recyclingKey={first?.uri}
                          cachePolicy="memory-disk"
                          style={styles.movePickerThumb}
                          contentFit="cover"
                        />
                        <Text style={styles.movePickerTileLabel} numberOfLines={2}>
                          Après le moment {number} · {g.photos.length} photo
                          {g.photos.length > 1 ? 's' : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
              </View>
            </ScrollView>
            <Pressable style={styles.movePickerCancel} onPress={() => setPlaceGroupId(null)}>
              <Text style={styles.movePickerCancelText}>Annuler</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <FolderDestinationModal
        visible={albumFolderModalOpen}
        onClose={() => setAlbumFolderModalOpen(false)}
        title="Où mettre les photos ?"
        hint="Dans les deux cas, les photos seront copiées, pas déplacées : rien ne change dans ton dossier d'origine."
        existingFolderLabel="📂 Dans un dossier existant"
        newFolderPlaceholder="Nom du nouveau dossier, ex. Vacances été 2026"
        newFolderButtonLabel="📁 Créer ce nouveau dossier"
        onChooseExisting={onCopyToExistingFolder}
        onCreateNew={onCreateAlbum}
      />

      <FolderDestinationModal
        visible={secondaryFolderModalOpen}
        onClose={() => setSecondaryFolderModalOpen(false)}
        title={secondaryMode === 'move' ? 'Où déplacer les photos ?' : 'Où copier les photos ?'}
        hint={
          secondaryMode === 'move'
            ? 'Dans les deux cas, les photos seront déplacées : elles ne seront plus à leur emplacement actuel.'
            : "Dans les deux cas, les photos seront copiées, pas déplacées : rien ne change dans ton dossier d'origine."
        }
        existingFolderLabel="📂 Dans un dossier existant"
        newFolderPlaceholder="Nom du nouveau dossier"
        newFolderButtonLabel="📁 Créer ce nouveau dossier"
        onChooseExisting={
          secondaryMode === 'move' ? onMoveToExistingFolder : onCopySelectedToExistingFolder
        }
        onCreateNew={secondaryMode === 'move' ? onMoveToNewFolder : onCopySelectedToNewFolder}
      />

      <Modal
        visible={secondaryMenuOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setSecondaryMenuOpen(false)}
      >
        <Pressable style={styles.movePickerBackdrop} onPress={() => setSecondaryMenuOpen(false)}>
          <Pressable style={styles.secondaryMenuSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.movePickerTitle}>Autres actions</Text>
            <Pressable
              style={styles.secondaryMenuItem}
              onPress={() => {
                setSecondaryMenuOpen(false);
                setSecondaryMode('move');
                setShowSecondaryScreen(true);
              }}
            >
              <Text style={styles.secondaryMenuItemText}>
                📦 Déplacer des photos vers un dossier
              </Text>
              <Text style={styles.secondaryMenuItemHint}>
                Pour une photo mal placée - choisis-la, puis son nouveau dossier.
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondaryMenuItem}
              onPress={() => {
                setSecondaryMenuOpen(false);
                setSecondaryMode('copy');
                setShowSecondaryScreen(true);
              }}
            >
              <Text style={styles.secondaryMenuItemText}>📄 Copier des photos vers un dossier</Text>
              <Text style={styles.secondaryMenuItemHint}>
                Choisis-les, puis un dossier - tes photos d'origine ne bougent pas.
              </Text>
            </Pressable>
            <Pressable style={styles.movePickerCancel} onPress={() => setSecondaryMenuOpen(false)}>
              <Text style={styles.movePickerCancelText}>Fermer</Text>
            </Pressable>
          </Pressable>
        </Pressable>
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
  headerTopRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  moreButton: {
    marginLeft: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  moreButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.subtleText,
    marginTop: -6,
  },
  secondaryMenuSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  secondaryMenuItem: {
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  secondaryMenuItemText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  secondaryMenuItemHint: {
    fontSize: 12,
    color: colors.subtleText,
    lineHeight: 16,
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
  reorderArrow: {
    fontSize: 15,
    color: colors.primary,
    marginLeft: 10,
  },
  reorderArrowDisabled: {
    color: colors.border,
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
  thumbPicked: {
    borderColor: colors.primary,
  },
  groupActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    marginBottom: 10,
  },
  groupPill: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    marginRight: 6,
    marginBottom: 6,
  },
  groupPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  groupPillDisabled: {
    opacity: 0.35,
  },
  groupPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },
  groupPillTextActive: {
    color: colors.primaryText,
  },
  reorderHint: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: '600',
    marginBottom: 8,
  },
  reorderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 12,
    backgroundColor: 'rgba(79,107,255,0.12)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 8,
  },
  reorderNumber: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 6,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderNumberText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  reorderEndTile: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderEndTileText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  favHeart: {
    position: 'absolute',
    top: 4,
    left: 38,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  favHeartText: {
    fontSize: 20,
    color: colors.subtleText,
    marginTop: -2,
  },
  favHeartTextOn: {
    color: colors.danger,
  },
  similarityDialogHint: {
    fontSize: 13,
    color: colors.subtleText,
    lineHeight: 18,
    marginBottom: 14,
  },
  similarityDialogButton: {
    marginTop: 10,
  },
  similarityPreviewCount: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginTop: 12,
    marginBottom: 8,
    lineHeight: 18,
  },
  similaritySheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '92%',
  },
  similarityPreviewList: {
    flexGrow: 0,
    flexShrink: 1,
  },
  similarityPreviewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  similarityPreviewThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    marginRight: 6,
    marginBottom: 6,
    backgroundColor: colors.border,
  },
  similarityPreviewMore: {
    alignSelf: 'center',
    fontSize: 12,
    color: colors.subtleText,
    marginRight: 6,
  },
  thumbLowQuality: {
    borderWidth: 3,
    borderColor: colors.badge,
  },
  lowQualityBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: colors.badge,
  },
  lowQualityBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  thumbSizeLow: {
    color: '#B36B00',
    fontWeight: '700',
  },
  thumbFolder: {
    fontSize: 11,
    color: colors.subtleText,
    maxWidth: 150,
  },
  // A constant-width, initially-invisible border "slot" for the album grid,
  // so selecting/deselecting only ever changes a color, never the border
  // width - changing the width shrinks/grows the image's own content box,
  // which was making expo-image occasionally redraw it blank on Android
  // (confirmed by Flavie: deselecting "often" left a gray square instead of
  // the photo). thumbSelected/thumbBlurry elsewhere use opacity or a border
  // that's static per-photo, not toggled by the user, so they don't have
  // this problem.
  thumbWithBorderSlot: {
    borderWidth: 3,
    borderColor: 'transparent',
  },
  thumbAlbumSelected: {
    borderColor: colors.primary,
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
  albumBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumBadgeText: {
    fontSize: 14,
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
  checkBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkCircleOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkCircleText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  movePickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  movePickerSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '75%',
  },
  movePickerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  movePickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  movePickerTile: {
    width: 96,
    marginRight: 10,
    marginBottom: 14,
    alignItems: 'center',
  },
  movePickerThumb: {
    width: 96,
    height: 96,
    borderRadius: 12,
    backgroundColor: colors.border,
  },
  movePickerNewTile: {
    width: 96,
    height: 96,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  movePickerNewTileText: {
    fontSize: 28,
  },
  movePickerTileLabel: {
    fontSize: 11,
    color: colors.subtleText,
    textAlign: 'center',
    marginTop: 6,
  },
  movePickerCancel: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  movePickerCancelText: {
    color: colors.subtleText,
    fontSize: 14,
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
  albumCreateButton: {
    backgroundColor: colors.primary,
  },
  bottomBarStackedButton: {
    marginBottom: 10,
  },
  progressBlock: {
    paddingVertical: 4,
  },
  progressText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 10,
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
});
