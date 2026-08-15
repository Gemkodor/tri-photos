import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import HashWorker, { HashWorkerHandle } from './src/components/HashWorker';
import { DEFAULT_SIMILARITY_THRESHOLD, groupDuplicates } from './src/lib/duplicateGroups';
import { pickFolder, scanFolderForImages } from './src/lib/imageFiles';
import { hashPhoto, type HashedPhoto } from './src/lib/perceptualHash';
import {
  emptyTrash,
  getLastFolderUri,
  getTrashEntries,
  moveToTrash,
  permanentlyDelete,
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
  const [similarityThreshold, setSimilarityThreshold] = useState(DEFAULT_SIMILARITY_THRESHOLD);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);

  const hashWorkerRef = useRef<HashWorkerHandle>(null);

  const groups = useMemo(
    () => groupDuplicates(hashedPhotos, similarityThreshold),
    [hashedPhotos, similarityThreshold]
  );

  useEffect(() => {
    getLastFolderUri().then(setLastFolderUriState);
    refreshTrash();
  }, []);

  async function refreshTrash() {
    setTrashEntries(await getTrashEntries());
  }

  async function analyzeFolder(folderUri: string) {
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

      const hashed: HashedPhoto[] = [];
      for (let i = 0; i < images.length; i++) {
        const result = await hashPhoto(images[i], worker);
        if (result) hashed.push(result);
        setScanStatus({ phase: 'hashing', foundImages: images.length, hashedCount: i + 1 });
      }

      setHashedPhotos(hashed);
      setSimilarityThreshold(DEFAULT_SIMILARITY_THRESHOLD);
      setSelected(new Set());
      setScreen('results');
    } catch (error) {
      console.warn('Erreur pendant l’analyse', error);
      Alert.alert(
        'Un souci est survenu',
        "L'analyse du dossier s'est arrêtée en cours de route. Tu peux réessayer."
      );
      setScreen('home');
    }
  }

  async function handlePickFolder() {
    try {
      const folderUri = await pickFolder(lastFolderUri);
      if (!folderUri) return;
      await analyzeFolder(folderUri);
    } catch (error) {
      console.warn('Erreur choix dossier', error);
      Alert.alert('Un souci est survenu', "Je n'ai pas réussi à ouvrir ce dossier.");
    }
  }

  function handleRescanLastFolder() {
    if (lastFolderUri) analyzeFolder(lastFolderUri);
  }

  function handleChangeSimilarity(threshold: number) {
    setSimilarityThreshold(threshold);
    setSelected(new Set());
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

  async function handleDeleteSelected() {
    const toDelete = groups
      .flatMap((g) => g.photos)
      .filter((p) => selected.has(p.uri));
    if (toDelete.length === 0) return;

    Alert.alert(
      'Mettre ces photos de côté ?',
      `${toDelete.length} photo${toDelete.length > 1 ? 's' : ''} seront retirées de leur dossier et rangées dans la corbeille de l'appli. Rien n'est supprimé pour de bon.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Mettre de côté',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              for (const photo of toDelete) {
                await moveToTrash({ uri: photo.uri, name: photo.name });
              }
              const deletedUris = new Set(toDelete.map((p) => p.uri));
              setHashedPhotos((prev) => prev.filter((p) => !deletedUris.has(p.uri)));
              setSelected(new Set());
              await refreshTrash();
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

  async function handleDeleteTrashEntry(id: string) {
    await permanentlyDelete(id);
    await refreshTrash();
  }

  async function handleEmptyTrash() {
    await emptyTrash();
    await refreshTrash();
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      {/* Hidden worker that decodes tiny thumbnails to compute perceptual hashes. */}
      <HashWorker ref={hashWorkerRef} />

      {screen === 'home' && (
        <HomeScreen
          hasLastFolder={!!lastFolderUri}
          trashCount={trashEntries.length}
          onPickFolder={handlePickFolder}
          onRescanLastFolder={handleRescanLastFolder}
          onOpenTrash={() => setScreen('trash')}
        />
      )}

      {screen === 'scanning' && <ScanningScreen status={scanStatus} />}

      {screen === 'results' && (
        <ResultsScreen
          groups={groups}
          selected={selected}
          deleting={deleting}
          similarityThreshold={similarityThreshold}
          onChangeSimilarity={handleChangeSimilarity}
          onToggleSelect={toggleSelect}
          onDeleteSelected={handleDeleteSelected}
          onBack={() => setScreen('home')}
        />
      )}

      {screen === 'trash' && (
        <TrashScreen
          entries={trashEntries}
          onDeleteOne={handleDeleteTrashEntry}
          onEmptyAll={handleEmptyTrash}
          onBack={() => setScreen('home')}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
