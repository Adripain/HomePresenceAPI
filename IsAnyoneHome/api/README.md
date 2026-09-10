# API de présence — déploiement production

Cette API ne doit jamais être exposée telle quelle avec un mot de passe, une clé
ou une base de données de démonstration. Elle isole toutes les ressources par
utilisateur et par rôle dans le domicile (`owner`, `admin`, `member`). Les
positions et la configuration du pont local sont chiffrées avec AES-256-GCM avant
leur insertion dans PostgreSQL.

## Prérequis OVH

- Un sous-domaine dédié, par exemple `api.votre-domaine.tld`, avec un certificat
  TLS valide.
- PostgreSQL 16+ sur un réseau privé, sans port 5432 ouvert à Internet.
- Node 22+ ou Docker. L’API écoute par défaut uniquement sur `127.0.0.1`; seul
  le proxy inverse doit être joignable depuis Internet.
- Un identifiant de service Apple correspondant exactement au bundle iOS dans
  `APPLE_CLIENT_ID`.

## Installation

```sh
cd api
npm install
cp .env.example .env
# remplir .env avec des secrets distincts : openssl rand -base64 32
set -a; . ./.env; set +a
npm run db:migrate
npm run dev
```

Avant le premier déploiement, remplacez le client Apple, l’URL PostgreSQL et les
deux clés aléatoires. Les deux clés ne doivent pas être stockées dans le dépôt,
la base de données, ou les logs. Conservez-les dans le coffre de secrets OVH et
faites une sauvegarde chiffrée hors serveur : perdre `DATA_ENCRYPTION_KEY_BASE64`
rend les données chiffrées irrécupérables.

Exemple de proxy Nginx :

```nginx
server {
  listen 443 ssl http2;
  server_name api.votre-domaine.tld;
  # certificats gérés par certbot ou OVH
  client_max_body_size 32k;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Avec Docker, publiez le port uniquement sur la boucle locale, puis laissez Nginx
être le seul point d’entrée :

```sh
docker build -t presence-api ./api
docker run --env-file ./api/.env -e HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 presence-api
```

Dans ce cas seulement, passez `TRUST_PROXY=true`. Gardez `false` si l’API est
directement accessible; faire confiance à `X-Forwarded-For` sur une interface
publique rend la limitation de débit contournable. Le pare-feu doit n’autoriser
que 80/443; le port applicatif et PostgreSQL restent locaux/privés.

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

## Relais local d’éclairage

Un serveur OVH ne peut pas appeler une adresse privée `192.168.x.x` de votre
domicile. Le dossier `../bridge-relay` résout ce point : il tourne sur un appareil
qui reste à la maison (mini-ordinateur, NAS, ou serveur domestique), ouvre
uniquement des connexions HTTPS sortantes, et récupère les commandes en attente.

1. Dans l’app, associez le pont d’éclairage en appuyant sur son bouton physique.
2. Créez un code d’installation de relais dans l’app.
3. Sur l’appareil local, copiez `.env.example` vers un fichier protégé, renseignez
   l’URL HTTPS et le code, puis lancez `node index.mjs`.
4. Le premier lancement imprime un secret de relais une seule fois. Placez-le dans
   `RELAY_SECRET`, retirez le code d’installation puis redémarrez.

Le relais n’expose aucun port, et le serveur ne peut lui remettre que les
commandes de son domicile. Une commande « tout éteindre » est idempotente : une
répétition ne rallume jamais une lampe.

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
