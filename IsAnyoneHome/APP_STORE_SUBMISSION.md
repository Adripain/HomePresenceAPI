# Préparation App Store

Le nom affiché actuel est **Présence**. Avant de créer la fiche, vérifiez que le
nom est disponible et distinctif. Ne mettez pas de noms, logos, captures d’écran
ou mots-clés de fabricants tiers dans la fiche.

## Informations à renseigner dans App Store Connect

- Une URL publique de politique de confidentialité est obligatoire. Elle doit
  décrire les domiciles, les états arrivée/départ, la durée de conservation,
  l’hébergeur, le contact, et la suppression de compte dans l’app.
- Déclarez au minimum les données liées au compte nécessaires à la fonctionnalité
  : **Identifiant utilisateur**, **Nom** (si reçu), **Localisation précise**
  (coordonnée du domicile et événements de présence). Indiquez « fonctionnalité
  de l’app » et **pas de suivi publicitaire**. Ajoutez les informations liées aux
  notifications si vous activez les alertes à distance en production.
- Le manifeste `PrivacyInfo.xcprivacy` déclare l’usage local de `UserDefaults`;
  il ne remplace pas les réponses de confidentialité dans App Store Connect.
- Activez la capacité *Sign in with Apple* pour l’identifiant de bundle de la
  cible et renseignez le même identifiant dans `APPLE_CLIENT_ID` côté serveur.

## Notes de revue à copier et adapter

> L’app permet à des membres invités de créer des zones de domicile et de lancer
> des automatisations personnelles dans Raccourcis à l’arrivée ou au départ. Le
> compte se crée avec « Se
> connecter avec Apple ». La position « Toujours » est demandée uniquement après
> explication dans l’app, afin de détecter les changements de zone en arrière-plan.
> Les notifications d’arrivée, de départ et de domicile vide sont facultatives et
> explicitement activées par chaque membre. La suppression de compte est disponible
> dans le menu (…) de l’écran principal.

## Vérifications avant l’envoi

- Remplacer `https://api.example.com` dans `Info.plist` par le domaine HTTPS réel.
- Vérifier une arrivée, un départ, une absence de réseau courte, l’invitation, la
  suppression du compte, le widget et les notifications sur un iPhone physique.
- Ne pas envoyer un compte de test, un mot de passe ou une clé de chiffrement dans
  les captures ou les notes de revue.
