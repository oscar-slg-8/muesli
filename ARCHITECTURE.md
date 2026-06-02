# ARCHITECTURE: Muesli

> Application macOS de prise de notes de réunions, 100% locale, invisible pour les interlocuteurs.

> 🇬🇧 **English readers:** this is the detailed design document, kept in French.
> For an English overview of the architecture and pipeline, see the
> [Architecture section of the README](README.md#architecture).

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Choix technologiques justifiés](#2-choix-technologiques-justifiés)
3. [Diagramme d'architecture](#3-diagramme-darchitecture)
4. [Flux de données de bout en bout](#4-flux-de-données-de-bout-en-bout)
5. [Architecture de diarisation deux flux](#5-architecture-de-diarisation-deux-flux)
6. [Gestion des fichiers longs (90 min)](#6-gestion-des-fichiers-longs-90-min)
7. [Base de données SQLite](#7-base-de-données-sqlite)
8. [Stratégie de gestion des erreurs](#8-stratégie-de-gestion-des-erreurs)
9. [Décisions de performance](#9-décisions-de-performance)
10. [Sécurité et isolation des processus](#10-sécurité-et-isolation-des-processus)
11. [Plan de migration des dépendances](#11-plan-de-migration-des-dépendances)
12. [Structure du projet](#12-structure-du-projet)

---

## 1. Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                       Muesli - macOS                           │
│                                                                 │
│  "Enregistre, transcrit et résume tes réunions sans que         │
│   personne ne le sache. Tout reste sur ton Mac."                │
│                                                                 │
│  Cibles : MacBook Apple Silicon (M1/M2/M3/M4)                  │
│  Langues : Français + Anglais (mélange accepté)                 │
│  Durée max : 90 minutes par réunion                             │
│  Réseau requis : NON (tout est local)                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Choix technologiques justifiés

### Runtime : Electron 32+

| Critère           | Justification                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pourquoi Electron | Seul framework cross-plateforme mature offrant un accès complet aux API natives macOS (tray, raccourcis globaux, périphériques audio) tout en utilisant React pour l'UI. Tauri serait plus léger mais son écosystème audio natif est immature et la gestion des binaires natifs (whisper.cpp) y est plus complexe. |
| Version 32+       | Support ESM natif, `contextIsolation: true` par défaut, API `safeStorage` pour chiffrement des préférences.                                                                                                                                                                                                        |
| Isolation         | `contextIsolation: true` + `nodeIntegration: false`, le renderer n'a AUCUN accès à Node.js. Toute communication passe par `contextBridge` dans `preload.ts`.                                                                                                                                                       |

### Frontend : React 18 + TypeScript strict + Tailwind CSS

| Choix             | Justification                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React 18          | Écosystème le plus large, documentation abondante, Concurrent Mode pour les mises à jour de transcription en temps quasi-réel sans bloquer l'UI.                                                      |
| TypeScript strict | `strict: true` dans tsconfig = détection de bugs à la compilation. Aucun `any` implicite toléré. Essentiel pour un pipeline audio/transcription où les types mal alignés causent des bugs silencieux. |
| Tailwind CSS      | Utilitaire, pas de fichiers CSS séparés à maintenir. Bundle final plus petit grâce au tree-shaking. Pas de conflits de noms de classes.                                                               |

### Capture audio : node-audiorecorder + BlackHole 2ch

| Choix                        | Justification                                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-audiorecorder           | Wrapper Node.js autour de `sox`/`rec` (outils audio en ligne de commande). Léger, pas de binding natif C++ à compiler (contrairement à `node-record-lpcm16` qui dépend de `sox` aussi mais avec une API moins flexible). Permet de spécifier le périphérique source, le format, l'échantillonnage. |
| BlackHole 2ch                | Pilote audio virtuel macOS open source. Crée un "câble audio virtuel" : le son système est routé vers BlackHole, que l'app peut capturer comme un micro. Alternative à Soundflower (abandonné) et Loopback (payant, 99€). Zéro latence, zéro bruit.                                                |
| Format WAV 16kHz mono        | Format natif attendu par whisper.cpp. Pas de conversion = pas de perte, pas de latence supplémentaire. 16kHz suffit pour la parole (bande passante 8kHz selon Nyquist). Mono car la spatialisation n'apporte rien à la transcription.                                                              |
| Pourquoi pas `Web Audio API` | Web Audio API dans Electron ne peut pas capturer un périphérique audio arbitraire (comme BlackHole). Il faut passer par Node.js pour accéder aux périphériques natifs via `sox`.                                                                                                                   |

### Transcription : whisper.cpp via nodejs-whisper (+ fallback Python)

| Choix                       | Justification                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| whisper.cpp                 | Implémentation C++ optimisée de Whisper d'OpenAI. Utilise les instructions NEON d'Apple Silicon = 4-6x plus rapide que le Python original. Un fichier de 10 min se transcrit en ~45 secondes sur M1.                    |
| Modèle large-v3             | Meilleur modèle multilingue (français + anglais). ~3GB de RAM. Les modèles plus petits (medium, small) perdent en précision sur le français et le mélange de langues.                                                   |
| nodejs-whisper              | Binding Node.js qui compile whisper.cpp automatiquement. Évite de gérer un processus séparé.                                                                                                                            |
| Fallback Python             | Si `nodejs-whisper` ne compile pas sur ARM (problème connu sur certaines configs Xcode), un script Python utilisant `openai-whisper` est appelé via `child_process.spawn`. Plus lent (~2x) mais garanti de fonctionner. |
| Pourquoi pas `whisper-node` | Moins maintenu, pas de support ARM natif vérifié. `nodejs-whisper` a une communauté plus active.                                                                                                                        |

### Diarisation : Deux flux séparés (approche custom)

| Choix                       | Justification                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pourquoi PAS pyannote-audio | pyannote-audio est la référence pour la diarisation, MAIS : nécessite PyTorch (~2GB), modèle HuggingFace (accès réseau au premier lancement), et la qualité se dégrade fortement sur l'audio système compressé des visioconférences. Trop lourd et trop fragile pour du 100% local. |
| Approche deux flux          | En séparant physiquement "mon micro" et "leur audio" en deux fichiers WAV, on obtient une diarisation Moi/Eux fiable à 100% sans aucun modèle ML supplémentaire. C'est une solution d'ingénierie, pas de machine learning.                                                          |
| Limite documentée           | On ne distingue pas les interlocuteurs entre eux. Acceptable pour le cas d'usage (notes personnelles de réunion, pas un outil de transcription collaborative).                                                                                                                      |

### Résumé IA : Ollama + Mistral

| Choix           | Justification                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ollama          | Serveur d'inférence local, installation simple (`brew install ollama`), API HTTP standard. Gère le chargement/déchargement des modèles automatiquement.                                                                                                     |
| Mistral (7B)    | Excellent en français (modèle français), contexte 8K tokens suffisant pour un résumé, tourne en ~4GB de RAM sur Apple Silicon. Alternative : Llama 3.1 8B (meilleur en anglais, un peu moins bon en français). Le choix est configurable dans les Settings. |
| API HTTP locale | `http://localhost:11434/api/generate`, requête POST standard. Pas de binding natif, pas de dépendance lourde. Si Ollama ne répond pas, la transcription reste disponible et le résumé est mis en attente.                                                   |

### Base de données : better-sqlite3

| Choix                  | Justification                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                 | Base embarquée, fichier unique, zéro configuration. Parfait pour une app locale single-user. FTS5 intégré pour la recherche full-text.            |
| better-sqlite3         | API synchrone (pas de callback hell), 2-5x plus rapide que `sqlite3` (node-sqlite3) grâce à l'utilisation de `napi`. Compilé nativement pour ARM. |
| Pourquoi pas IndexedDB | Pas de FTS, pas de requêtes SQL complexes, limité au renderer process. SQLite permet des requêtes depuis le main process.                         |

### Configuration : electron-store

| Choix                              | Justification                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| electron-store                     | Fichier JSON chiffré via `safeStorage` d'Electron (Keychain macOS). Simple, typé, avec valeurs par défaut.                             |
| Pourquoi pas un fichier .json brut | Pas de chiffrement natif. Les préférences contiennent le prompt système personnalisé et les noms des participants = données sensibles. |

### Logs : winston

| Choix    | Justification                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| winston  | Logger Node.js le plus utilisé. Rotation automatique des fichiers, niveaux configurables, transports multiples (fichier + console). |
| Rotation | Fichiers de 5MB max, 5 fichiers conservés. Évite de remplir le disque sur des mois d'utilisation.                                   |

---

## 3. Diagramme d'architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PROCESSUS PRINCIPAL (main)                      │
│                                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Tray    │  │ AudioCapture │  │ ChunkManager │  │   Database    │  │
│  │  Menu    │  │  Service     │  │   Service    │  │   Service     │  │
│  │          │  │              │  │              │  │               │  │
│  │ Start    │  │ ┌──────────┐ │  │ 10min chunks │  │ better-sqlite3│  │
│  │ Stop     │  │ │ Flux MOI │ │  │ 30s overlap  │  │ + FTS5        │  │
│  │ Open     │  │ │ (micro)  │ │  │ Rolling buf  │  │ + migrations  │  │
│  │ Quit     │  │ ├──────────┤ │  │              │  │               │  │
│  │          │  │ │ Flux EUX │ │  │              │  │               │  │
│  │ Cmd+Sh+R │  │ │(BlackHole│ │  │              │  │               │  │
│  │          │  │ └──────────┘ │  │              │  │               │  │
│  └──────────┘  └──────────────┘  └──────────────┘  └───────────────┘  │
│        │              │                 │                  │            │
│        │              ▼                 ▼                  │            │
│        │       ┌──────────────────────────────┐           │            │
│        │       │    Transcription Service      │           │            │
│        │       │                                │           │            │
│        │       │  ┌────────────────────────┐   │           │            │
│        │       │  │    nodejs-whisper       │   │           │            │
│        │       │  │    (whisper.cpp)        │   │           │            │
│        │       │  │    modèle large-v3      │   │           │            │
│        │       │  └──────────┬─────────────┘   │           │            │
│        │       │             │ ÉCHEC ?          │           │            │
│        │       │             ▼                  │           │            │
│        │       │  ┌────────────────────────┐   │           │            │
│        │       │  │  Fallback Python       │   │           │            │
│        │       │  │  (child_process.spawn) │   │           │            │
│        │       │  └────────────────────────┘   │           │            │
│        │       └──────────────┬─────────────────┘           │            │
│        │                      │                             │            │
│        │                      ▼                             │            │
│        │       ┌──────────────────────────────┐            │            │
│        │       │    Diarization Service        │            │            │
│        │       │                                │            │            │
│        │       │  Alignement temporel           │            │            │
│        │       │  Merge [MOI] + [INTERLOCUTEUR] │            │            │
│        │       │  Résolution chevauchements      │            │            │
│        │       └──────────────┬─────────────────┘            │            │
│        │                      │                             │            │
│        │                      ▼                             │            │
│        │       ┌──────────────────────────────┐            │            │
│        │       │    Summarization Service      │            │            │
│        │       │                                │            │            │
│        │       │  Ollama HTTP API              │◄───────────┘            │
│        │       │  POST localhost:11434         │──────────►│            │
│        │       │  Modèle configurable          │   sauvegarde            │
│        │       └──────────────────────────────┘            │            │
│        │                                                    │            │
├────────┼────────────────── IPC (contextBridge) ─────────────┼────────────┤
│        │                                                    │            │
│        ▼              PROCESSUS RENDERER (React)            ▼            │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                                                                 │    │
│  │  ┌─────────────┐  ┌──────────────────────────────────────────┐ │    │
│  │  │  Sidebar    │  │         Zone Centrale                     │ │    │
│  │  │             │  │                                            │ │    │
│  │  │ Liste des   │  │  ┌──────────┬──────────────┬───────────┐  │ │    │
│  │  │ réunions    │  │  │ Résumé   │ Transcription│  Notes    │  │ │    │
│  │  │             │  │  │          │              │           │  │ │    │
│  │  │ Recherche   │  │  │ Structuré│ [MOI] 00:02 │ Markdown  │  │ │    │
│  │  │ FTS5        │  │  │ Ollama   │ [EUX] 00:03 │ libre     │  │ │    │
│  │  │             │  │  │          │              │           │  │ │    │
│  │  │ Date        │  │  └──────────┴──────────────┴───────────┘  │ │    │
│  │  │ Durée       │  │                                            │ │    │
│  │  │ Titre       │  │  ┌──────────────────────────────────────┐  │ │    │
│  │  │             │  │  │ Barre de progression transcription   │  │ │    │
│  │  │             │  │  │ Chunk 3/9 - ~4 min restantes         │  │ │    │
│  │  │             │  │  └──────────────────────────────────────┘  │ │    │
│  │  └─────────────┘  └──────────────────────────────────────────┘ │    │
│  │                                                                 │    │
│  │  ┌──────────────────────────────────────────────────────────┐  │    │
│  │  │                    Settings                               │  │    │
│  │  │  Micro source │ BlackHole check │ Ollama check           │  │    │
│  │  │  Noms interlocuteurs │ Langue │ Prompt │ Stockage        │  │    │
│  │  └──────────────────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘

                        DÉPENDANCES EXTERNES
                        (installées sur le Mac)

┌────────────┐  ┌────────────┐  ┌─────────────────┐  ┌────────────┐
│    sox     │  │ BlackHole  │  │  Ollama         │  │  Python 3  │
│ (audio    │  │ 2ch        │  │  + Mistral 7B   │  │ (fallback  │
│  capture) │  │ (driver    │  │  localhost:11434 │  │  whisper)  │
│            │  │  virtuel)  │  │                 │  │            │
└────────────┘  └────────────┘  └─────────────────┘  └────────────┘
```

---

## 4. Flux de données de bout en bout

### 4.1: Phase d'enregistrement

```
Micro (AirPods/Mac)──► node-audiorecorder ──► me_chunk_001.wav (10 min)
                                               me_chunk_002.wav
                                               ...

BlackHole 2ch ────────► node-audiorecorder ──► others_chunk_001.wav (10 min)
                                               others_chunk_002.wav
                                               ...

Format : WAV PCM 16 bits, 16kHz, mono
Taille : ~18.75 MB par chunk de 10 min (16000 × 2 bytes × 600s)
Taille max pour 90 min : ~170 MB par flux, ~340 MB total
```

### 4.2: Phase de transcription (après arrêt de l'enregistrement)

```
me_chunk_001.wav ──────────────────────┐
me_chunk_002.wav ──────────────────────┤
...                                     │
                                        ▼
                              ┌──────────────────┐
                              │  whisper.cpp      │
                              │  large-v3         │
                              │                   │
                              │  Traitement       │
                              │  séquentiel par   │
                              │  chunk (pour      │
                              │  limiter la RAM)  │
                              └────────┬─────────┘
                                       │
                                       ▼
                              Segments timestampés :
                              { start: 0.00, end: 2.14, text: "..." }
                              { start: 2.14, end: 5.80, text: "..." }
                              ...

Même processus pour others_chunk_XXX.wav → segments timestampés séparés
```

### 4.3: Phase de diarisation (alignement)

```
Segments "MOI"             Segments "EUX"
(timestamps absolus)       (timestamps absolus)
       │                          │
       └──────────┬───────────────┘
                  │
                  ▼
       ┌─────────────────────┐
       │  Algorithme de      │
       │  merge temporel     │
       │                     │
       │  1. Trier tous les  │
       │     segments par    │
       │     timestamp start │
       │                     │
       │  2. Labelliser :    │
       │     [MOI] ou [EUX]  │
       │                     │
       │  3. Chevauchements :│
       │     garder les deux │
       │     segments avec   │
       │     leur label      │
       └─────────┬───────────┘
                 │
                 ▼
       Transcription unifiée :
       [MOI] 00:00:00 - "Bonjour, on commence ?"
       [EUX] 00:00:02 - "Oui, allons-y."
       [MOI] 00:00:05 - "Premier point : le budget..."
       [EUX] 00:00:08 - "J'ai les chiffres ici."
```

### 4.4: Phase de résumé

```
Transcription unifiée
       │
       ▼
┌──────────────────────────────────────────┐
│  Construction du prompt :                 │
│                                           │
│  SYSTÈME : {prompt personnalisable}       │
│                                           │
│  UTILISATEUR :                            │
│  "Voici la transcription d'une réunion    │
│   de {durée} entre {participants}.        │
│   Langue de sortie : {langue}.            │
│                                           │
│   {transcription complète}                │
│                                           │
│   Produis un résumé structuré avec :      │
│   - Titre                                 │
│   - Résumé exécutif                       │
│   - Points clés                           │
│   - Décisions prises                      │
│   - Actions à faire                       │
│   - Prochaines étapes"                    │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  POST http://localhost:11434/api/generate │
│  {                                        │
│    "model": "mistral",                    │
│    "prompt": "...",                        │
│    "stream": true                         │
│  }                                        │
└───────────────┬──────────────────────────┘
                │
                ▼
       Résumé structuré en Markdown
       sauvegardé dans SQLite
```

### 4.5: Gestion du contexte long (réunions > 30 min)

Mistral 7B a un contexte de 8K tokens (~6000 mots). Une réunion de 90 minutes
peut produire ~15 000 mots de transcription. Stratégie :

```
Transcription complète (15 000 mots)
       │
       ▼
┌──────────────────────────────────┐
│  Découpage en blocs de ~5000    │
│  mots avec chevauchement de     │
│  200 mots                        │
└──────────┬───────────────────────┘
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
  Bloc 1  Bloc 2  Bloc 3
     │     │     │
     ▼     ▼     ▼
  Résumé  Résumé  Résumé
  partiel partiel partiel
     │     │     │
     └─────┼─────┘
           │
           ▼
┌──────────────────────────────────┐
│  Résumé final : fusion des      │
│  résumés partiels en un seul    │
│  résumé structuré cohérent      │
└──────────────────────────────────┘
```

---

## 5. Architecture de diarisation deux flux

### 5.1: Capture parallèle

```typescript
// Pseudo-code simplifié
interface DualRecorder {
  // Les deux enregistreurs démarrent au même instant (Date.now())
  startTimestamp: number
  meRecorder: AudioRecorder // micro sélectionné
  othersRecorder: AudioRecorder // BlackHole 2ch
}
```

Les deux enregistreurs partagent le même `startTimestamp` (millisecondes Unix).
Chaque chunk de 10 minutes est nommé :

- `{meetingId}_me_chunk_{index}.wav`
- `{meetingId}_others_chunk_{index}.wav`

### 5.2: Alignement temporel

Les timestamps whisper sont relatifs au début du fichier WAV.
Pour obtenir des timestamps absolus :

```
timestamp_absolu = startTimestamp + (chunk_index × 10min) + timestamp_whisper
```

L'overlap de 30 secondes entre chunks est géré ainsi :

```
Chunk N :   [0:00 ──────────────────── 10:00]
Chunk N+1 :                    [9:30 ──────────────────── 19:30]
                                ^^^^
                              overlap 30s

Déduplication : pour chaque segment dans la zone d'overlap,
comparer le texte normalisé (lowercase, sans ponctuation).
Si similarité > 80% (distance de Levenshtein normalisée),
garder uniquement le segment du chunk N (celui qui a plus de contexte).
```

### 5.3: Merge des deux flux

```
Entrée :
  segments_moi   = [{start: 0.0, end: 2.1, text: "Bonjour"}, ...]
  segments_eux   = [{start: 0.5, end: 1.8, text: "Salut"}, ...]

Algorithme :
  1. Ajouter le label "speaker" à chaque segment :
     segments_moi.forEach(s => s.speaker = "MOI")
     segments_eux.forEach(s => s.speaker = "INTERLOCUTEUR")

  2. Fusionner les deux tableaux

  3. Trier par timestamp "start" croissant

  4. En cas de chevauchement (start_B < end_A) :
     → NE PAS supprimer - garder les deux segments
     → L'UI affichera les deux avec un indicateur visuel
       de parole simultanée

Sortie :
  TranscriptSegment[] trié par timestamp
```

---

## 6. Gestion des fichiers longs (90 min)

### 6.1: Rolling buffer sur disque

```
Pendant l'enregistrement :

Temps    0    10    20    30    40    50    60    70    80    90 min
         │─────│─────│─────│─────│─────│─────│─────│─────│─────│
Chunks : [  1  ][  2  ][  3  ][  4  ][  5  ][  6  ][  7  ][  8  ][  9  ]

Chaque chunk est un fichier WAV fermé proprement sur disque.
Si l'app crash au chunk 6, les chunks 1-5 sont intacts et récupérables.

Overlap :
Chunk 1 : [0:00 ──── 10:00]
Chunk 2 :        [9:30 ──── 19:30]
Chunk 3 :               [19:00 ──── 29:00]
...
```

### 6.2: Transcription séquentielle

```
Pourquoi séquentiel et pas parallèle :
- whisper.cpp large-v3 utilise ~3GB de RAM
- Lancer 2 instances = 6GB = swap sur 8GB de RAM
- Séquentiel : prévisible, stable, ~45s par chunk de 10 min
- 90 min = 9 chunks × 2 flux = 18 transcriptions
- Temps estimé : 18 × 45s = ~13.5 minutes
- Acceptable car l'utilisateur attend après la réunion

Ordre de traitement :
  me_chunk_1 → me_chunk_2 → ... → me_chunk_9
  → others_chunk_1 → others_chunk_2 → ... → others_chunk_9

Progression affichée :
  "Transcription en cours : chunk 3/18 - ~10 minutes restantes"
```

### 6.3: Budget mémoire

```
Composant                    RAM estimée
─────────────────────────────────────────
Electron (main + renderer)   ~200 MB
whisper.cpp modèle large-v3  ~3 GB (chargé une fois, réutilisé)
Buffer audio en cours         ~20 MB (1 chunk WAV en mémoire)
SQLite                        ~10 MB
Ollama (Mistral 7B)           ~4 GB (géré par Ollama, hors process)
─────────────────────────────────────────
TOTAL app Electron            ~3.2 GB (pic pendant transcription)
TOTAL avec Ollama             ~7.2 GB (pic pendant résumé)

Note : whisper.cpp et Ollama ne tournent JAMAIS en même temps.
Pic réel = max(3.2, 4.2+0.2) = ~4.4 GB hors whisper
Séquencement : Enregistrement → Transcription (whisper) → Résumé (Ollama)
```

**Objectif < 2GB pendant la transcription (hors modèle whisper) : ATTEINT**

- L'app elle-même consomme ~230 MB
- Le modèle whisper.cpp est un coût fixe de ~3GB, incompressible
- Le buffer audio est de ~20MB (un seul chunk en mémoire à la fois)

---

## 7. Base de données SQLite

### 7.1: Schéma complet

```sql
-- Migration 001_initial.sql

-- Table principale des réunions
CREATE TABLE meetings (
    id              TEXT PRIMARY KEY,          -- UUID v4
    title           TEXT NOT NULL DEFAULT '',  -- Titre auto-généré ou édité
    created_at      TEXT NOT NULL,             -- ISO 8601
    updated_at      TEXT NOT NULL,             -- ISO 8601
    duration_seconds INTEGER DEFAULT 0,       -- Durée en secondes
    status          TEXT NOT NULL DEFAULT 'recording',
                    -- 'recording' | 'transcribing' | 'summarizing' | 'complete' | 'error'
    speaker_me      TEXT NOT NULL DEFAULT 'MOI',
    speaker_others  TEXT NOT NULL DEFAULT 'INTERLOCUTEUR',
    notes_markdown  TEXT DEFAULT '',           -- Notes libres de l'utilisateur
    summary_markdown TEXT DEFAULT '',          -- Résumé généré par Ollama
    summary_model   TEXT DEFAULT '',           -- Modèle utilisé (ex: "mistral")
    summary_prompt  TEXT DEFAULT '',           -- Prompt utilisé (pour reproductibilité)
    language        TEXT DEFAULT 'fr',         -- Langue principale détectée
    error_message   TEXT DEFAULT NULL,         -- Message d'erreur si status='error'
    audio_path_me   TEXT DEFAULT '',           -- Chemin dossier chunks "moi"
    audio_path_others TEXT DEFAULT '',         -- Chemin dossier chunks "eux"
    audio_deleted   INTEGER DEFAULT 0          -- 1 si WAV supprimés après transcription
);

-- Segments de transcription
CREATE TABLE transcript_segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker         TEXT NOT NULL,             -- 'me' | 'others'
    start_time      REAL NOT NULL,             -- Secondes depuis début réunion
    end_time        REAL NOT NULL,             -- Secondes depuis début réunion
    text            TEXT NOT NULL,             -- Texte transcrit
    chunk_index     INTEGER NOT NULL,          -- Numéro du chunk source
    confidence      REAL DEFAULT NULL,         -- Score de confiance whisper (0-1)
    is_overlap      INTEGER DEFAULT 0          -- 1 si chevauchement avec autre flux
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id);
CREATE INDEX idx_segments_time ON transcript_segments(meeting_id, start_time);
CREATE INDEX idx_segments_speaker ON transcript_segments(meeting_id, speaker);
CREATE INDEX idx_meetings_created ON meetings(created_at DESC);
CREATE INDEX idx_meetings_status ON meetings(status);

-- Recherche full-text (FTS5)
CREATE VIRTUAL TABLE meetings_fts USING fts5(
    title,
    notes_markdown,
    summary_markdown,
    content='meetings',
    content_rowid='rowid'
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
    text,
    content='transcript_segments',
    content_rowid='rowid'
);

-- Triggers pour maintenir FTS synchronisé
CREATE TRIGGER meetings_ai AFTER INSERT ON meetings BEGIN
    INSERT INTO meetings_fts(rowid, title, notes_markdown, summary_markdown)
    VALUES (new.rowid, new.title, new.notes_markdown, new.summary_markdown);
END;

CREATE TRIGGER meetings_ad AFTER DELETE ON meetings BEGIN
    INSERT INTO meetings_fts(meetings_fts, rowid, title, notes_markdown, summary_markdown)
    VALUES ('delete', old.rowid, old.title, old.notes_markdown, old.summary_markdown);
END;

CREATE TRIGGER meetings_au AFTER UPDATE ON meetings BEGIN
    INSERT INTO meetings_fts(meetings_fts, rowid, title, notes_markdown, summary_markdown)
    VALUES ('delete', old.rowid, old.title, old.notes_markdown, old.summary_markdown);
    INSERT INTO meetings_fts(rowid, title, notes_markdown, summary_markdown)
    VALUES (new.rowid, new.title, new.notes_markdown, new.summary_markdown);
END;

CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO segments_fts(rowid, text)
    VALUES (new.rowid, new.text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
END;
```

```sql
-- Migration 002_add_speakers.sql

-- Table des configurations de participants par réunion
-- (permet d'avoir des noms différents par réunion)
CREATE TABLE meeting_speakers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_key     TEXT NOT NULL,             -- 'me' | 'others'
    display_name    TEXT NOT NULL,             -- Nom affiché (ex: "Thomas")
    UNIQUE(meeting_id, speaker_key)
);
```

### 7.2: Stratégie de migration

```
migrations/
├── 001_initial.sql
├── 002_add_speakers.sql
└── ...

Table interne de suivi :
CREATE TABLE IF NOT EXISTS _migrations (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    filename  TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
);

Au démarrage de l'app :
1. Lire tous les fichiers dans migrations/ triés par nom
2. Pour chaque fichier non présent dans _migrations :
   a. Exécuter le SQL dans une transaction
   b. Insérer dans _migrations
   c. Si erreur : rollback + log + message utilisateur
```

---

## 8. Stratégie de gestion des erreurs

### 8.1: Matrice des erreurs par composant

```
┌──────────────────┬──────────────────────┬─────────────────────────┬─────────────┐
│ Composant        │ Erreur possible      │ Stratégie               │ UI          │
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ AudioCapture     │ Micro non trouvé     │ Liste vide → message    │ Alerte      │
│                  │                      │ "Aucun micro détecté"   │ Settings    │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ BlackHole absent     │ Détection au démarrage  │ Lien de     │
│                  │                      │ + vérification Settings │ download    │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Permission micro     │ Ouvrir Préf. Système    │ Guide pas   │
│                  │ refusée              │ macOS automatiquement   │ à pas       │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ sox non installé     │ Proposer `brew install  │ Commande à  │
│                  │                      │ sox` automatiquement    │ copier      │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Disque plein         │ Vérifier espace avant   │ Alerte      │
│                  │                      │ enregistrement (>500MB) │ bloquante   │
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ ChunkManager     │ Écriture fichier     │ Retry 3x avec backoff   │ Notification│
│                  │ échoue               │ Si échec : stopper      │ d'erreur    │
│                  │                      │ proprement              │             │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Crash app pendant    │ Chunks fermés sur disque│ Récupération│
│                  │ enregistrement       │ = récupérables au       │ automatique │
│                  │                      │ prochain lancement      │ au démarrage│
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ Transcription    │ nodejs-whisper ne    │ Fallback Python auto    │ Notification│
│                  │ compile pas          │ + log de la raison      │ "mode lent" │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ whisper plante sur   │ Loguer l'erreur,        │ Indicateur  │
│                  │ un chunk             │ continuer les autres,   │ "[gap]" dans│
│                  │                      │ marquer le gap          │ transcription│
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ OOM (mémoire)        │ Réduire à modèle medium │ Notification│
│                  │                      │ et retenter             │ qualité     │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Modèle whisper       │ Téléchargement auto     │ Barre de    │
│                  │ non trouvé           │ au premier lancement    │ progression │
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ Diarisation      │ Décalage temporel    │ Tolérance de ±500ms     │ Transparent │
│                  │ entre les 2 flux     │ sur l'alignement        │             │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Un flux vide         │ Tout attribuer à        │ Note dans   │
│                  │ (silence complet)    │ l'autre speaker         │ le résumé   │
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ Summarization    │ Ollama non démarré   │ Transcription dispo     │ Bouton      │
│                  │                      │ immédiatement, résumé   │ "Réessayer" │
│                  │                      │ en attente              │             │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Modèle non installé  │ Proposer `ollama pull   │ Commande à  │
│                  │                      │ mistral`                │ copier      │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Timeout (>5min)      │ Abort + proposer retry  │ Bouton      │
│                  │                      │ avec modèle plus petit  │ "Réessayer" │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Contexte trop long   │ Découpage automatique   │ Transparent │
│                  │                      │ en blocs (voir §4.5)   │             │
├──────────────────┼──────────────────────┼─────────────────────────┼─────────────┤
│ Database         │ Fichier corrompu     │ Backup automatique      │ Restauration│
│                  │                      │ quotidien, restauration │ proposée    │
│                  ├──────────────────────┼─────────────────────────┼─────────────┤
│                  │ Migration échoue     │ Rollback transaction    │ Message     │
│                  │                      │ + log détaillé          │ d'erreur    │
└──────────────────┴──────────────────────┴─────────────────────────┴─────────────┘
```

### 8.2: Pattern de gestion d'erreur

Chaque service expose des résultats typés, jamais d'exceptions non attrapées :

```typescript
// Pattern Result<T, E> utilisé partout
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

// Chaque appel IPC retourne un Result
// Le renderer ne reçoit JAMAIS une exception non gérée
```

---

## 9. Décisions de performance

### 9.1: Enregistrement audio

| Décision                    | Raison                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| WAV 16kHz mono              | Minimise la taille (vs 44.1kHz stéréo = 5.5x plus gros) sans perte de qualité pour la parole.       |
| Chunks 10 min               | Équilibre entre fréquence d'écriture disque et risque de perte. 10 min = ~18MB, raisonnable en RAM. |
| Écriture directe sur disque | Pas de buffer en mémoire au-delà du chunk en cours. Si RAM < 8GB, critique.                         |
| Deux processus sox séparés  | Isolés l'un de l'autre. Si un flux plante, l'autre continue.                                        |

### 9.2: Transcription

| Décision                     | Raison                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Séquentiel, pas parallèle    | Un seul modèle whisper en mémoire = ~3GB. Deux instances = swap garanti sur 8GB.               |
| Chunk par chunk              | Jamais tout le fichier 90min en mémoire. Pic RAM = modèle + 1 chunk.                           |
| Overlap 30s                  | Couvre la phrase la plus longue raisonnablement attendue.                                      |
| Déduplication par similarité | Levenshtein normalisé > 80% = même phrase. Simple, efficace, pas de faux positifs en pratique. |

### 9.3: Interface

| Décision                   | Raison                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Virtualisation liste       | Si > 100 réunions, la sidebar utilise une liste virtuelle (react-window) pour ne rendre que les éléments visibles. |
| Lazy loading transcription | Les segments ne sont chargés depuis SQLite que quand l'onglet Transcription est ouvert.                            |
| Debounce recherche FTS     | 300ms de debounce sur la saisie pour éviter des requêtes SQLite à chaque frappe.                                   |
| Debounce sauvegarde notes  | 1000ms de debounce sur l'éditeur Markdown pour éviter des écritures SQLite continues.                              |

---

## 10. Sécurité et isolation des processus

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                  │
│                                                           │
│  ✓ Accès Node.js complet                                 │
│  ✓ Accès système de fichiers                             │
│  ✓ Spawn child_process (sox, whisper, python)            │
│  ✓ SQLite via better-sqlite3                             │
│  ✓ HTTP vers localhost:11434 (Ollama)                    │
│  ✗ AUCUNE requête réseau externe                         │
│  ✗ AUCUN accès à des serveurs distants                   │
│                                                           │
├─────────────── contextBridge (preload.ts) ───────────────┤
│                                                           │
│  API exposée au renderer (whitelist stricte) :            │
│                                                           │
│  window.api.recording.start()                            │
│  window.api.recording.stop()                             │
│  window.api.recording.getStatus()                        │
│  window.api.meetings.list(filter)                        │
│  window.api.meetings.get(id)                             │
│  window.api.meetings.updateNotes(id, markdown)           │
│  window.api.meetings.delete(id)                          │
│  window.api.meetings.search(query)                       │
│  window.api.transcription.getProgress()                  │
│  window.api.summarization.retry(id)                      │
│  window.api.settings.get()                               │
│  window.api.settings.update(partial)                     │
│  window.api.system.getAudioDevices()                     │
│  window.api.system.checkDependencies()                   │
│  window.api.system.getOllamaModels()                     │
│                                                           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│                  Electron Renderer Process                │
│                                                           │
│  ✓ React + TypeScript + Tailwind                         │
│  ✗ AUCUN accès à Node.js                                 │
│  ✗ AUCUN accès au système de fichiers                    │
│  ✗ AUCUN accès réseau (CSP strict)                       │
│  ✗ Uniquement window.api.* via contextBridge             │
│                                                           │
└─────────────────────────────────────────────────────────┘

Content-Security-Policy :
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';    // Requis par Tailwind
  connect-src 'self';
  img-src 'self' data:;
```

---

## 11. Plan de migration des dépendances

### 11.1: Si whisper.cpp est remplacé

```
Situation : nodejs-whisper abandonné ou whisper.cpp remplacé par un meilleur moteur.

Interface actuelle (transcription.ts) :
  transcribeChunk(wavPath: string, options: TranscribeOptions): Promise<TranscriptSegment[]>

Migration :
  1. Le contrat d'interface ne change PAS
  2. Créer un nouveau fichier (ex: transcription-mlx.ts)
     qui implémente la même interface
  3. Modifier la factory dans transcription.ts pour
     instancier le nouveau moteur
  4. L'ancien moteur reste comme fallback

Candidats potentiels :
  - MLX Whisper (Apple, optimisé Metal)
  - faster-whisper (CTranslate2)
  - Whisper.cpp successeur
```

### 11.2: Si Ollama est remplacé

```
Situation : Ollama abandonné ou API modifiée.

Interface actuelle (summarization.ts) :
  generateSummary(transcript: string, options: SummaryOptions): Promise<string>

Migration :
  1. L'interface abstraite ne change PAS
  2. Le service appelle une URL configurable avec un format configurable
  3. Alternatives compatibles :
     - llama.cpp serveur HTTP natif (même format API)
     - LocalAI (compatible API OpenAI)
     - LM Studio (compatible API OpenAI)
  4. Ajouter un sélecteur "backend LLM" dans Settings
```

### 11.3: Si better-sqlite3 pose problème

```
Situation : Incompatibilité ARM ou abandon du package.

Migration :
  1. sql.js (SQLite compilé en WebAssembly, zéro binding natif)
  2. L'interface Database expose des méthodes, pas du SQL brut
  3. Les migrations SQL restent identiques
  4. Seul database.ts change
```

### 11.4: Si Electron est remplacé

```
Situation : Migration vers Tauri ou une app native.

Impact minimal grâce à la séparation :
  - Services (audio, transcription, diarisation, résumé) :
    Pur Node.js/TypeScript, aucune dépendance Electron.
    Réutilisables tels quels.
  - UI React : Réutilisable dans Tauri (WebView).
  - Seuls main.ts, preload.ts et tray.ts sont spécifiques Electron.
```

---

## 12. Structure du projet

```
muesli/
├── electron/
│   ├── main.ts                  # Process principal, création fenêtre, IPC handlers
│   ├── preload.ts               # contextBridge - API exposée au renderer
│   └── tray.ts                  # Icône barre de menu, raccourcis globaux
│
├── src/
│   ├── components/
│   │   ├── MeetingList/
│   │   │   ├── MeetingList.tsx          # Sidebar avec liste et recherche
│   │   │   └── MeetingListItem.tsx      # Un élément de la liste
│   │   ├── MeetingDetail/
│   │   │   ├── MeetingDetail.tsx        # Container des 3 onglets
│   │   │   ├── SummaryTab.tsx           # Résumé structuré Ollama
│   │   │   ├── TranscriptTab.tsx        # Timeline [MOI]/[INTERLOCUTEUR]
│   │   │   └── NotesTab.tsx             # Éditeur Markdown
│   │   ├── Settings/
│   │   │   ├── Settings.tsx             # Page Settings complète
│   │   │   ├── AudioSettings.tsx        # Sélection micro + vérif BlackHole
│   │   │   ├── OllamaSettings.tsx       # Vérif Ollama + choix modèle
│   │   │   └── PromptSettings.tsx       # Prompt personnalisable
│   │   ├── RecordingIndicator.tsx       # Indicateur enregistrement en cours
│   │   └── ProgressBar.tsx              # Barre de progression transcription
│   │
│   ├── services/
│   │   ├── audioCapture.ts      # Gestion deux flux parallèles via sox
│   │   ├── chunkManager.ts      # Découpage rolling buffer + overlap
│   │   ├── transcription.ts     # whisper.cpp + fallback Python
│   │   ├── diarization.ts       # Alignement temporel + merge deux flux
│   │   ├── summarization.ts     # Ollama HTTP API
│   │   └── database.ts          # SQLite + migrations + FTS
│   │
│   ├── hooks/
│   │   ├── useRecording.ts      # État enregistrement pour le renderer
│   │   └── useMeetings.ts       # CRUD réunions + recherche
│   │
│   ├── types/
│   │   └── index.ts             # Tous les types TypeScript partagés
│   │
│   └── App.tsx                  # Composant racine React
│
├── python/
│   └── transcribe.py            # Fallback : whisper Python si nodejs-whisper KO
│
├── migrations/
│   ├── 001_initial.sql          # Schéma initial complet
│   └── 002_add_speakers.sql     # Table meeting_speakers
│
├── assets/
│   ├── tray-icon.png            # Icône tray (16x16, 32x32)
│   ├── tray-icon-recording.png  # Icône tray pendant enregistrement
│   └── app-icon.icns            # Icône application macOS
│
├── ARCHITECTURE.md              # Ce document
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── electron-builder.yml         # Config de build/packaging
└── README.md                    # Guide d'installation débutant complet
```

---

## Annexe A: Dépendances externes à installer

L'utilisateur devra installer ces outils avant de lancer l'app.
Le README fournira des instructions pas à pas.

| Outil            | Installation                              | Vérification                    | Obligatoire                   |
| ---------------- | ----------------------------------------- | ------------------------------- | ----------------------------- |
| Node.js 20+      | `brew install node`                       | `node --version`                | OUI                           |
| sox              | `brew install sox`                        | `sox --version`                 | OUI                           |
| BlackHole 2ch    | Téléchargement .pkg sur existential.audio | Vérifier dans Préf. Audio macOS | OUI                           |
| Ollama           | `brew install ollama`                     | `ollama --version`              | OUI (pour résumé)             |
| Mistral (modèle) | `ollama pull mistral`                     | `ollama list`                   | OUI (pour résumé)             |
| Python 3         | Déjà installé sur macOS                   | `python3 --version`             | NON (fallback uniquement)     |
| pip whisper      | `pip3 install openai-whisper`             | `python3 -c "import whisper"`   | NON (fallback uniquement)     |
| Xcode CLI Tools  | `xcode-select --install`                  | `xcode-select -p`               | OUI (compilation whisper.cpp) |

---

## Annexe B: Configuration audio macOS requise

```
Pour capturer l'audio système (ce que disent les interlocuteurs),
l'utilisateur doit configurer un "Multi-Output Device" dans macOS :

1. Ouvrir "Configuration audio et MIDI" (chercher dans Spotlight)
2. Cliquer "+" en bas à gauche → "Créer un périphérique à sorties multiples"
3. Cocher :
   ✓ BlackHole 2ch
   ✓ Haut-parleurs intégrés (ou casque)
4. Dans Préférences Système → Son → Sortie :
   Sélectionner le "Multi-Output Device" créé

Résultat : le son sort dans le casque ET dans BlackHole simultanément.
L'app capture BlackHole = elle entend ce que les interlocuteurs disent.
```

---

## Annexe C: Prompt système par défaut pour le résumé

```
Tu es un assistant spécialisé dans la prise de notes de réunions.
Tu reçois la transcription d'une réunion avec des labels [MOI] et [INTERLOCUTEUR].

Produis un résumé structuré en français avec les sections suivantes :

## Titre
Un titre court et descriptif pour cette réunion.

## Informations
- Durée : {durée}
- Participants : {noms}

## Résumé exécutif
5 à 8 lignes résumant les points essentiels.

## Points clés discutés
Liste à puces des sujets abordés.

## Décisions prises
Liste des décisions actées pendant la réunion. Si aucune, écrire "Aucune décision formelle."

## Actions à faire
Liste des actions avec, si mentionné :
- Responsable
- Deadline
Si aucune action, écrire "Aucune action identifiée."

## Prochaines étapes
Ce qui est prévu pour la suite.

Règles :
- Reste factuel, ne brode pas
- Utilise les vrais noms des interlocuteurs si disponibles
- Si quelque chose n'est pas clair dans la transcription, indique "[peu clair dans l'audio]"
- Écris en français sauf si la réunion est entièrement en anglais
```

---

> **Ce document doit être validé avant toute implémentation.**
> Toute modification de l'architecture après validation devra être documentée ici.
