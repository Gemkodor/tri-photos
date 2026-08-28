import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  hint: string;
  existingFolderLabel: string;
  newFolderPlaceholder: string;
  newFolderButtonLabel: string;
  onChooseExisting: () => void;
  onCreateNew: (name: string) => void;
};

/**
 * "Where should these photos go?" - a choice between an existing folder
 * (picked with the native folder chooser, nothing else needed) or a new,
 * named one (picked the same way once a name is typed here). Shared by the
 * album's "copy" flow and the "déplacer vers un dossier" secondary action -
 * same two-choice shape, only the wording and what actually happens differ.
 */
export default function FolderDestinationModal({
  visible,
  onClose,
  title,
  hint,
  existingFolderLabel,
  newFolderPlaceholder,
  newFolderButtonLabel,
  onChooseExisting,
  onCreateNew,
}: Props) {
  const [name, setName] = useState('');

  function close() {
    setName('');
    onClose();
  }

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.hint}>{hint}</Text>

          <Pressable
            style={styles.actionButton}
            onPress={() => {
              close();
              onChooseExisting();
            }}
          >
            <Text style={styles.actionButtonText}>{existingFolderLabel}</Text>
          </Pressable>

          <Text style={styles.orDivider}>ou</Text>

          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={setName}
            placeholder={newFolderPlaceholder}
            placeholderTextColor={colors.subtleText}
          />
          <Pressable
            style={[styles.actionButton, !name.trim() && styles.actionButtonDisabled]}
            disabled={!name.trim()}
            onPress={() => {
              const trimmed = name.trim();
              setName('');
              onClose();
              onCreateNew(trimmed);
            }}
          >
            <Text style={styles.actionButtonText}>{newFolderButtonLabel}</Text>
          </Pressable>

          <Pressable style={styles.cancel} onPress={close}>
            <Text style={styles.cancelText}>Annuler</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 20,
    width: '100%',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  hint: {
    fontSize: 12,
    color: colors.subtleText,
    lineHeight: 17,
    marginBottom: 16,
  },
  actionButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  actionButtonDisabled: {
    backgroundColor: colors.border,
  },
  actionButtonText: {
    color: colors.primaryText,
    fontSize: 16,
    fontWeight: '600',
  },
  orDivider: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: colors.subtleText,
    marginVertical: 14,
  },
  nameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
    marginBottom: 10,
  },
  cancel: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 8,
  },
  cancelText: {
    color: colors.subtleText,
    fontSize: 14,
    fontWeight: '600',
  },
});
