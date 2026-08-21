import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import HashWorker, { HashWorkerHandle } from './src/components/HashWorker';
import { getSavedAnalysis, saveAnalysis } from './src/lib/analysisStorage';
import {
  startScanningService,
  stopScanningService,
  updateScanningProgress,
} from './src/lib/backgroundScan';
import {
  groupByMoments,
  groupDuplicates,
  groupKey,
  MOMENT_GAP_MS,
  SAME_SESSION_MAX_GAP_MS,
  SORT_STEP_ORDER,
  SORT_STEPS,
  type DuplicateGroup,
  type SortMode,
} from './src/lib/duplicateGroups';
import { pickFolder, scanFolderForImages } from './src/lib/imageFiles';
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
import TrashScreen from './src/screens/TrashScreen';
import { colors } from './src/theme';

type Screen = 'home' | 'scanning' | 'results' | 'trash';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [lastFolderUri, setLastFolderUriState] = useState<string | null>(null);
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
  // `selected` (poubelle) or in here (later), never both; neither means
  // "garder" (the default, nothing to do for those).
  const [laterUris, setLaterUris] = useState<Set<string>>(new Set());
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

  const hashWorkerRef = useRef<HashWorkerHandle>(null);

  const groups = useMemo(() => {
    if (mode === 'moments') return momentGroups;
    return groupDuplicates(
      hashedPhotos,
      similarityThreshold,
      // Every sorting-part step (similar/blurry/decide/later/final) shares
      // the one grouping "similar" produced, so the gate has to apply the
      // same way regardless of which of those is currently showing -
      // otherwise the very same two photos could count as grouped on one
      // step and not on another. Never applied to "duplicates" (a
      // separate part/threshold): a genuine exact copy's file name can
      // carry a copy/save time completely unrelated to the original shot.
      mode !== 'duplicates' ? SAME_SESSION_MAX_GAP_MS : undefined
    );
  }, [hashedPhotos, similarityThreshold, mode, momentGroups]);

  const trashReminder = useMemo(() => getTrashReminder(trashEntries), [trashEntries]);

  useEffect(() => {
    getLastFolderUri().then(setLastFolderUriState);
    refreshTrash();
    getSavedAnalysis().then((saved) => {
      if (saved && saved.hashedPhotos.length > 0) {
        setHashedPhotos(saved.hashedPhotos);
        setSimilarityThreshold(saved.similarityThreshold);
        setReviewedGroupKeys(new Set(saved.reviewedGroupKeys ?? []));
        // A save from an older version of the app could carry a step that
        // no longer exists (the sorting path has changed over time) - fall
        // back rather than restoring into a step the app can't render.
        const restoredMode = saved.mode && SORT_STEP_ORDER.includes(saved.mode) ? saved.mode : 'duplicates';
        setMode(restoredMode);
        setHasSharpness(restoredMode !== 'duplicates');
        // A save from before momentGroups was persisted (or the mode wasn't
        // "moments" at save time) has none - recompute fresh rather than
        // showing an empty "moments" step for no reason.
        setMomentGroups(
          saved.momentGroups ??
            (restoredMode === 'moments' ? groupByMoments(saved.hashedPhotos, MOMENT_GAP_MS) : [])
        );
        setScreen('results');
      }
    });
  }, []);

  async function refreshTrash() {
    setTrashEntries(await getTrashEntries());
  }

  async function analyzeFolder(folderUri: string, forMode: SortMode) {
    setScreen('scanning');
    setScanStatus({ phase: 'listing', foundImages: 0, hashedCount: 0 });

    try {
      const images = await scanFolderForImages(folderUri, (progress) => {
        setScanStatus({ phase: 'listing', foundImages: progress.foundImages, hashedCount: 0 });
      });

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

  async function handlePickFolder(forMode: SortMode) {
    const proceed = await resolveTrashPrompt('Avant de lancer une nouvelle analyse, que veux-tu en faire ?');
    if (!proceed) return;
    try {
      const folderUri = await pickFolder(lastFolderUri);
      if (!folderUri) return;
      await analyzeFolder(folderUri, forMode);
    } catch (error) {
      console.warn('Erreur choix dossier', error);
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à ouvrir ce dossier.");
    }
  }

  async function handleRescanLastFolder(forMode: SortMode) {
    const proceed = await resolveTrashPrompt('Avant de lancer une nouvelle analyse, que veux-tu en faire ?');
    if (!proceed || !lastFolderUri) return;
    analyzeFolder(lastFolderUri, forMode);
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

  /** The "decide" step's three-way mark: keep (the default, clears both), later, or trash. */
  function setPhotoStatus(uri: string, status: 'keep' | 'later' | 'trash') {
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
  }

  /**
   * Hand-editing for "moments": moves one or more photos out of whatever
   * group each is currently in and into `targetGroupId` (or, with 'new',
   * into a single brand new group together - the same action covers both
   * "these don't belong with the rest of this moment" and "pull undated
   * photos into the moment they actually belong to", just picking a
   * different target). A group left empty by the move is dropped.
   */
  function moveMomentPhotos(photoUris: string[], targetGroupId: string | 'new') {
    const uriSet = new Set(photoUris);
    const movedPhotos: HashedPhoto[] = [];
    const withoutPhotos = momentGroups
      .map((g) => {
        const [staying, moving] = [
          g.photos.filter((p) => !uriSet.has(p.uri)),
          g.photos.filter((p) => uriSet.has(p.uri)),
        ];
        movedPhotos.push(...moving);
        return { ...g, photos: staying };
      })
      .filter((g) => g.photos.length > 0);
    if (movedPhotos.length === 0) return;
    const next =
      targetGroupId === 'new'
        ? [...withoutPhotos, { id: `moment-manual-${Date.now()}`, photos: movedPhotos }]
        : withoutPhotos.map((g) =>
            g.id === targetGroupId ? { ...g, photos: [...g.photos, ...movedPhotos] } : g
          );
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

  async function handleDeleteSelected() {
    // Looked up from every analyzed photo, not just `groups` - a selected
    // photo may only exist in the flat "photos floues" list, with no
    // duplicate group of its own.
    const toDelete = hashedPhotos.filter((p) => selected.has(p.uri));
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
              setHashedPhotos(remaining);
              setMomentGroups(prunedMomentGroups);
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
                  reviewedGroupKeys: Array.from(reviewedGroupKeys),
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

        {screen === 'scanning' && <ScanningScreen status={scanStatus} />}

        {screen === 'results' && (
          <ResultsScreen
            mode={mode}
            photoCount={hashedPhotos.length}
            allPhotos={hashedPhotos}
            groups={groups}
            selected={selected}
            laterUris={laterUris}
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
            onBack={() => setScreen('home')}
            onOpenTrash={() => setScreen('trash')}
            onSwitchMode={switchMode}
            onFinishSorting={handleFinishSorting}
            faceModelDiagnostic={faceModelDiagnostic}
            onMoveMomentPhotos={moveMomentPhotos}
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
