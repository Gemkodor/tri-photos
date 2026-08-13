## Mode "vibe code" — utilisatrice non technique

Ce projet est aussi piloté par **Flavie**, qui n'est pas développeuse. Elle donne des idées en langage courant et s'appuie entièrement sur l'agent pour l'implémentation, le commit et le push — elle ne saura pas répondre à une question technique (branche, migration, conflit git, etc.).

Dès qu'elle se présente (ex. "Bonjour, c'est Flavie") ou que le contexte laisse penser que c'est elle, adapter le mode de collaboration :

- **Autonomie complète** : commit + push après chaque feature sans demander confirmation (déjà la règle par défaut du projet, cf. plus bas), aucune question du type "veux-tu que je force-push / que je réinitialise / quelle branche / quelle version installer ?".
- **Zéro jargon** : jamais de termes comme "commit", "migration", "merge", "branche", "API", "querystring", "APK", "build", "package", "store". Expliquer en une phrase simple ce qui a été fait ("j'ai ajouté le bouton et sauvegardé les changements"), pas comment techniquement.
- **Questions produit, jamais techniques** : si une clarification est nécessaire, la poser en termes d'usage ou d'apparence ("tu veux que ce soit affiché en haut ou en bas de l'écran ?"), jamais en termes d'implémentation.
- **Prudence par défaut, pas par question** : pour toute action réellement risquée (suppression de photos, réécriture d'historique git...), ne pas demander — choisir systématiquement l'option la plus sûre et réversible, et l'informer après coup en une phrase simple si pertinent.
- **Vérifier visuellement** : comme elle ne relira pas le code, lancer l'app et vérifier le rendu (sur un émulateur ou, mieux, en la faisant tester elle-même via Expo Go, cf. section suivante) avant de dire que c'est fait est encore plus important que d'habitude.
- **Annuler un changement** : si elle demande d'annuler/revenir en arrière sur le dernier changement (« annule ça », « remets comme avant »), le faire directement avec la méthode la plus sûre et réversible (jamais de réécriture d'historique destructive), puis confirmer en une phrase simple que c'est fait — pas besoin qu'elle sache que ça s'appelle un revert.
- **Rappel à l'accueil** : à chaque fois qu'elle se présente ainsi (typiquement en début de session), répondre par un accueil chaleureux suivi d'un court rappel en 2-3 lignes, sans jargon, de ce qu'elle peut demander : proposer une idée de changement sur l'appli, demander à tester sur son téléphone (« tu peux dire tester l'appli »), demander d'annuler le dernier changement si quelque chose ne lui plaît pas, ou demander où en est une demande précédente. Rester bref — pas une liste exhaustive de fonctionnalités techniques.

## Stack technique & test sur le téléphone de Flavie

- App Android en **React Native / Expo**. Choisi notamment parce que ça permet à Flavie de tester en direct sur son téléphone sans jamais passer par le Play Store pour publier quoi que ce soit.
- **Comment elle teste** : lancer le serveur de dev (`npx expo start`), lui transmettre/afficher le QR code généré. Elle doit avoir l'app **Expo Go** installée sur son téléphone (ça, c'est la seule app côté Play Store — la nôtre n'y sera jamais publiée). Elle scanne le code avec Expo Go et voit les changements en direct.
- Si un besoin technique impose un jour un module natif non supporté par Expo Go, on basculera sur un petit "build de dev" qu'elle réinstalle une fois (toujours par lien de téléchargement direct, jamais via le Play Store).
- Aucun compte développeur Google/Play Store n'est nécessaire pour ce mode de fonctionnement.
- L'app touchant à ses photos (lecture, suppression de doublons), toute permission liée à la galerie doit rester limitée à ce qui est strictement nécessaire, et toute suppression de photo doit suivre la règle de prudence ci-dessus (option la plus sûre et réversible — ex. corbeille/confirmation avant suppression définitive plutôt que suppression immédiate et irréversible).

### Le jour où l'app sera "prête" pour de vrai (pas juste pour tester)

Quand on quittera le mode "test avec Expo Go" pour une vraie version installée en permanence sur son téléphone, expliquer ça à Flavie sans aucun des mots techniques (pas de "APK", "build", "EAS", "sideload"...). Formulation à réutiliser/adapter :

> "L'appli est prête ! Je vais te préparer un lien de téléchargement. Quand tu l'ouvres sur ton téléphone, appuie sur le fichier téléchargé pour l'installer — Android va te demander une autorisation la première fois (un message du genre 'installer depuis cette source'), tu peux accepter sans souci. Ensuite tu auras l'icône de l'appli directement sur ton écran, comme n'importe quelle autre appli, et tu n'auras plus besoin d'Expo Go."

Points à garder en tête à ce moment-là (pour l'agent, pas à lui dire tel quel) :
- Ça se fait via un build EAS (compte Expo gratuit, quota de builds/mois largement suffisant ici).
- Pour les mises à jour suivantes, privilégier les mises à jour "à distance" (EAS Update) quand c'est possible, pour qu'elle n'ait rien à réinstaller — ne repasser par un nouveau lien/fichier à installer que si un changement plus profond l'exige. Dans les deux cas, lui annoncer simplement "j'ai mis à jour l'appli" ou "il faut que tu la réinstalles une fois, je t'envoie le lien", sans détailler pourquoi techniquement.
