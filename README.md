# Home Presence API

Petite API FastAPI pour gérer la présence de plusieurs personnes dans une maison.

## Endpoints

Tous les endpoints sauf `GET /health` nécessitent une clé API dans le header `x-api-key`.

### `GET /health`

```json
{
  "status": "ok"
}
```

### `POST /presence/{name}`

Body JSON :

```json
{
  "present": true
}
```

Réponse :

```json
{
  "ok": true,
  "name": "adrien",
  "present": true
}
```

### `GET /presence/status`

Réponse :

```json
{
  "someone_home": true,
  "people": {
    "adrien": false,
    "coloc1": true
  }
}
```

## Configuration

Copier l'exemple d'environnement :

```bash
cp .env.example .env
```

Puis modifier la clé API dans `.env` :

```bash
API_KEY=une-cle-secrete
```

Les données sont stockées dans `data/presence.json`. Le dossier `data` et le fichier JSON sont créés automatiquement s'ils n'existent pas.

## Lancement avec Docker Compose

```bash
docker compose up --build
```

L'API est exposée sur :

```text
http://localhost:2923
```

Le volume Docker monte le dossier local `./data` vers `/app/data` dans le conteneur pour persister les présences.

## Exemples curl

Arrivée Adrien :

```bash
curl -X POST http://localhost:2923/presence/Adrien \
  -H "content-type: application/json" \
  -H "x-api-key: une-cle-secrete" \
  -d '{"present": true}'
```

Départ Adrien :

```bash
curl -X POST http://localhost:2923/presence/Adrien \
  -H "content-type: application/json" \
  -H "x-api-key: une-cle-secrete" \
  -d '{"present": false}'
```

Statut global :

```bash
curl http://localhost:2923/presence/status \
  -H "x-api-key: une-cle-secrete"
```
