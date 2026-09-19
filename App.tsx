import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import HashWorker, { HashWorkerHandle } from './src/components/HashWorker';
import { copyPhotosToFolder, copyPhotosToNewFolder } from './src/lib/albumExport';
import {
  getSavedAnalysis,
  getSavedFavorites,
  saveAnalysis,
  saveFavorites,
} from './src/lib/analysisStorage';
import {
  startScanningService,
  stopScanningService,
  updateScanningProgress,
} from './src/lib/backgroundScan';
import {
  groupByMoments,
  groupDuplicates,
  clusterBySimilarity,
  groupKey,
  MOMENT_GAP_MS,
  percentToThreshold,
  SORT_STEPS,
  sortBySimilarity,
  splitBySimilarity,
  type DuplicateGroup,
  type SortMode,
} from './src/lib/duplicateGroups';
import { listSubfolders, pickFolder, scanFolderForImages, type SubfolderEntry } from './src/lib/imageFiles';
import { movePhotosToFolder, movePhotosToNewFolder } from './src/lib/movePhotos';
import { hashPhoto, type HashedPhoto } from './src/lib/perceptualHash';
import {
  getLastFolderUri,
  getTrashEntries,
  getTrashReminder,
  moveAllToSetAside,
  moveOneToSetAside,
  moveToTrash,
  restoreAll,
  restoreOne,
  setLastFolderUri,
  type TrashEntry,
} from './src/lib/trash';
import HomeScreen from './src/screens/HomeScreen';
import ResultsScreen from './src/screens/ResultsScreen';
import ScanningScreen, { type ScanStatus } from './src/screens/ScanningScreen';
import SubfolderPickerScreen from './src/screens/SubfolderPickerScreen';
import TrashScreen from './src/screens/TrashScreen';
import { colors } from './src/theme';

type Screen = 'home' | 'scanning' | 'results' | 'trash' | 'subfolders';

/** Steps still offered from the home screen: duplicates, and the moments flow (moments -> later -> final -> album). */
const REACHABLE_MODES: SortMode[] = ['duplicates', 'moments', 'momentsLater', 'momentsFinal', 'album'];

