import { Image } from 'expo-image';
import React, { useRef, useState } from 'react';
import {
  Dimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { formatBytes } from '../lib/format';
import type { HashedPhoto } from '../lib/perceptualHash';
import { colors } from '../theme';

type Props = {
  photos: HashedPhoto[];
  initialIndex: number;
  selected: Set<string>;
  onToggleSelect: (uri: string) => void;
  onClose: () => void;
  /** Whether this photo set is a group with a star/reviewed concept, or a
   *  flat, unrelated list (e.g. all blurry photos) where those don't apply. */
  showGroupControls: boolean;
  groupLabel: string;
  starReason: string;
  blurryUris: Set<string>;
  isGroupReviewed: boolean;
  onMarkGroupReviewed: () => void;
  hasPrevGroup: boolean;
  hasNextGroup: boolean;
  onPrevGroup: () => void;
  onNextGroup: () => void;
};

export default function PhotoViewer({
  photos,
  initialIndex,
  selected,
  onToggleSelect,
  onClose,
  showGroupControls,
  groupLabel,
  starReason,
  blurryUris,
  isGroupReviewed,
  onMarkGroupReviewed,
  hasPrevGroup,
  hasNextGroup,
  onPrevGroup,
  onNextGroup,
}: Props) {
  const { width } = Dimensions.get('window');
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(initialIndex);

  function handleScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  }

  function goTo(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= photos.length) return;
    scrollRef.current?.scrollTo({ x: nextIndex * width, animated: true });
    setIndex(nextIndex);
  }

  const photo = photos[index];
  const isSelected = selected.has(photo.uri);
  const isBlurry = blurryUris.has(photo.uri);

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>✕</Text>
        </Pressable>
        {showGroupControls ? (
          <>
            <View style={styles.groupNavRow}>
              <Pressable onPress={onPrevGroup} disabled={!hasPrevGroup} hitSlop={10}>
                <Text
                  style={[styles.groupNavArrow, !hasPrevGroup && styles.navButtonTextDisabled]}
                >
                  ‹
                </Text>
              </Pressable>
              <Text style={styles.groupLabelText}>{groupLabel}</Text>
              <Pressable onPress={onNextGroup} disabled={!hasNextGroup} hitSlop={10}>
                <Text
                  style={[styles.groupNavArrow, !hasNextGroup && styles.navButtonTextDisabled]}
                >
                  ›
                </Text>
              </Pressable>
            </View>
            <View style={styles.closeButtonSpacer} />
          </>
        ) : (
          <Text style={styles.groupLabelText}>{groupLabel}</Text>
        )}
      </View>
      <Text style={styles.counter}>
        Photo {index + 1} / {photos.length}
      </Text>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScrollEnd}
        contentOffset={{ x: initialIndex * width, y: 0 }}
        style={styles.pager}
      >
        {photos.map((p) => (
          <View key={p.uri} style={[styles.page, { width }]}>
            <Image
              source={{ uri: p.uri }}
              recyclingKey={p.uri}
              style={styles.fullImage}
              contentFit="contain"
            />
          </View>
        ))}
      </ScrollView>

      {photos.length > 1 && (
        <>
          <Pressable
            style={[styles.navButton, styles.navButtonLeft]}
            onPress={() => goTo(index - 1)}
            disabled={index === 0}
            hitSlop={8}
          >
            <Text style={[styles.navButtonText, index === 0 && styles.navButtonTextDisabled]}>‹</Text>
          </Pressable>
          <Pressable
            style={[styles.navButton, styles.navButtonRight]}
            onPress={() => goTo(index + 1)}
            disabled={index === photos.length - 1}
            hitSlop={8}
          >
            <Text
              style={[styles.navButtonText, index === photos.length - 1 && styles.navButtonTextDisabled]}
            >
              ›
            </Text>
          </Pressable>
        </>
      )}

      <View style={styles.infoPanel}>
        {showGroupControls && index === 0 && <Text style={styles.starReason}>★ {starReason}</Text>}
        {isBlurry && <Text style={styles.blurReason}>🌫 Cette photo semble floue.</Text>}
        <Text style={styles.infoLine} numberOfLines={1}>
          {photo.name}
        </Text>
        <View style={styles.infoRow}>
          {photo.folderPath ? (
            <Text style={styles.infoDetail} numberOfLines={1}>
              📁 {photo.folderPath}
            </Text>
          ) : null}
          {photo.width && photo.height ? (
            <Text style={styles.infoDetail}>
              🖼 {photo.width} × {photo.height}
            </Text>
          ) : null}
          {photo.sizeBytes != null ? (
            <Text style={styles.infoDetail}>💾 {formatBytes(photo.sizeBytes)}</Text>
          ) : null}
          <Text style={styles.infoDetail}>
            🔎 netteté : {Math.round(photo.sharpness)} ({photo.facesFound ? 'visage' : 'photo'})
          </Text>
        </View>
      </View>

      <View style={styles.bottomBar}>
        <Pressable
          style={[styles.trashToggle, isSelected && styles.trashToggleActive]}
          onPress={() => onToggleSelect(photo.uri)}
        >
          <Text style={styles.trashToggleText}>
            {isSelected ? '🗑 Cette photo ira à la corbeille' : 'Jeter cette photo'}
          </Text>
        </Pressable>
        {showGroupControls && (
          <Pressable
            style={[styles.markReviewedButton, isGroupReviewed && styles.markReviewedButtonDone]}
            onPress={onMarkGroupReviewed}
            disabled={isGroupReviewed}
          >
            <Text style={styles.markReviewedButtonText}>
              {isGroupReviewed ? '✓ Groupe déjà marqué comme vu' : '✓ Marquer ce groupe comme vu'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  closeButtonSpacer: {
    width: 36,
  },
  groupNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupNavArrow: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
    paddingHorizontal: 10,
  },
  groupLabelText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    minWidth: 90,
    textAlign: 'center',
  },
  counter: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 2,
  },
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  navButton: {
    position: 'absolute',
    top: '45%',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonLeft: {
    left: 12,
  },
  navButtonRight: {
    right: 12,
  },
  navButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
  },
  navButtonTextDisabled: {
    opacity: 0.3,
  },
  infoPanel: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  starReason: {
    color: colors.badge,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  blurReason: {
    color: '#B8B8C6',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  infoLine: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  infoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  infoDetail: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginRight: 14,
    marginBottom: 2,
  },
  bottomBar: {
    padding: 16,
    paddingBottom: 28,
  },
  trashToggle: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  trashToggleActive: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  trashToggleText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  markReviewedButton: {
    marginTop: 10,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  markReviewedButtonDone: {
    opacity: 0.5,
  },
  markReviewedButtonText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    fontWeight: '600',
  },
});
