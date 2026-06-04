# ARCHITECTURE: Muesli

> Assistant de réunion macOS, local et sans bot visible : il enregistre le micro
> et l'audio système, transcrit, identifie qui a parlé, puis rédige un résumé
> structuré. Aucun backend Muesli, aucun compte, aucune télémétrie. Les seules
> données qui sortent de la machine sont les extraits audio envoyés aux API que
> l'utilisateur configure (Groq, Mistral, pyannoteAI, Anthropic, Notion).

> 🇬🇧 **English readers:** this is the detailed design document, kept in French.
> For an English overview of the architecture and pipeline, see the
> [Architecture section of the README](README.md#architecture).

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Choix technologiques justifiés](#2-choix-technologiques-justifiés)
3. [Fournisseurs de modèles enfichables](#3-fournisseurs-de-modèles-enfichables)
4. [Diagramme d'architecture](#4-diagramme-darchitecture)
5. [Capture audio double flux](#5-capture-audio-double-flux)
6. [Pipeline de transcription](#6-pipeline-de-transcription)
7. [Gestion des réunions longues (90 min)](#7-gestion-des-réunions-longues-90-min)
8. [Base de données SQLite](#8-base-de-données-sqlite)
9. [Sécurité et isolation des processus](#9-sécurité-et-isolation-des-processus)
10. [Résilience et gestion des erreurs](#10-résilience-et-gestion-des-erreurs)
11. [Cycle de vie d'une réunion et récupération](#11-cycle-de-vie-dune-réunion-et-récupération)
12. [Structure du projet](#12-structure-du-projet)

---

## 1. Vue d'ensemble

```
+-----------------------------------------------------------------+
|                       Muesli - macOS                            |
|                                                                 |
|  "Enregistre, transcrit et resume tes reunions sans bot         |
|   visible. Tu choisis tes modeles, tu paies a l'usage."         |
|                                                                 |
|  Cibles      : MacBook Apple Silicon (M1/M2/M3/M4)              |
|  OS          : macOS 14.2+ (Core Audio Process Tap)            |
|  Langues     : Francais + Anglais (melange accepte)            |
|  Duree cible : jusqu'a ~90 minutes par reunion                 |
|  Reseau      : requis uniquement pour les API choisies          |
+-----------------------------------------------------------------+
```

Muesli ne rejoint jamais une visioconférence en tant que participant. Il capture
localement deux flux audio (le micro de l'utilisateur et l'audio système de la
machine), les assemble, puis orchestre un pipeline transcription / diarisation /
résumé qui s'appuie sur des API cloud que l'utilisateur configure avec ses
propres clés. Le traitement lourd (modèles) est délégué à ces API ; toute
l'orchestration, le stockage et l'audio restent sur le Mac.

---

## 2. Choix technologiques justifiés

### Runtime : Electron 32

| Critère        | Justification                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron       | Accès complet aux API natives macOS (tray, notifications, raccourcis, Calendrier via un binaire Swift) tout en gardant React pour l'UI. Le processus principal Node gère l'I/O. |
| Version 32     | `contextIsolation: true` par défaut, support ESM, API `safeStorage` pour le chiffrement des clés via le Trousseau macOS.                                                        |
| Isolation      | `contextIsolation: true` + `nodeIntegration: false`. Le renderer n'a aucun accès à Node : tout passe par un `contextBridge` filtré (`preload.ts`).                              |
| electron-vite  | Build unifié du main, du preload et du renderer ; rechargement à chaud du renderer en dev.                                                                                      |

### Frontend : React 18 + TypeScript + Tailwind CSS

| Choix             | Justification                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| React 18          | Écosystème large ; mises à jour de transcription en quasi temps réel sans bloquer l'UI.                                             |
| TypeScript strict | Détection de bugs à la compilation. Essentiel pour un pipeline audio où des types mal alignés (offsets, segments) cassent en silence. |
| Tailwind CSS      | Pas de feuilles CSS séparées à maintenir, bundle réduit par tree-shaking.                                                           |

### Capture audio : Core Audio Process Tap (Swift) + repli ffmpeg/BlackHole

| Choix                          | Justification                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system-audio-capture` (Swift) | Binaire natif (`resources/SystemAudioCaptureCLI.swift`) qui utilise le Core Audio Process Tap de macOS 14.2+. Il capture l'audio système sans pilote virtuel à installer, et émet des chunks WAV + des stats RMS en JSON sur stdout. |
| Repli AudioTee / BlackHole     | Sur les configs où le Process Tap échoue, Muesli bascule sur le paquet `audiotee` (ou un périphérique virtuel BlackHole) pour router l'audio système vers un flux capturable.                       |
| Micro : ffmpeg ou sox          | Le micro est capturé via `ffmpeg -f avfoundation -i :0` ou `sox`, en PCM 16 bits 16 kHz mono.                                                                                                       |
| WAV 16 kHz mono par flux       | 16 kHz suffit pour la parole (Nyquist), minimise la taille et correspond à l'entrée attendue par les API Whisper/Voxtral. Pas de conversion superflue.                                              |

### Transcription : provider sélectionnable (Groq Whisper ou Mistral Voxtral)

| Choix                       | Justification                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrat OpenAI commun       | Les deux fournisseurs exposent l'endpoint `/audio/transcriptions` (multipart). Un seul client (`src/services/transcription.ts`) couvre les deux via une table de providers.            |
| Groq Whisper `large-v3`     | `verbose_json` (timestamps + métriques de confiance), `temperature=0`, biais de vocabulaire via `prompt`. Free tier disponible, ~$0.002/min.                                           |
| Mistral Voxtral `mini`      | Transcription audio native Mistral. Ne supporte pas le `prompt` d'amorçage ni `response_format` ; les timestamps sont demandés via `timestamp_granularities`. Le client s'adapte.      |
| Filtrage anti-hallucination | Seuils par langue sur `no_speech_prob` et `avg_logprob` pour écarter les segments douteux ; fusion des segments courts en phrases.                                                      |

### Diarisation : pyannoteAI (job asynchrone)

| Choix                   | Justification                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pyannoteAI              | Service de diarisation hébergé (`src/services/pyannote.ts`). On envoie le canal "others" (audio système), il renvoie des segments attribués (`SPEAKER_00` → `others_0`, etc.). |
| Job + polling           | `/v1/diarize` crée un job ; on poll `/jobs/{id}` avec backoff exponentiel, plafonné à 30 minutes. Une diarisation longue ne bloque pas le reste du pipeline.                  |
| Re-transcription ciblée | Chaque segment diarisé est ensuite découpé et re-transcrit individuellement pour obtenir un texte propre attribué au bon locuteur.                                            |
| Repli sans diarisation  | Si la clé pyannote est absente ou si un chunk échoue, on retombe sur une transcription directe du canal "others" (sans séparation des interlocuteurs).                       |

### Résumé : provider sélectionnable (Anthropic Claude ou Mistral)

| Choix                       | Justification                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Claude Haiku      | `claude-haiku-4-5-20251001`, contexte large, ~$0.01 par réunion d'une heure. Endpoint `/v1/messages`.                              |
| Mistral Small               | `mistral-small-latest`, API chat completions compatible OpenAI (`/v1/chat/completions`), ~$0.002 par réunion d'une heure.          |
| Prompt unique               | Les deux fournisseurs reçoivent exactement le même prompt (`src/services/summarization.ts`) ; seul l'appel HTTP diffère.            |
| Templates éditables         | Le prompt système est un template modifiable par l'utilisateur (table `templates`, builtins fournis : Défaut, 1:1, Appel client, Standup, Revue technique). |

### Stockage : better-sqlite3 + FTS5

| Choix          | Justification                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SQLite         | Base embarquée, fichier unique (`muesli.db` dans `userData`), zéro configuration. FTS5 intégré pour la recherche plein texte.   |
| better-sqlite3 | API synchrone, rapide, compilée nativement pour l'ABI Electron (`npm run rebuild`). Pragmas : WAL, foreign_keys ON, busy_timeout. |
| Migrations     | Fichiers SQL séquentiels `migrations/001..007`, appliqués au démarrage et suivis dans une table `_migrations`. On n'édite jamais une migration déjà publiée ; on en ajoute une nouvelle. |

### Configuration : SQLite + chiffrement Trousseau (safeStorage)

| Choix                  | Justification                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Réglages en base       | Les préférences sont stockées dans la table `settings` (`SettingsManager`).                                                                    |
| Clés API chiffrées     | Les clés sensibles (`apiKeyGroq`, `apiKeyAnthropic`, `apiKeyMistral`, `apiKeyPyannote`, `apiKeyNotion`) sont chiffrées avec `safeStorage` (Trousseau macOS) avant écriture, préfixe `enc::`. Un simple `cp muesli.db` ne permet pas de les voler. |
| Migration transparente | `migrateToEncrypted()` chiffre au démarrage toute clé encore en clair (héritée d'une ancienne version).                                        |

---

## 3. Fournisseurs de modèles enfichables

La transcription et le résumé sont chacun abstraits derrière une petite couche
de providers, de sorte que le modèle sous-jacent est un choix d'exécution, pas
une dépendance câblée en dur.

| Étape          | Fournisseurs                                                            | Sélection                |
| -------------- | ---------------------------------------------------------------------- | ------------------------ |
| Speech-to-text | **Groq** Whisper `whisper-large-v3` ou **Mistral** Voxtral `voxtral-mini` | Réglages → Transcription |
| Résumé         | **Anthropic** Claude `claude-haiku-4-5` ou **Mistral** `mistral-small`   | Réglages → Résumé IA     |

Le `PipelineManager` lit les réglages `transcriptionProvider` / `summaryProvider`
et configure le client avec la bonne clé :

```
transcriptionKey = settings.transcriptionProvider === 'mistral'
                   ? settings.apiKeyMistral : settings.apiKeyGroq
summaryKey       = settings.summaryProvider === 'mistral'
                   ? settings.apiKeyMistral : settings.apiKeyAnthropic
```

Ajouter un nouveau modèle revient à étendre la table de providers du service
concerné : aucun changement de pipeline n'est nécessaire.

---

## 4. Diagramme d'architecture

```
+-------------------------------------------------------------------------+
|                         PROCESSUS PRINCIPAL (Node)                       |
|                                                                         |
|  +-------------------+   +-------------------+   +-------------------+   |
|  | RecordingOrchestr.|   | PipelineManager   |   | DatabaseService   |   |
|  | machine d'etat    |   | transcription/    |   | better-sqlite3    |   |
|  | start/stop, VU    |   | resume/recovery   |   | + FTS5 + migrations|  |
|  +---------+---------+   +---------+---------+   +-------------------+   |
|            |                       |                                     |
|            v                       v                                     |
|  +-------------------+   +-----------------------------------------+     |
|  | AudioCaptureSvc   |   |  Etapes pipeline (par chunk de 10 min)  |     |
|  |  mic: ffmpeg/sox  |   |  merge stereo -> AEC (aechocancel)      |     |
|  |  sys: ProcessTap  |   |  -> split canaux -> VAD -> normalize     |    |
|  |  (Swift) / AudioTee|  |  -> STT (me) / diarize+STT (others)      |    |
|  +-------------------+   |  -> merge/consolidate -> resume          |    |
|                          +-----------------------------------------+     |
|                                                                         |
|  Helpers natifs (Swift) : system-audio-capture, calendar-helper         |
|                                                                         |
+----------------------- IPC contextBridge (Zod) -------------------------+
|                                                                         |
|                       PROCESSUS RENDERER (React)                         |
|                                                                         |
|  Sidebar reunions + recherche FTS  |  Detail : Resume / Transcription /  |
|  VU-metre (getUserMedia + Analyser) |  Notes  |  Reglages (cles, modeles) |
|                                                                         |
+-------------------------------------------------------------------------+

                          API EXTERNES (au choix de l'utilisateur)

   +-------------+   +-------------+   +-------------+   +-------------+
   | Groq Whisper|   | Mistral     |   | pyannoteAI  |   | Anthropic   |
   |  large-v3   |   | Voxtral /   |   | diarisation |   | Claude /    |
   |             |   | Mistral Small|  |             |   | Mistral     |
   +-------------+   +-------------+   +-------------+   +-------------+
                                                          (+ Notion export)
```

Le main process possède toute l'I/O (audio, base, réseau, binaires natifs). Le
renderer ne communique qu'à travers `window.api`, et chaque appel IPC est validé
par un schéma Zod via `safeHandle(channel, schema, fn)` avant exécution.

---

## 5. Capture audio double flux

### 5.1 Deux sources, un chunk stéréo

Pendant l'enregistrement, deux processus tournent en parallèle :

- **Micro** ("me") : `ffmpeg -f avfoundation -i :0` ou `sox`, WAV PCM 16 bits 16 kHz mono.
- **Audio système** ("others") : binaire `system-audio-capture` (Core Audio Process Tap, macOS 14.2+), ou repli AudioTee/BlackHole.

`AudioCaptureService` découpe l'enregistrement en chunks de 10 minutes et fusionne
le flux micro (canal gauche) et le flux système (canal droit) en un seul fichier
**stéréo `chunk_NNN.wav`** (L = vous, R = la salle). Les fichiers mono sources
sont supprimés après fusion.

```
Micro (AirPods/Mac) --> ffmpeg/sox  ----+
                                        +--> chunk_000.wav (stereo, L=me, R=others)
Audio systeme       --> ProcessTap   ---+    chunk_001.wav
(macOS 14.2+) / AudioTee                     ...

Stockage : ~/Library/Application Support/Muesli/audio/<meetingId>/
Format   : WAV PCM 16 bits, 16 kHz, 2 canaux
```

Un format **legacy** (fichiers mono séparés `me_chunk_NNN.wav` / `others_chunk_NNN.wav`)
reste pris en charge en lecture et en récupération, pour les réunions enregistrées
par d'anciennes versions.

### 5.2 Décalage du canal système

Le Process Tap (ou AudioTee) peut mettre quelques secondes avant de produire un
premier chunk valide après le démarrage. Ce décalage (`others_offset_ms`,
migration 003) est calculé au lancement et persisté en base, pour que les
timestamps du canal "others" restent alignés même si l'app redémarre.

### 5.3 Lecture audio dans l'UI

Le main expose un protocole privilégié `muesli-audio://me/<meetingId>` et
`muesli-audio://others/<meetingId>`. Le handler lit les chunks stéréo, désentrelace
le canal demandé en mono à la volée, reconstruit un en-tête WAV et répond, en
gérant les requêtes Range (seek) pour ne pas charger tout le fichier.

---

## 6. Pipeline de transcription

Orchestré par `electron/recording/PipelineManager.ts`, traité chunk par chunk :

```
Pour chaque chunk_NNN.wav (offset = N * 600s) :

  1. Stereo               : chunk natif, ou fusion me+others (legacy)
  2. AEC                  : ffmpeg aechocancel (annulation d'echo du canal mic
                            avec le canal systeme comme reference)
  3. Split canaux         : pan=mono|c0=FL (me)  /  c0=FR (others)
  4. VAD (hasSpeech)      : on saute les canaux sans parole detectable
                            (evite les hallucinations Whisper sur le silence)
  5. Normalisation        : sox 'gain -n -3' ou ffmpeg loudnorm

  Canal "me"     -> STT direct (Groq Whisper large-v3 ou Mistral Voxtral)
  Canal "others" -> pyannote /v1/diarize -> re-transcription par segment
                    (repli : STT direct si pyannote indisponible/echoue)

Apres tous les chunks :

  6. Fusion/consolidation : mergePreDiarized (si pyannote) ou merge,
                            consolidateToTurns(maxGap=1.5s),
                            anti-echo / anti-hallucination / dedup aux bornes
  7. Persistance segments : transcript_segments (+ words_json)
  8. Resume IA            : Claude Haiku ou Mistral Small, sur la transcription
                            attribuee (+ notes manuelles de l'utilisateur)
  9. Titre auto           : extrait de la section "## Titre" du resume
```

Progression renvoyée au renderer (`transcription:progress`) : 0 à 80 % pour les
chunks, 85 % à la fusion, 90 % au résumé, puis `complete`.

### 6.1 Appels réseau résilients

`AbortSignal.timeout()` est peu fiable dans le processus principal d'Electron :
le timer qui le sous-tend peut ne pas se déclencher quand la boucle d'événements
est occupée par de l'I/O réseau, laissant un `fetch` pendre indéfiniment. Tous
les clients (transcription, pyannote, résumé) utilisent donc un wrapper manuel :

```typescript
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}
```

S'y ajoutent un retry à backoff exponentiel sur les erreurs transitoires
(réseau, 429, 5xx) côté transcription, et des messages d'erreur explicites sur
les cas permanents (401 clé invalide, 402 crédit insuffisant).

---

## 7. Gestion des réunions longues (90 min)

| Décision                | Raison                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chunks de 10 min        | Chaque chunk est un WAV fermé sur disque : un crash au chunk 6 laisse les chunks 1 à 5 intacts et rejouables. |
| Traitement par chunk    | On n'a jamais toute la réunion en mémoire ; chaque chunk passe AEC, split, VAD, normalisation puis STT.       |
| VAD avant chaque appel  | Les canaux sans parole sont écartés : moins d'appels API, pas d'hallucination Whisper sur du silence.        |
| Résumé en deux temps    | Si la transcription dépasse ~5000 mots, elle est découpée en blocs résumés séparément, puis fusionnés.        |
| Diarisation plafonnée   | Le polling pyannote a un plafond de 30 minutes et un repli ; un job lent ne bloque pas la réunion entière.    |

---

## 8. Base de données SQLite

Fichier `muesli.db` dans `userData`. Pragmas : `journal_mode=WAL`,
`foreign_keys=ON`, `busy_timeout=5000`. Schéma construit par migrations
séquentielles (`migrations/001..007`), suivies dans `_migrations`.

### 8.1 Tables principales

```sql
-- 001_initial.sql
CREATE TABLE meetings (
    id                TEXT PRIMARY KEY,          -- UUID v4
    title             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,             -- ISO 8601
    updated_at        TEXT NOT NULL,
    duration_seconds  INTEGER DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'recording',
                      -- recording | transcribing | summarizing | complete | error
    speaker_me        TEXT NOT NULL DEFAULT 'MOI',
    speaker_others    TEXT NOT NULL DEFAULT 'INTERLOCUTEUR',
    notes_markdown    TEXT DEFAULT '',
    summary_markdown  TEXT DEFAULT '',
    summary_model     TEXT DEFAULT '',           -- ex: claude-haiku, mistral-small
    summary_prompt    TEXT DEFAULT '',
    language          TEXT DEFAULT 'fr',
    error_message     TEXT DEFAULT NULL,
    audio_path_me     TEXT DEFAULT '',
    audio_path_others TEXT DEFAULT '',
    audio_deleted     INTEGER DEFAULT 0
);

CREATE TABLE transcript_segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker     TEXT NOT NULL,             -- 'me' | 'others' | 'others_0' ...
    start_time  REAL NOT NULL,             -- secondes depuis le debut
    end_time    REAL NOT NULL,
    text        TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    confidence  REAL DEFAULT NULL,
    is_overlap  INTEGER DEFAULT 0
);
```

Index : `idx_segments_meeting`, `idx_segments_time`, `idx_segments_speaker`,
`idx_meetings_created`, `idx_meetings_status`.

### 8.2 Recherche plein texte (FTS5)

Deux tables virtuelles FTS5 (`meetings_fts` sur titre/notes/résumé,
`segments_fts` sur le texte des segments), maintenues synchronisées par des
triggers `AFTER INSERT/UPDATE/DELETE`. `searchMeetings` exécute un `MATCH` sur
les deux.

### 8.3 Migrations ultérieures

| Migration | Apport                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| 002       | Table `meeting_speakers` : noms d'interlocuteurs personnalisés par réunion.            |
| 003       | Colonne `others_offset_ms` : décalage temporel persisté du canal système.             |
| 004       | Colonnes `calendar_event_id`, `attendees` : pré-création de réunions depuis le Calendrier. |
| 005       | Table `templates` (+ `last_template_id`) : prompts de résumé réutilisables.           |
| 006       | Colonne `words_json` : timestamps mot par mot sur les segments.                       |
| 007       | Colonne `calendar_event_end` : auto-suppression des brouillons 2 h après la fin.       |

---

## 9. Sécurité et isolation des processus

```
+---------------------------------------------------------+
|                Electron Main Process (Node)             |
|                                                         |
|  + Acces complet Node / systeme de fichiers             |
|  + Spawn child_process (ffmpeg, sox, binaires Swift)    |
|  + SQLite via better-sqlite3                            |
|  + Appels HTTPS vers les API choisies par l'utilisateur |
|  + Cles API chiffrees via safeStorage (Trousseau macOS) |
|                                                         |
+-------------- contextBridge (preload.ts) ---------------+
|                                                         |
|  window.api.* (whitelist stricte), ex :                 |
|    recording.start() / stop() / getStatus()             |
|    meetings.list/get/search/updateNotes/...             |
|    transcription.getProgress / retry                    |
|    summarization.retry                                   |
|    settings.get / update                                 |
|    calendar.getEvents                                    |
|    export.notionExport / saveFile / copyToClipboard      |
|    system.checkDependencies / openExternal               |
|                                                         |
|  Chaque handler : safeHandle(channel, ZodSchema, fn)    |
|                                                         |
+---------------------------------------------------------+
|                Electron Renderer (React)                |
|                                                         |
|  + React + TypeScript + Tailwind                        |
|  - Aucun acces Node ni systeme de fichiers              |
|  - Uniquement window.api.* via contextBridge            |
|                                                         |
+---------------------------------------------------------+
```

Points clés :

- **IPC validé au boundary** : `safeHandle` rejette tout payload qui ne respecte
  pas son schéma Zod avant que le handler ne s'exécute. Jamais de contournement.
- **Clés chiffrées au repos** : `safeStorage` (Trousseau macOS), préfixe `enc::`.
  Le déchiffrement n'est possible que par l'app sur la machine de l'utilisateur.
- **Renderer cloisonné** : `contextIsolation: true`, `nodeIntegration: false`,
  permissions media uniquement (pour le VU-mètre via `getUserMedia`).
- **Pas de backend Muesli** : aucune donnée n'est envoyée ailleurs que vers les
  API que l'utilisateur a explicitement configurées avec ses propres clés.

---

## 10. Résilience et gestion des erreurs

| Composant       | Risque                          | Stratégie                                                                        |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| Capture système | Process Tap indisponible        | Repli AudioTee/BlackHole ; jusqu'à 3 tentatives de redémarrage, avertissement UI. |
| Transcription   | `fetch` qui pend                | `fetchWithTimeout` (AbortController manuel) sur tous les clients.                 |
| Transcription   | Erreur réseau / 429 / 5xx       | Retry à backoff exponentiel ; pas de retry sur 400/401/413.                       |
| Transcription   | Silence / bruit                 | VAD en amont + filtrage `no_speech_prob` / `avg_logprob` par langue.             |
| Diarisation     | Job pyannote lent ou en échec   | Polling plafonné à 30 min ; repli sur transcription directe du canal "others".    |
| Résumé          | Clé invalide / crédit épuisé    | Messages explicites (401/402/429) ; la transcription reste disponible.            |
| Résumé          | Transcription très longue       | Découpage en blocs résumés puis fusionnés.                                        |
| Pipeline        | Échec d'un chunk                | Le chunk est journalisé et ignoré ; les autres continuent.                       |
| Base de données | Migration en échec              | Appliquée dans une transaction suivie par `_migrations` ; on n'édite jamais une migration publiée. |

Sur chaque chemin d'erreur du pipeline, `currentProgress` est remis à `null`
pour éviter que l'UI de progression ne reste figée.

---

## 11. Cycle de vie d'une réunion et récupération

```
draft -> recording -> transcribing -> summarizing -> complete
                                              \-> error
```

- **draft** : pré-créé depuis un événement Calendrier (titre, lien, participants).
- **recording** : capture des deux flux en cours.
- **transcribing / summarizing** : pipeline en cours.
- **complete / error** : terminal.

**Récupération au démarrage** : `recoverOrphanedMeetings()` parcourt les réunions
restées en `recording` / `transcribing` / `summarizing` (typiquement après un
crash), retrouve les chunks sur disque (stéréo en priorité, sinon legacy
me/others) et relance le pipeline. Si le dossier audio ou les chunks sont
introuvables, la réunion passe en `error` avec un message explicite.

**Calendrier (EventKit)** : un binaire Swift (`calendar-helper`) lit les
événements macOS à venir. Le main pré-crée des brouillons, notifie une minute
avant le début (avec un bouton "Rejoindre" si un lien de réunion est détecté) et
nettoie les brouillons non enregistrés 2 h après la fin de l'événement.

---

## 12. Structure du projet

```
muesli/
├── electron/
│   ├── main.ts                       # Bootstrap, protocole muesli-audio://,
│   │                                 #   notifications calendrier, recovery
│   ├── preload.ts                    # contextBridge : window.api (whitelist)
│   ├── tray.ts                       # Icone barre de menu + raccourci global
│   ├── calendar.ts                   # Pont vers le binaire Swift EventKit
│   ├── ipc/
│   │   ├── validators.ts             # safeHandle + schemas Zod
│   │   ├── recordingHandlers.ts
│   │   ├── meetingHandlers.ts
│   │   └── settingsHandlers.ts
│   ├── recording/
│   │   ├── RecordingOrchestrator.ts  # Machine d'etat start/stop, VU-metre
│   │   ├── PipelineManager.ts        # Transcription + resume + recovery
│   │   └── SystemAudioProcess.ts     # Wrapper du binaire Process Tap
│   ├── services/
│   │   ├── NormalizationService.ts   # sox gain / ffmpeg loudnorm
│   │   └── depCheck.ts               # Verification des dependances (ffmpeg, etc.)
│   ├── settings/
│   │   └── SettingsManager.ts        # Chiffrement Trousseau + lecture/ecriture
│   └── utils/
│       └── platform.ts
│
├── src/
│   ├── components/
│   │   ├── MeetingList/              # Sidebar + recherche FTS
│   │   ├── MeetingDetail/            # Onglets Resume / Transcription / Notes
│   │   └── Settings/                 # Cles API, choix des providers, prompts
│   ├── services/
│   │   ├── audioCapture.ts           # Capture micro + systeme, chunks stereo
│   │   ├── transcription.ts          # Provider Groq Whisper / Mistral Voxtral
│   │   ├── pyannote.ts               # Diarisation (job + polling)
│   │   ├── diarization.ts            # Merge, consolidation, anti-echo/hallucination
│   │   ├── summarization.ts          # Provider Anthropic Claude / Mistral
│   │   ├── vad.ts                    # Detection d'activite vocale (RMS)
│   │   ├── export.ts                 # Export Notion / fichier / presse-papier
│   │   └── database.ts               # SQLite + FTS5 + migrations
│   ├── hooks/
│   │   ├── useRecording.ts           # Etat enregistrement + VU-metre
│   │   └── useMeetings.ts            # CRUD reunions + recherche
│   ├── types/
│   │   └── index.ts                  # Types partages (providers, Settings, ...)
│   └── App.tsx
│
├── migrations/                       # 001_initial.sql ... 007_*.sql
├── resources/
│   ├── SystemAudioCaptureCLI.swift   # Source du binaire Core Audio Process Tap
│   ├── system-audio-capture          # Binaire compile
│   └── calendar-helper               # Binaire Swift EventKit
│
├── ARCHITECTURE.md                   # Ce document
├── README.md
├── CONTRIBUTING.md
├── package.json
└── electron-builder (config dans package.json)
```

---

## Annexe : dépendances externes

| Outil / service | Rôle                                                  | Requis                              |
| --------------- | ----------------------------------------------------- | ----------------------------------- |
| Node.js 22 LTS  | Build et exécution                                    | Oui                                 |
| ffmpeg          | AEC, split de canaux, normalisation, capture micro    | Oui                                 |
| sox / BlackHole | Repli capture micro / audio système                   | Selon configuration                 |
| Groq            | Transcription (Whisper large-v3)                      | Oui, sauf si Mistral choisi pour STT |
| Mistral         | Transcription (Voxtral) et/ou résumé (Mistral Small)  | Optionnel (provider au choix)       |
| pyannoteAI      | Diarisation des interlocuteurs                        | Recommandé (sinon pas de séparation) |
| Anthropic       | Résumé (Claude Haiku)                                 | Oui, sauf si Mistral choisi pour le résumé |
| Notion          | Export des notes                                      | Optionnel                           |

Les clés API sont saisies dans les Réglages et stockées chiffrées dans le
Trousseau macOS. Aucune n'est nécessaire au build ; elles ne servent qu'à
l'exécution du pipeline.
