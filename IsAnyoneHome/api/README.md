# API de présence — déploiement production

Cette API ne doit jamais être exposée telle quelle avec un mot de passe, une clé
ou une base de données de démonstration. Elle isole toutes les ressources par
utilisateur et par rôle dans le domicile (`owner`, `admin`, `member`). Les
positions des domiciles et les jetons de notifications sont chiffrés avec
AES-256-GCM avant leur insertion dans PostgreSQL.

## Prérequis OVH

- Un sous-domaine dédié, par exemple `api.votre-domaine.tld`, avec un certificat
  TLS valide.
- PostgreSQL 16+ sur un réseau privé, sans port 5432 ouvert à Internet. Le
  fichier Compose inclus le lance dans un volume Docker privé.
- Docker Compose. L’API publiée par Compose écoute uniquement sur
  `127.0.0.1:2924`; seul le proxy inverse doit être joignable depuis Internet.
- Un identifiant de service Apple correspondant exactement au bundle iOS dans
  `APPLE_CLIENT_ID`.

## Installation

```sh
cd api
cp .env.example .env
# remplir .env avec des secrets distincts : openssl rand -hex 32 et rand -base64 32
docker compose up -d --build
```

Avant le premier déploiement, remplacez le client Apple et les trois secrets
aléatoires. Ils ne doivent pas être stockés dans le dépôt, la base de données,
ou les logs. Conservez-les dans le coffre de secrets OVH et faites une sauvegarde
chiffrée hors serveur : perdre `DATA_ENCRYPTION_KEY_BASE64` rend les données
chiffrées irrécupérables.

Exemple de proxy Nginx pour Compose :

```nginx
server {
  listen 443 ssl http2;
  server_name api.votre-domaine.tld;
  # certificats gérés par certbot ou OVH
  client_max_body_size 32k;
  location / {
    proxy_pass http://127.0.0.1:2924;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Compose définit `TRUST_PROXY=true`, car Nginx local transmet les requêtes. Ne
publiez jamais `2924` ou PostgreSQL sur Internet : le pare-feu doit n’autoriser
que 80/443 vers Nginx.

## Ce que protège le service

- Connexion Apple : le jeton d’identité est vérifié contre les clés publiques
  Apple, avec émetteur et audience imposés.
- Sessions : jeton d’accès de 15 minutes, jeton de renouvellement opaque, haché
  en base et remplacé à chaque renouvellement.
- Autorisation : l’identifiant du domicile ne suffit jamais; chaque route vérifie
  l’appartenance et le rôle. Un appareil ne peut poster que sa propre présence.
- Anti-rejeu : chaque événement porte un UUID unique; les événements anciens ne
  réécrivent pas un état plus récent.
- Défense réseau : en-têtes de sécurité, limite de taille, limitation de débit,
  logs expurgés de secrets, TLS obligatoire hors réseau local.

L’API n’accepte pas de coordonnées à chaque ping : le téléphone détermine
l’entrée/la sortie, puis envoie seulement l’état et l’heure. Cela limite fortement
la collecte de mouvements, sans empêcher un membre autorisé de voir la zone du
domicile auquel il a été invité.

## Notifications de présence

Les notifications sont facultatives et chaque membre choisit, pour chacun de ses
domiciles, s’il souhaite être averti d’une arrivée, d’un départ ou lorsque le
domicile devient vide. L’application enregistre le jeton APNs de l’appareil
uniquement après l’autorisation iOS; l’API ne transmet les alertes qu’aux appareils
des membres ayant activé au moins une de ces préférences.

Pour activer l’envoi en production, créez une clé **Apple Push Notifications**
dans le compte Apple Developer, puis ajoutez ces valeurs dans `.env` :

```sh
APNS_TEAM_ID=votre_team_id
APNS_KEY_ID=votre_key_id
APNS_PRIVATE_KEY_BASE64="$(base64 -w 0 AuthKey_VOTRE_KEY_ID.p8)"
APNS_BUNDLE_ID=adriendtz.IsAnyoneHome
```

Les quatre valeurs sont obligatoires ensemble. Sans elles, l’application garde les
préférences mais l’API n’envoie rien; elle démarre normalement, ce qui permet de
déployer l’API avant de créer la clé APNs. Ne versionnez jamais le fichier `.p8` ou
sa valeur Base64.

## À opérer avant publication

- Mettre en place les sauvegardes PostgreSQL chiffrées, la supervision de
  `/healthz`, les mises à jour système et une rotation contrôlée des secrets.
- Configurer *Sign in with Apple* pour le bundle exact, et le domaine de l’équipe
  de développement.
- Ajouter une vérification App Attest côté serveur avant une publication à grande
  échelle; elle protège en complément contre les clients iOS modifiés, mais ne
  remplace pas les contrôles d’autorisation déjà présents.
- Prévoir une politique de confidentialité, l’effacement du compte et une adresse
  de support. L’effacement est disponible via `DELETE /v1/account` : un domicile
  sans autre membre est supprimé, sinon sa propriété est transférée au membre le
  plus ancien (administrateur en priorité). La localisation en arrière-plan doit
  être expliquée clairement dans l’app et dans les notes de revue.
