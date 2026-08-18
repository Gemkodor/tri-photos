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
  groupDuplicates,
  groupKey,
  SORT_STEPS,
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
  const [mode, setMode] = useState<SortMode>('duplicates');
  const [similarityThreshold, setSimilarityThreshold] = useState(
    SORT_STEPS.duplicates.defaultThreshold
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [reviewedGroupKeys, setReviewedGroupKeys] = useState<Set<string>>(new Set());

  const hashWorkerRef = useRef<HashWorkerHandle>(null);

  const groups = useMemo(
    () => groupDuplicates(hashedPhotos, similarityThreshold),
    [hashedPhotos, similarityThreshold]
  );

  const trashReminder = useMemo(() => getTrashReminder(trashEntries), [trashEntries]);

  useEffect(() => {
    getLastFolderUri().then(setLastFolderUriState);
    refreshTrash();
    getSavedAnalysis().then((saved) => {
      if (saved && saved.hashedPhotos.length > 0) {
        setHashedPhotos(saved.hashedPhotos);
        setSimilarityThreshold(saved.similarityThreshold);
        setReviewedGroupKeys(new Set(saved.reviewedGroupKeys ?? []));
        setMode(saved.mode ?? 'duplicates');
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
        const { photo, error } = await hashPhoto(images[i], worker);
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
      setHashedPhotos(hashed);
      setMode(forMode);
      setSimilarityThreshold(threshold);
      setSelected(new Set());
      setReviewedGroupKeys(new Set());
      setScreen('results');
      await saveAnalysis({
        folderUri,
        similarityThreshold: threshold,
        hashedPhotos: hashed,
        reviewedGroupKeys: [],
        mode: forMode,
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
      });
    }
  }

  function switchMode(newMode: SortMode) {
    const threshold = SORT_STEPS[newMode].defaultThreshold;
    setMode(newMode);
    setSimilarityThreshold(threshold);
    setSelected(new Set());
    setReviewedGroupKeys(new Set());
    if (lastFolderUri) {
      saveAnalysis({
        folderUri: lastFolderUri,
        similarityThreshold: threshold,
        hashedPhotos,
        reviewedGroupKeys: [],
        mode: newMode,
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
  }

  function selectExceptBest(uris: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      uris.forEach((uri) => next.add(uri));
      return next;
    });
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
              for (const photo of toDelete) {
                await moveToTrash({
                  uri: photo.uri,
                  name: photo.name,
                  folderPath: photo.folderPath,
                });
              }
              const deletedUris = new Set(toDelete.map((p) => p.uri));
              const remaining = hashedPhotos.filter((p) => !deletedUris.has(p.uri));
              setHashedPhotos(remaining);
              setSelected(new Set());
              await refreshTrash();
              if (lastFolderUri) {
                await saveAnalysis({
                  folderUri: lastFolderUri,
                  similarityThreshold,
                  hashedPhotos: remaining,
                  reviewedGroupKeys: Array.from(reviewedGroupKeys),
                  mode,
                });
              }
            } catch (error) {
              console.warn('Erreur déplacement corbeille', error);
              Alert.alert(
                'Un souci est survenu',
                "Certaines photos n'ont pas pu être mises de côté."
              );
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  async function handleSetAsideOne(id: string) {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier ranger cette photo.");
      return;
    }
    const ok = await moveOneToSetAside(id, lastFolderUri);
    await refreshTrash();
    if (!ok) {
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à ranger cette photo. Réessaie.");
    }
  }

  async function handleSetAsideAll() {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier ranger ces photos.");
      return;
    }
    const before = trashEntries.length;
    const { movedCount } = await moveAllToSetAside(lastFolderUri);
    await refreshTrash();
    if (movedCount < before) {
      Alert.alert(
        'Un souci est survenu',
        `${before - movedCount} sur ${before} n'ont pas pu être rangées et restent dans la corbeille. Réessaie.`
      );
    }
  }

  async function handleRestoreOne(id: string) {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier restaurer cette photo.");
      return;
    }
    const ok = await restoreOne(id, lastFolderUri);
    await refreshTrash();
    if (!ok) {
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à restaurer cette photo. Réessaie.");
    }
  }

  async function handleRestoreAll() {
    if (!lastFolderUri) {
      Alert.alert('Un souci est survenu', "Je ne sais pas dans quel dossier restaurer ces photos.");
      return;
    }
    const before = trashEntries.length;
    const { movedCount } = await restoreAll(lastFolderUri);
    await refreshTrash();
    if (movedCount < before) {
      Alert.alert(
        'Un souci est survenu',
        `${before - movedCount} sur ${before} n'ont pas pu être restaurées et restent dans la corbeille. Réessaie.`
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