function isMomentsPart(mode: SortMode): boolean {
  return mode === 'moments' || mode === 'momentsLater' || mode === 'momentsFinal' || mode === 'album';
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [lastFolderUri, setLastFolderUriState] = useState<string | null>(null);
  // While `screen === 'subfolders'`: the folder/mode waiting for her to
  // pick which sub-folders to include, and the list to choose from.
  const [pendingAnalysis, setPendingAnalysis] = useState<{
    folderUri: string;
    mode: SortMode;
  } | null>(null);
  const [subfolderOptions, setSubfolderOptions] = useState<SubfolderEntry[]>([]);
  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    phase: 'listing',
    foundImages: 0,
    hashedCount: 0,
  });
  const [hashedPhotos, setHashedPhotos] = useState<HashedPhoto[]>([]);
  // The duplicates step deliberately skips computing sharpness (it doesn't
  // need it, and skipping it keeps that step as fast as possible - see
  // hashPhoto's needSharpness option) - so hashedPhotos from that step alone
  // can't be reused for the similar/final steps, which do need it. Tracks
  // whether a real rescan is needed when moving to one of those.
  const [hasSharpness, setHasSharpness] = useState(true);
  // Debug-only: why face detection did or didn't come up during the last
  // scan, shown on the results screen so this can be checked without ever
  // needing to look at logs.
  const [faceModelDiagnostic, setFaceModelDiagnostic] = useState<string | null>(null);
  const [mode, setMode] = useState<SortMode>('duplicates');
  const [similarityThreshold, setSimilarityThreshold] = useState(
    SORT_STEPS.duplicates.defaultThreshold
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // "Voir plus tard" marks from the "decide" step - a photo can be in
  // `selected` (poubelle), `laterUris`, or `keptUris`, never more than one
  // at a time; being in none of the three means "pas encore décidé" (not
  // decided yet - deliberately distinct from `keptUris`, since a photo
  // Flavie hasn't looked at yet isn't the same as one she's actively chosen
  // to keep; the ❤️ button used to look "on" by default for every untouched
  // photo, which was misleading).
  const [laterUris, setLaterUris] = useState<Set<string>>(new Set());
  const [keptUris, setKeptUris] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  // Shown as a progress bar on the trash screen during "Tout ranger"/"Tout
  // restaurer" - moving many photos one by one can take a while, and with
  // nothing on screen it was impossible to tell "it's just slow" from "it's
  // stuck".
  const [movingProgress, setMovingProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [reviewedGroupKeys, setReviewedGroupKeys] = useState<Set<string>>(new Set());
  // "moments" grouping starts out computed (groupByMoments), but unlike
  // every other step it can then be hand-edited (move a photo to another
  // moment, or split it out into its own) - so it lives in its own state,
  // seeded once when that scan finishes, instead of being recomputed (and
  // silently discarding any edits) on every render.
  const [momentGroups, setMomentGroups] = useState<DuplicateGroup[]>([]);
  // "album"/"quality" steps: photos picked to copy into a new folder - its
  // own set, independent of `selected` (poubelle) and `laterUris`, since
  // being in an album has nothing to do with either of those.
  const [albumUris, setAlbumUris] = useState<Set<string>>(new Set());
  // ♥ favorites: marking one also puts it in `albumUris` (so it's already
  // ticked when the album step opens), see toggleFavorite.
  const [favoriteUris, setFavoriteUris] = useState<Set<string>>(new Set());
  const [albumExporting, setAlbumExporting] = useState(false);
  const [albumExportProgress, setAlbumExportProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  // Secondary "déplacer"/"copier vers un dossier" actions, reachable from
  // any step via ResultsScreen's "•••" menu - e.g. for a photo that turns
  // out to be sitting in the wrong sub-folder. Share one selection set and
  // one progress tracker (only one of the two is ever in progress at a
  // time) - independent of the album/trash/keep/later marks.
  const [secondaryActionUris, setSecondaryActionUris] = useState<Set<string>>(new Set());
  const [secondaryActionRunning, setSecondaryActionRunning] = useState(false);
  const [secondaryActionProgress, setSecondaryActionProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const hashWorkerRef = useRef<HashWorkerHandle>(null);

  const groups = useMemo(() => {
    // Every step of the moments flow (incl. the album) reads the hand-edited
    // moment groups - not worth recomputing a similarity grouping there.
    if (isMomentsPart(mode)) return momentGroups;
    // "duplicates": no time gate - a genuine copy's file name can carry a
    // copy/save time completely unrelated to the original shot.
    return groupDuplicates(hashedPhotos, similarityThreshold);
  }, [hashedPhotos, similarityThreshold, mode, momentGroups]);

  const trashReminder = useMemo(() => getTrashReminder(trashEntries), [trashEntries]);

  useEffect(() => {
    getLastFolderUri().then(setLastFolderUriState);
    getSavedFavorites().then((uris) => {
      setFavoriteUris(new Set(uris));
      // Already ticked for the album when it opens, same as right after marking them.
      setAlbumUris(new Set(uris));
    });
    refreshTrash();
    getSavedAnalysis().then((saved) => {
      if (saved && saved.hashedPhotos.length > 0) {
        setHashedPhotos(saved.hashedPhotos);
        setSimilarityThreshold(saved.similarityThreshold);
        setReviewedGroupKeys(new Set(saved.reviewedGroupKeys ?? []));
        // A save from an older version of the app could carry a step that
        // no longer exists (the sorting path has changed over time) - fall
        // back rather than restoring into a step the app can't render.
        // Only the steps still reachable from the home screen (the older
        // "sorting" and "quality" parts aren't offered anymore).
        const restoredMode =
          saved.mode && REACHABLE_MODES.includes(saved.mode) ? saved.mode : 'duplicates';
        setMode(restoredMode);
        setHasSharpness(restoredMode !== 'duplicates');
        // A save from before momentGroups was persisted (or the mode wasn't
        // "moments" at save time) has none - recompute fresh rather than
        // showing an empty "moments" step for no reason.
        setMomentGroups(
          saved.momentGroups ??
            (isMomentsPart(restoredMode) ? groupByMoments(saved.hashedPhotos, MOMENT_GAP_MS) : [])
        );
        setScreen('results');
      }
    });
  }, []);

  // Skips the very first run (empty set, before favorites finish loading),
  // which would otherwise overwrite what was saved.
  const favoritesLoaded = useRef(false);
  useEffect(() => {
    if (!favoritesLoaded.current) {
      favoritesLoaded.current = true;
      return;
    }
    saveFavorites(Array.from(favoriteUris));
  }, [favoriteUris]);

  async function refreshTrash() {
    setTrashEntries(await getTrashEntries());
  }

  async function analyzeFolder(
    folderUri: string,
    forMode: SortMode,
    subfolderFilter?: Set<string> | null
  ) {
    setScreen('scanning');
    setScanStatus({ phase: 'listing', foundImages: 0, hashedCount: 0 });

    try {
      const images = await scanFolderForImages(
        folderUri,
        (progress) => {
          setScanStatus({ phase: 'listing', foundImages: progress.foundImages, hashedCount: 0 });
        },
        subfolderFilter
      );

      if (images.length === 0) {
        Alert.alert('Aucune photo trouvée', "Ce dossier ne contient pas de photo à analyser.");
        setScreen('home');
        return;
      }

      await setLastFolderUri(folderUri);
      setLastFolderUriState(folderUri);

      const worker = hashWorkerRef.current;
      if (!worker) throw new Error('hash_worker_not_ready');

      await startScanningService(images.length);

      const hashed: HashedPhoto[] = [];
      let firstError: string | null = null;
      for (let i = 0; i < images.length; i++) {
        setScanStatus({
          phase: 'hashing',
          foundImages: images.length,
          hashedCount: i,
          currentPhotoUri: images[i].uri,
        });
        const { photo, error } = await hashPhoto(images[i], worker, {
          needSharpness: forMode !== 'duplicates',
        });
        if (photo) hashed.push(photo);
        else if (error && !firstError) firstError = error;
        setScanStatus({
          phase: 'hashing',
          foundImages: images.length,
          hashedCount: i + 1,
          currentPhotoUri: images[i].uri,
        });
        await updateScanningProgress(i + 1, images.length);
      }

      await stopScanningService();
      setFaceModelDiagnostic(worker.getFaceModelDiagnostic());

      // Every single photo failed to analyse - rather than silently landing
      // on an empty, confusing results screen, show why so it isn't a
      // guessing game (this shouldn't happen with a working folder, but
      // it's much easier to fix a shown reason than an invisible one).
      if (hashed.length === 0 && firstError) {
        Alert.alert(
          "L'analyse n'a rien donné",
          `Aucune des ${images.length} photo${images.length > 1 ? 's' : ''} n'a pu être lue. Détail technique : ${firstError}`
        );
        setScreen('home');
        return;
      }

      const threshold = SORT_STEPS[forMode].defaultThreshold;
      const freshMomentGroups =
        forMode === 'moments' ? groupByMoments(hashed, MOMENT_GAP_MS) : momentGroups;
      setHashedPhotos(hashed);
      setHasSharpness(forMode !== 'duplicates');
      if (forMode === 'moments') {
        setMomentGroups(freshMomentGroups);
      }
      setMode(forMode);
      setSimilarityThreshold(threshold);
      setSelected(new Set());
      setLaterUris(new Set());
      setKeptUris(new Set());
      setFavoriteUris(new Set());
      setAlbumUris(new Set());
      setSecondaryActionUris(new Set());
      setReviewedGroupKeys(new Set());
      setScreen('results');
      await saveAnalysis({
        folderUri,
        similarityThreshold: threshold,
        hashedPhotos: hashed,
        reviewedGroupKeys: [],
        mode: forMode,
        momentGroups: freshMomentGroups,
      });
    } catch (error) {
      console.warn('Erreur pendant l’analyse', error);
      await stopScanningService();
      Alert.alert(
        'Un souci est survenu',
        "L'analyse du dossier s'est arrêtée en cours de route. Tu peux réessayer."
      );
      setScreen('home');
    }
  }

/**
   * The corbeille shouldn't be silently forgotten - whenever the user is
   * about to move on (start a new analysis, or wrap up the current one), if
   * it isn't empty they pick what happens to what's left before continuing.
   * Resolves false if they cancel, in which case the caller doesn't proceed.
   */
  function resolveTrashPrompt(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (trashEntries.length === 0 || !lastFolderUri) {
        resolve(true);
        return;
      }
      const root = lastFolderUri;
      Alert.alert(
        "La corbeille n'est pas vide",
        `Tu as ${trashEntries.length} photo${trashEntries.length > 1 ? 's' : ''} dans la corbeille. ${question}`,
        [
          { text: 'Annuler', style: 'cancel', onPress: () => resolve(false) },
          {
            text: 'Restaurer tout',
            onPress: async () => {
              await restoreAll(root);
              await refreshTrash();
              resolve(true);
            },
          },
          {
            text: 'Les mettre de côté',
            onPress: async () => {
              await moveAllToSetAside(root);
              await refreshTrash();
              resolve(true);
            },
          },
        ]
      );
    });
  }

  /**
   * When the folder about to be analyzed has 2+ immediate sub-folders,
   * offers to include just some of them (e.g. 2 out of 4) instead of always
   * scanning everything underneath - useful on a big folder, and doubles as
   * a way to check for duplicates across just the folders that matter right
   * now. Skipped (straight to analyzing) when there's 0 or 1 sub-folder, so
   * a simple folder stays exactly as fast as before.
   */
  async function maybeAskSubfolders(folderUri: string, forMode: SortMode) {
    try {
      const subfolders = await listSubfolders(folderUri);
      if (subfolders.length < 2) {
        await analyzeFolder(folderUri, forMode);
        return;
      }
      setPendingAnalysis({ folderUri, mode: forMode });
      setSubfolderOptions(subfolders);
      setScreen('subfolders');
    } catch (error) {
      console.warn('Erreur listage sous-dossiers', error);
      // Not being able to list them isn't worth blocking on - fall back to
      // analyzing the whole thing like before.
      await analyzeFolder(folderUri, forMode);
    }
  }

  function handleConfirmSubfolders(selectedUris: string[]) {
    if (!pendingAnalysis) return;
    const { folderUri, mode: forMode } = pendingAnalysis;
    setPendingAnalysis(null);
    analyzeFolder(folderUri, forMode, new Set(selectedUris));
  }

  function handleCancelSubfolders() {
    setPendingAnalysis(null);
    setScreen('home');
  }

  async function handlePickFolder(forMode: SortMode) {
    const proceed = await resolveTrashPrompt('Avant de lancer une nouvelle analyse, que veux-tu en faire ?');
    if (!proceed) return;
    try {
      const folderUri = await pickFolder(lastFolderUri);
      if (!folderUri) return;
      await maybeAskSubfolders(folderUri, forMode);
    } catch (error) {
      console.warn('Erreur choix dossier', error);
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à ouvrir ce dossier.");
    }
  }

  async function handleRescanLastFolder(forMode: SortMode) {
    const proceed = await resolveTrashPrompt('Avant de lancer une nouvelle analyse, que veux-tu en faire ?');
    if (!proceed || !lastFolderUri) return;
    await maybeAskSubfolders(lastFolderUri, forMode);
  }

  async function handleFinishSorting() {
    const proceed = await resolveTrashPrompt('Avant de terminer le tri, que veux-tu en faire ?');
    if (!proceed) return;
    setScreen('home');
  }

  function handleChangeSimilarity(threshold: number) {
    setSimilarityThreshold(threshold);
    setSelected(new Set());
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold: threshold,
        hashedPhotos,
        reviewedGroupKeys: Array.from(reviewedGroupKeys),
        mode,
        momentGroups,
      });
    }
  }

  function switchMode(newMode: SortMode) {
    // Defensive only: the UI now never offers a jump between the duplicates
    // part and the sorting part (each has its own entry point on the home
    // screen), so this shouldn't normally trigger - but if it ever did, a
    // bare hash with no sharpness isn't enough for the sorting steps, so a
    // real rescan is needed rather than switching onto incomplete data.
    if (newMode !== 'duplicates' && !hasSharpness && lastFolderUri) {
      analyzeFolder(lastFolderUri, newMode);
      return;
    }
    // "blurry" and "final" don't have their own grouping - they read the
    // same groups "similar" already computed (to know which blurry photos
    // have no group to compare against, and to keep marking each group's
    // star correctly), so switching to either must never touch the
    // threshold that produced those groups. Only "similar" itself (and
    // "duplicates", a different part entirely) sets a fresh one.
    const threshold =
      newMode === 'similar' || newMode === 'duplicates'
        ? SORT_STEPS[newMode].defaultThreshold
        : similarityThreshold;
    setMode(newMode);
    setSimilarityThreshold(threshold);
    // Not resetting `selected`/`laterUris` here: a photo marked for the
    // corbeille or "voir plus tard" on one step (especially "decide", whose
    // whole point is to carry marks into "later") should still be marked
    // that way after moving to another step, not silently forgotten.
    setReviewedGroupKeys(new Set());
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold: threshold,
        hashedPhotos,
        reviewedGroupKeys: [],
        mode: newMode,
        momentGroups,
      });
    }
  }

  function markGroupReviewed(key: string) {
    setReviewedGroupKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      if (lastFolderUri) {
        saveAnalysis({
          folderUri: lastFolderUri,
          similarityThreshold,
          hashedPhotos,
          reviewedGroupKeys: Array.from(next),
          mode,
          momentGroups,
        });
      }
      return next;
    });
  }

  function toggleSelect(uri: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) {
        next.delete(uri);
      } else {
        next.add(uri);
      }
      return next;
    });
    // A photo just marked for the corbeille was presumably "voir plus tard"
    // no longer - the decision has been made.
    setLaterUris((prev) => {
      if (!prev.has(uri)) return prev;
      const next = new Set(prev);
      next.delete(uri);
      return next;
    });
  }

  function selectExceptBest(uris: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      uris.forEach((uri) => next.add(uri));
      return next;
    });
    setLaterUris((prev) => {
      const next = new Set(prev);
      let changed = false;
      uris.forEach((uri) => {
        if (next.delete(uri)) changed = true;
      });
      return changed ? next : prev;
    });
  }

  function toggleAlbum(uri: string) {
    setAlbumUris((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }

  /**
   * Runs a copy (either flavor below), showing progress and a final summary
   * - shared so both "new folder" and "existing folder" report the same way.
   */
  async function runAlbumCopy(
    copy: (
      photos: { uri: string; name: string }[],
      onProgress: (current: number, total: number) => void
    ) => Promise<{ copiedCount: number; failedCount: number }>,
    destinationLabel: string
  ) {
    const toExport = hashedPhotos.filter((p) => albumUris.has(p.uri));
    if (toExport.length === 0) return;
    setAlbumExporting(true);
    setAlbumExportProgress({ current: 0, total: toExport.length });
    try {
      const { copiedCount, failedCount } = await copy(
        toExport.map((p) => ({ uri: p.uri, name: p.name })),
        (current, total) => setAlbumExportProgress({ current, total })
      );
      // Copied photos have nothing more to do here - clearing the
      // selection makes it easy to pick a fresh batch right away instead
      // of having to untick everything that was just copied.
      setAlbumUris(new Set());
      // Copied favorites have done their job - no longer ♥ (and so not
      // ticked again next time the album opens).
      setFavoriteUris((prev) => {
        const next = new Set(prev);
        toExport.forEach((p) => next.delete(p.uri));
        return next;
      });
      if (failedCount === 0) {
        Alert.alert(
          'Album créé',
          `${copiedCount} photo${copiedCount > 1 ? 's' : ''} copiée${copiedCount > 1 ? 's' : ''} ${destinationLabel}. Tes photos d'origine n'ont pas bougé.`
        );
      } else {
        Alert.alert(
          'Album créé, avec quelques soucis',
          `${copiedCount} photo${copiedCount > 1 ? 's' : ''} copiée${copiedCount > 1 ? 's' : ''}, mais ${failedCount} n'${failedCount > 1 ? 'ont' : 'a'} pas pu être copiée${failedCount > 1 ? 's' : ''}. Réessaie pour celles qui manquent.`
        );
      }
    } catch (error) {
      console.warn('Erreur création album', error);
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à copier les photos. Réessaie.");
    } finally {
      setAlbumExporting(false);
      setAlbumExportProgress(null);
    }
  }

  /**
   * Copies every photo currently marked for the album into a new (or
   * reused) sub-folder named `name`, inside a folder the user picks via the
   * native folder chooser - always a copy, the originals never move.
   */
  async function handleCreateAlbum(name: string) {
    if (albumUris.size === 0) return;
    const parentUri = await pickFolder(lastFolderUri);
    if (!parentUri) return;
    await runAlbumCopy(
      (photos, onProgress) => copyPhotosToNewFolder(photos, parentUri, name, onProgress),
      `dans "${name}"`
    );
  }

  /** Copies every photo currently marked for the album straight into a folder the user already has. */
  async function handleCopyAlbumToExistingFolder() {
    if (albumUris.size === 0) return;
    const destUri = await pickFolder(lastFolderUri);
    if (!destUri) return;
    await runAlbumCopy(
      (photos, onProgress) => copyPhotosToFolder(photos, destUri, onProgress),
      'dans le dossier choisi'
    );
  }

  function toggleSecondaryAction(uri: string) {
    setSecondaryActionUris((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }

  /**
   * Replaces the whole secondary-action selection at once - used by
   * "moments"'s quick move/copy on photos already checked there, instead of
   * making her re-pick them one by one on the dedicated selection screen.
   */
  function seedSecondaryAction(uris: string[]) {
    setSecondaryActionUris(new Set(uris));
  }

  /**
   * Moves every photo currently marked in `secondaryActionUris` (either
   * flavor below), after confirming - unlike copying, this really does
   * remove them from where they currently are, so it needs the same "are
   * you sure" as jeter. Whichever ones actually moved get dropped from
   * every tracked list (hashedPhotos, momentGroups...), same as a jetée
   * photo, since their old URI is now gone; any that failed stay in place
   * to retry.
   */
  function confirmAndMoveToFolder(
    move: (
      photos: { uri: string; name: string }[],
      onProgress: (current: number, total: number) => void
    ) => Promise<{ movedUris: string[]; failedCount: number }>
  ) {
    const toMove = hashedPhotos.filter((p) => secondaryActionUris.has(p.uri));
    if (toMove.length === 0) return;
    Alert.alert(
      'Déplacer ces photos ?',
      `${toMove.length} photo${toMove.length > 1 ? 's' : ''} seront déplacées vers le dossier choisi - elles ne seront plus à leur emplacement actuel.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Déplacer',
          onPress: async () => {
            setSecondaryActionRunning(true);
            setSecondaryActionProgress({ current: 0, total: toMove.length });
            try {
              const { movedUris, failedCount } = await move(
                toMove.map((p) => ({ uri: p.uri, name: p.name })),
                (current, total) => setSecondaryActionProgress({ current, total })
              );
              const handledUris = new Set(movedUris);
              const remaining = hashedPhotos.filter((p) => !handledUris.has(p.uri));
              const prunedMomentGroups = momentGroups
                .map((g) => ({ ...g, photos: g.photos.filter((p) => !handledUris.has(p.uri)) }))
                .filter((g) => g.photos.length > 0);
              setHashedPhotos(remaining);
              setMomentGroups(prunedMomentGroups);
              setSecondaryActionUris((prev) => {
                const next = new Set(prev);
                handledUris.forEach((uri) => next.delete(uri));
                return next;
              });
              if (lastFolderUri) {
                await saveAnalysis({
                  folderUri: lastFolderUri,
                  similarityThreshold,
                  hashedPhotos: remaining,
                  reviewedGroupKeys: Array.from(reviewedGroupKeys),
                  mode,
                  momentGroups: prunedMomentGroups,
                });
              }
              if (failedCount === 0) {
                Alert.alert(
                  'Photos déplacées',
                  `${movedUris.length} photo${movedUris.length > 1 ? 's' : ''} déplacée${movedUris.length > 1 ? 's' : ''} vers le nouvel emplacement.`
                );
              } else {
                Alert.alert(
                  'Déplacement partiel',
                  `${movedUris.length} photo${movedUris.length > 1 ? 's' : ''} déplacée${movedUris.length > 1 ? 's' : ''}, mais ${failedCount} n'${failedCount > 1 ? 'ont' : 'a'} pas pu être déplacée${failedCount > 1 ? 's' : ''}. Réessaie pour celles qui restent.`
                );
              }
            } catch (error) {
              console.warn('Erreur déplacement de photos', error);
              Alert.alert('Un souci est survenu', "Je n'ai pas réussi à déplacer les photos. Réessaie.");
            } finally {
              setSecondaryActionRunning(false);
              setSecondaryActionProgress(null);
            }
          },
        },
      ]
    );
  }

  async function handleMoveToNewFolder(name: string) {
    if (secondaryActionUris.size === 0) return;
    const parentUri = await pickFolder(lastFolderUri);
    if (!parentUri) return;
    confirmAndMoveToFolder((photos, onProgress) =>
      movePhotosToNewFolder(photos, parentUri, name, onProgress)
    );
  }

  async function handleMoveToExistingFolder() {
    if (secondaryActionUris.size === 0) return;
    const destUri = await pickFolder(lastFolderUri);
    if (!destUri) return;
    confirmAndMoveToFolder((photos, onProgress) => movePhotosToFolder(photos, destUri, onProgress));
  }

  /**
   * Copies every photo currently marked in `secondaryActionUris` (either
   * flavor below) - same idea as the album's copy, just from the "•••" menu
   * instead of the dedicated album step, and using its own selection.
   * Always safe: the originals are never touched, so no confirmation needed.
   */
  async function runSecondaryCopy(
    copy: (
      photos: { uri: string; name: string }[],
      onProgress: (current: number, total: number) => void
    ) => Promise<{ copiedCount: number; failedCount: number }>,
    destinationLabel: string
  ) {
    const toExport = hashedPhotos.filter((p) => secondaryActionUris.has(p.uri));
    if (toExport.length === 0) return;
    setSecondaryActionRunning(true);
    setSecondaryActionProgress({ current: 0, total: toExport.length });
    try {
      const { copiedCount, failedCount } = await copy(
        toExport.map((p) => ({ uri: p.uri, name: p.name })),
        (current, total) => setSecondaryActionProgress({ current, total })
      );
      setSecondaryActionUris(new Set());
      if (failedCount === 0) {
        Alert.alert(
          'Photos copiées',
          `${copiedCount} photo${copiedCount > 1 ? 's' : ''} copiée${copiedCount > 1 ? 's' : ''} ${destinationLabel}. Tes photos d'origine n'ont pas bougé.`
        );
      } else {
        Alert.alert(
          'Copie partielle',
          `${copiedCount} photo${copiedCount > 1 ? 's' : ''} copiée${copiedCount > 1 ? 's' : ''}, mais ${failedCount} n'${failedCount > 1 ? 'ont' : 'a'} pas pu être copiée${failedCount > 1 ? 's' : ''}. Réessaie pour celles qui manquent.`
        );
      }
    } catch (error) {
      console.warn('Erreur copie de photos', error);
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à copier les photos. Réessaie.");
    } finally {
      setSecondaryActionRunning(false);
      setSecondaryActionProgress(null);
    }
  }

  async function handleCopySelectedToNewFolder(name: string) {
    if (secondaryActionUris.size === 0) return;
    const parentUri = await pickFolder(lastFolderUri);
    if (!parentUri) return;
    await runSecondaryCopy(
      (photos, onProgress) => copyPhotosToNewFolder(photos, parentUri, name, onProgress),
      `dans "${name}"`
    );
  }

  async function handleCopySelectedToExistingFolder() {
    if (secondaryActionUris.size === 0) return;
    const destUri = await pickFolder(lastFolderUri);
    if (!destUri) return;
    await runSecondaryCopy(
      (photos, onProgress) => copyPhotosToFolder(photos, destUri, onProgress),
      'dans le dossier choisi'
    );
  }

  /**
   * The three-way mark: keep, later, or trash - or 'undecided', which clears
   * all three (tapping the already-active button again used to leave no way
   * back to "not decided yet").
   */
  function setPhotoStatus(uri: string, status: 'keep' | 'later' | 'trash' | 'undecided') {
    setSelected((prev) => {
      const has = prev.has(uri);
      const shouldHave = status === 'trash';
      if (has === shouldHave) return prev;
      const next = new Set(prev);
      if (shouldHave) next.add(uri);
      else next.delete(uri);
      return next;
    });
    setLaterUris((prev) => {
      const has = prev.has(uri);
      const shouldHave = status === 'later';
      if (has === shouldHave) return prev;
      const next = new Set(prev);
      if (shouldHave) next.add(uri);
      else next.delete(uri);
      return next;
    });
    setKeptUris((prev) => {
      const has = prev.has(uri);
      const shouldHave = status === 'keep';
      if (has === shouldHave) return prev;
      const next = new Set(prev);
      if (shouldHave) next.add(uri);
      else next.delete(uri);
      return next;
    });
  }

  /**
   * Hand-editing for "moments": moves one or more photos out of whatever
   * group each is currently in and into `targetGroupId` (or, with 'new',
   * into a single brand new group together, placed right after the group
   * they were split out of - not at the end of the whole list, which would
   * make it hard to find - the same action covers both "these don't belong
   * with the rest of this moment" and "pull undated photos into the moment
   * they actually belong to", just picking a different target). A group
   * left empty by the move is dropped.
   */
  function moveMomentPhotos(photoUris: string[], targetGroupId: string | 'new') {
    const uriSet = new Set(photoUris);
    const sourceGroupId = momentGroups.find((g) => g.photos.some((p) => uriSet.has(p.uri)))?.id;

    const movedPhotos: HashedPhoto[] = [];
    const withoutPhotos: DuplicateGroup[] = [];
    // Where, within withoutPhotos, the source group ended up (or, if it was
    // emptied out entirely and dropped, where it *would* still be) - the
    // new split-off group is inserted right after this position.
    let insertAfterIndex = -1;

    for (const g of momentGroups) {
      const staying = g.photos.filter((p) => !uriSet.has(p.uri));
      const moving = g.photos.filter((p) => uriSet.has(p.uri));
      movedPhotos.push(...moving);
      if (staying.length > 0) {
        withoutPhotos.push({ ...g, photos: staying });
        if (g.id === sourceGroupId) insertAfterIndex = withoutPhotos.length - 1;
      } else if (g.id === sourceGroupId) {
        insertAfterIndex = withoutPhotos.length - 1;
      }
    }
    if (movedPhotos.length === 0) return;

    let next: DuplicateGroup[];
    if (targetGroupId === 'new') {
      const newGroup = { id: `moment-manual-${Date.now()}`, photos: movedPhotos };
      const insertAt = insertAfterIndex + 1;
      next = [...withoutPhotos.slice(0, insertAt), newGroup, ...withoutPhotos.slice(insertAt)];
    } else {
      next = withoutPhotos.map((g) =>
        g.id === targetGroupId ? { ...g, photos: [...g.photos, ...movedPhotos] } : g
      );
    }
    setMomentGroups(next);
    // Hand-edits like this one can't be recomputed from scratch on reopen
    // (unlike every other step's grouping) - has to be saved as-is or
    // they're gone the moment the app closes.
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold,
        hashedPhotos,
        reviewedGroupKeys: Array.from(reviewedGroupKeys),
        mode,
        momentGroups: next,
      });
    }
  }

  /** Nudges a "moments" group one spot up or down in the list, for easy manual reordering. */
  function moveMomentGroup(groupId: string, direction: 'up' | 'down') {
    const index = momentGroups.findIndex((g) => g.id === groupId);
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || swapWith < 0 || swapWith >= momentGroups.length) return;
    const next = [...momentGroups];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    setMomentGroups(next);
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold,
        hashedPhotos,
        reviewedGroupKeys: Array.from(reviewedGroupKeys),
        mode,
        momentGroups: next,
      });
    }
  }

  function commitMomentGroups(next: DuplicateGroup[]) {
    setMomentGroups(next);
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold,
        hashedPhotos,
        reviewedGroupKeys: Array.from(reviewedGroupKeys),
        mode,
        momentGroups: next,
      });
    }
  }

  /** Puts `photoUri` right before `beforeUri` within its moment (or at the very end with null) - a far move in one step instead of nudging one spot at a time. */
  function reorderMomentPhoto(groupId: string, photoUri: string, beforeUri: string | null) {
    const groupIndex = momentGroups.findIndex((g) => g.id === groupId);
    if (groupIndex === -1) return;
    const group = momentGroups[groupIndex];
    const moving = group.photos.find((p) => p.uri === photoUri);
    if (!moving) return;
    const rest = group.photos.filter((p) => p.uri !== photoUri);
    let insertAt = beforeUri === null ? rest.length : rest.findIndex((p) => p.uri === beforeUri);
    if (insertAt < 0) insertAt = rest.length;
    const photos = [...rest.slice(0, insertAt), moving, ...rest.slice(insertAt)];
    commitMomentGroups(momentGroups.map((g, i) => (i === groupIndex ? { ...g, photos } : g)));
  }

  /** Puts a moment right after `afterGroupId` (or at the very start / end) - no more climbing one spot at a time. */
  function moveMomentGroupTo(groupId: string, afterGroupId: string | 'start' | 'end') {
    const moving = momentGroups.find((g) => g.id === groupId);
    if (!moving) return;
    const rest = momentGroups.filter((g) => g.id !== groupId);
    let insertAt: number;
    if (afterGroupId === 'start') insertAt = 0;
    else if (afterGroupId === 'end') insertAt = rest.length;
    else {
      const anchor = rest.findIndex((g) => g.id === afterGroupId);
      if (anchor === -1) return;
      insertAt = anchor + 1;
    }
    commitMomentGroups([...rest.slice(0, insertAt), moving, ...rest.slice(insertAt)]);
  }

  /**
   * Puts similar photos side by side inside one moment (or every moment):
   * 'sort' keeps each moment whole but reorders it, 'split' cuts it into one
   * moment per set of similar photos. Uses the hashes every photo already
   * has, so it's instant - no new analysis of the pictures.
   */
  function regroupMomentsBySimilarity(scope: string | 'all', percent: number, how: 'sort' | 'split') {
    const threshold = percentToThreshold(percent);
    const affected = momentGroups.filter((g) => scope === 'all' || g.id === scope);
    const similarSets = affected.reduce(
      (n, g) => n + clusterBySimilarity(g.photos, threshold).filter((c) => c.length >= 2).length,
      0
    );
    if (similarSets === 0) {
      Alert.alert(
        'Rien à regrouper',
        'Aucune photo ne se ressemble assez à ce niveau. Baisse le curseur pour être moins exigeante.'
      );
      return;
    }
    const next: DuplicateGroup[] = [];
    let counter = 0;
    for (const g of momentGroups) {
      if (scope !== 'all' && g.id !== scope) {
        next.push(g);
      } else if (how === 'sort') {
        next.push({ ...g, photos: sortBySimilarity(g.photos, threshold) });
      } else {
        splitBySimilarity(g.photos, threshold).forEach((photos, i) => {
          next.push({
            id: i === 0 ? g.id : `moment-split-${Date.now()}-${counter++}`,
            photos,
          });
        });
      }
    }
    commitMomentGroups(next);
  }

  /** ♥ favorite: also ticks (or unticks) it for the album, so it's already selected there. */
  function toggleFavorite(uri: string) {
    const willBeFavorite = !favoriteUris.has(uri);
    setFavoriteUris((prev) => {
      const next = new Set(prev);
      if (willBeFavorite) next.add(uri);
      else next.delete(uri);
      return next;
    });
    setAlbumUris((prev) => {
      const next = new Set(prev);
      if (willBeFavorite) next.add(uri);
      else next.delete(uri);
      return next;
    });
  }

  /**
   * Jette a specific set of photos, regardless of whether they're marked in
   * `selected` - used both for the ❤️/🕐/🗑-marked ones (handleDeleteSelected)
   * and for "moments"'s checkbox multi-select, which is a separate selection
   * concept (used for moving between groups) that Flavie also wanted usable
   * to jeter directly, without first re-marking each photo one by one.
   */
  async function deletePhotos(uris: string[]) {
    const uriSet = new Set(uris);
    // Looked up from every analyzed photo, not just `groups` - a selected
    // photo may only exist in the flat "photos floues" list, with no
    // duplicate group of its own.
    const toDelete = hashedPhotos.filter((p) => uriSet.has(p.uri));
    if (toDelete.length === 0) return;

    Alert.alert(
      'Jeter ces photos ?',
      `${toDelete.length} photo${toDelete.length > 1 ? 's' : ''} seront retirées de leur dossier et rangées dans la corbeille de l'appli. Rien n'est supprimé pour de bon, tu pourras les récupérer.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Jeter',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              // One photo at a time, each with its own try/catch: a photo
              // deleted by the user directly in their gallery (outside the
              // app) in the meantime has nothing left to move - that alone
              // shouldn't stop the rest of the batch from being jetées.
              const handledUris = new Set<string>();
              let failedCount = 0;
              for (const photo of toDelete) {
                try {
                  const info = await FileSystem.getInfoAsync(photo.uri);
                  if (!info.exists) {
                    // Already gone (deleted elsewhere) - nothing to move,
                    // just stop tracking it like the others.
                    handledUris.add(photo.uri);
                    continue;
                  }
                  await moveToTrash({
                    uri: photo.uri,
                    name: photo.name,
                    folderPath: photo.folderPath,
                  });
                  handledUris.add(photo.uri);
                } catch (error) {
                  console.warn('Erreur déplacement corbeille', error);
                  failedCount += 1;
                }
              }
              const remaining = hashedPhotos.filter((p) => !handledUris.has(p.uri));
              // A jetée photo still sitting in a "moments" group would show
              // as a broken thumbnail there (its file has really moved) -
              // drop it from wherever it was, same as from hashedPhotos.
              const prunedMomentGroups = momentGroups
                .map((g) => ({ ...g, photos: g.photos.filter((p) => !handledUris.has(p.uri)) }))
                .filter((g) => g.photos.length > 0);
              // A group's "reviewed" mark is keyed by its exact photo
              // content (see groupKey) - jeter one of its photos changes
              // that content, so the mark would otherwise stop matching and
              // the group would look unreviewed again even though nothing
              // about the review itself changed (confirmed by Flavie: a
              // group she'd marked "vu" reappeared the moment she actually
              // jetait the photos in it). Carrying the mark forward to the
              // group's new (smaller) key keeps it "vu" through that shrink.
              const migratedReviewedKeys = new Set(reviewedGroupKeys);
              groups.forEach((g) => {
                if (!reviewedGroupKeys.has(groupKey(g))) return;
                const stillThere = g.photos.filter((p) => !handledUris.has(p.uri));
                if (stillThere.length > 0 && stillThere.length < g.photos.length) {
                  migratedReviewedKeys.add(groupKey({ ...g, photos: stillThere }));
                }
              });
              setHashedPhotos(remaining);
              setMomentGroups(prunedMomentGroups);
              setReviewedGroupKeys(migratedReviewedKeys);
              setSelected((prev) => {
                const next = new Set(prev);
                handledUris.forEach((uri) => next.delete(uri));
                return next;
              });
              await refreshTrash();
              if (lastFolderUri) {
                await saveAnalysis({
                  folderUri: lastFolderUri,
                  similarityThreshold,
                  hashedPhotos: remaining,
                  reviewedGroupKeys: Array.from(migratedReviewedKeys),
                  mode,
                  momentGroups: prunedMomentGroups,
                });
              }
              if (failedCount > 0) {
                Alert.alert(
                  'Un souci est survenu',
                  `${failedCount} photo${failedCount > 1 ? 's' : ''} n'ont pas pu être mise${failedCount > 1 ? 's' : ''} de côté. Réessaie.`
                );
              }
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  function handleDeleteSelected() {
    deletePhotos(Array.from(selected));
  }

  const MISSING_SOURCE_MESSAGE =
    "Le fichier que l'appli avait mis de côté pour cette photo a disparu (par exemple si l'appli a été réinstallée entre-temps) - il n'y avait donc plus rien à ranger ni à restaurer, et elle a été retirée de la corbeille.";

  async function handleSetAsideOne(id: string) {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier ranger cette photo.");
      return;
    }
    const result = await moveOneToSetAside(id, lastFolderUri);
    await refreshTrash();
    if (result === 'missing') {
      Alert.alert('Photo introuvable', MISSING_SOURCE_MESSAGE);
    } else if (result === 'failed') {
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à ranger cette photo. Réessaie.");
    }
  }

  async function handleSetAsideAll() {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier ranger ces photos.");
      return;
    }
    const before = trashEntries.length;
    setMovingProgress({ current: 0, total: before });
    const { movedCount, missingCount } = await moveAllToSetAside(lastFolderUri, (current, total) =>
      setMovingProgress({ current, total })
    );
    setMovingProgress(null);
    await refreshTrash();
    const stillStuck = before - movedCount - missingCount;
    if (missingCount > 0) {
      Alert.alert(
        'Certaines photos étaient introuvables',
        `${missingCount} photo${missingCount > 1 ? 's' : ''} n'avaient plus de fichier retrouvable et ${missingCount > 1 ? 'ont' : 'a'} été retirée${missingCount > 1 ? 's' : ''} de la corbeille.` +
          (stillStuck > 0
            ? ` ${stillStuck} autre${stillStuck > 1 ? 's' : ''} n'ont pas pu être rangée${stillStuck > 1 ? 's' : ''} et restent dans la corbeille. Réessaie.`
            : '')
      );
    } else if (stillStuck > 0) {
      Alert.alert(
        'Un souci est survenu',
        `${stillStuck} sur ${before} n'ont pas pu être rangées et restent dans la corbeille. Réessaie.`
      );
    }
  }

  async function handleRestoreOne(id: string) {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier restaurer cette photo.");
      return;
    }
    const result = await restoreOne(id, lastFolderUri);
    await refreshTrash();
    if (result === 'missing') {
      Alert.alert('Photo introuvable', MISSING_SOURCE_MESSAGE);
    } else if (result === 'failed') {
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à restaurer cette photo. Réessaie.");
    }
  }

  async function handleRestoreAll() {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier restaurer ces photos.");
      return;
    }
    const before = trashEntries.length;
    setMovingProgress({ current: 0, total: before });
    const { movedCount, missingCount } = await restoreAll(lastFolderUri, (current, total) =>
      setMovingProgress({ current, total })
    );
    setMovingProgress(null);
    await refreshTrash();
    const stillStuck = before - movedCount - missingCount;
    if (missingCount > 0) {
      Alert.alert(
        'Certaines photos étaient introuvables',
        `${missingCount} photo${missingCount > 1 ? 's' : ''} n'avaient plus de fichier retrouvable et ${missingCount > 1 ? 'ont' : 'a'} été retirée${missingCount > 1 ? 's' : ''} de la corbeille.` +
          (stillStuck > 0
            ? ` ${stillStuck} autre${stillStuck > 1 ? 's' : ''} n'ont pas pu être restaurée${stillStuck > 1 ? 's' : ''} et restent dans la corbeille. Réessaie.`
            : '')
      );
    } else if (stillStuck > 0) {
      Alert.alert(
        'Un souci est survenu',
        `${stillStuck} sur ${before} n'ont pas pu être restaurées et restent dans la corbeille. Réessaie.`
      );
    }
  }

  return (
    <SafeAreaProvider>
      <SafeContent>
        <StatusBar style="dark" />
        {/*
          Only mounted while actually scanning: this WebView, even hidden,
          was found to break the layout of other screens on some Android
          devices (content squeezed into the bottom of the screen).
        */}
        {screen === 'scanning' && <HashWorker ref={hashWorkerRef} />}

        {screen === 'home' && (
          <HomeScreen
            hasLastFolder={!!lastFolderUri}
            trashCount={trashEntries.length}
            trashReminder={trashReminder}
            onPickFolder={handlePickFolder}
            onRescanLastFolder={handleRescanLastFolder}
            onOpenTrash={() => setScreen('trash')}
          />
        )}

        {screen === 'subfolders' && (
          <SubfolderPickerScreen
            subfolders={subfolderOptions}
            onConfirm={handleConfirmSubfolders}
            onCancel={handleCancelSubfolders}
          />
        )}

        {screen === 'scanning' && <ScanningScreen status={scanStatus} />}

        {screen === 'results' && (
          <ResultsScreen
            mode={mode}
            photoCount={hashedPhotos.length}
            allPhotos={hashedPhotos}
            groups={groups}
            selected={selected}
            laterUris={laterUris}
            keptUris={keptUris}
            onSetPhotoStatus={setPhotoStatus}
            deleting={deleting}
            similarityThreshold={similarityThreshold}
            trashCount={trashEntries.length}
            trashReminder={trashReminder}
            reviewedGroupKeys={reviewedGroupKeys}
            onChangeSimilarity={handleChangeSimilarity}
            onToggleSelect={toggleSelect}
            onSelectExceptBest={selectExceptBest}
            onMarkGroupReviewed={markGroupReviewed}
            onDeleteSelected={handleDeleteSelected}
            onDeleteUris={deletePhotos}
            onBack={() => setScreen('home')}
            onOpenTrash={() => setScreen('trash')}
            onSwitchMode={switchMode}
            onFinishSorting={handleFinishSorting}
            faceModelDiagnostic={faceModelDiagnostic}
            onMoveMomentPhotos={moveMomentPhotos}
            onMoveMomentGroup={moveMomentGroup}
            onReorderMomentPhoto={reorderMomentPhoto}
            onMoveMomentGroupTo={moveMomentGroupTo}
            onRegroupBySimilarity={regroupMomentsBySimilarity}
            favoriteUris={favoriteUris}
            onToggleFavorite={toggleFavorite}
            momentGroups={momentGroups}
            albumUris={albumUris}
            onToggleAlbum={toggleAlbum}
            albumExporting={albumExporting}
            albumExportProgress={albumExportProgress}
            onCreateAlbum={handleCreateAlbum}
            onCopyToExistingFolder={handleCopyAlbumToExistingFolder}
            secondaryActionUris={secondaryActionUris}
            onToggleSecondaryAction={toggleSecondaryAction}
            secondaryActionRunning={secondaryActionRunning}
            secondaryActionProgress={secondaryActionProgress}
            onMoveToNewFolder={handleMoveToNewFolder}
            onMoveToExistingFolder={handleMoveToExistingFolder}
            onCopySelectedToNewFolder={handleCopySelectedToNewFolder}
            onCopySelectedToExistingFolder={handleCopySelectedToExistingFolder}
            onSeedSecondaryAction={seedSecondaryAction}
          />
        )}

        {screen === 'trash' && (
          <TrashScreen
            entries={trashEntries}
            onSetAsideOne={handleSetAsideOne}
            onSetAsideAll={handleSetAsideAll}
            onRestoreOne={handleRestoreOne}
            onRestoreAll={handleRestoreAll}
            onBack={() => setScreen(hashedPhotos.length > 0 ? 'results' : 'home')}
            movingProgress={movingProgress}
          />
        )}
      </SafeContent>
    </SafeAreaProvider>
  );
}

/**
 * Applies the device's safe-area insets as padding, clamped to a sane max.
 * Some Android devices/setups report wildly oversized insets (e.g. the
 * height of the whole screen) - clamping avoids losing most of the screen
 * to padding when that happens, while still avoiding real notches/bars.
 */
function SafeContent({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.safeArea,
        {
          paddingTop: Math.min(insets.top, 60),
          paddingBottom: Math.min(insets.bottom, 40),
          paddingLeft: Math.min(insets.left, 40),
          paddingRight: Math.min(insets.right, 40),
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
