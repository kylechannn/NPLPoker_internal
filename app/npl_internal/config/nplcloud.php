<?php

declare(strict_types=1);

/**
 * The single source of truth for what "update everything" means.
 *
 * EdgeHost duplicated its entity list in three places (React constant, Go
 * slice, PHP array) and they drifted, so the same button meant different
 * things depending on which path triggered it. Here the manifest lives in
 * one file; the local API exposes it at /api/v1/sync/manifest so the Go
 * host and both UIs read the same list instead of hardcoding their own.
 */
return [
    'base' => rtrim((string) env('NPL_CLOUD_BASE', 'https://api.nplpokerclub.com.au'), '/'),

    'timeouts' => [
        'connect' => (int) env('NPL_CLOUD_CONNECT_TIMEOUT', 10),
        'request' => (int) env('NPL_CLOUD_TIMEOUT', 30),
        'media' => (int) env('NPL_CLOUD_MEDIA_TIMEOUT', 60),
    ],

    'verify_ssl' => filter_var(env('NPL_CLOUD_VERIFY_SSL', true), FILTER_VALIDATE_BOOLEAN),

    /**
     * CA bundle for TLS verification. The portable php.exe we ship has no
     * system certificate store, so `verify => true` dies with cURL error 60
     * on every venue machine. We bundle the Mozilla roots and point curl at
     * them; NPL_CLOUD_CA_BUNDLE overrides the path if a venue ever needs a
     * corporate proxy's certificate chain instead.
     */
    'ca_bundle' => env('NPL_CLOUD_CA_BUNDLE'),

    /**
     * Every syncable entity. `endpoint` is pulled with the CD-Key headers;
     * `table` is the local mirror; `unique` is the natural key used to
     * detect drift; `media` lists columns holding image URLs to cache.
     *
     * Order matters — parents first, so foreign keys resolve on swap.
     */
    'entities' => [
        'venues' => [
            'label' => 'Venues',
            'endpoint' => '/api/v1/venues',
            'table' => 'mirror_venues',
            'unique' => 'cloud_id',
            'media' => ['image_url'],
        ],
        'game_sessions' => [
            'label' => 'Game sessions',
            'endpoint' => '/api/v1/game-sessions',
            'query' => ['all' => 1],
            'table' => 'mirror_game_sessions',
            'unique' => 'session_id',
            'media' => ['image_url', 'hero_image_url'],
        ],
        'game_entities' => [
            'label' => 'Games (templates the venue hosts from)',
            'mode' => 'delta',
            'table' => 'mirror_game_entities',
        ],
        'players' => [
            'label' => 'Players',
            'mode' => 'delta',
            'table' => 'mirror_players',
            'avatars' => true,
        ],
        'player_relationships' => [
            'label' => 'Friends & block lists',
            'mode' => 'delta',
            'table' => 'mirror_player_relationships',
        ],
        'wheel_prizes' => [
            'label' => 'Jackpot wheel',
            'mode' => 'delta',
            'table' => 'mirror_wheel_prizes',
        ],
        'seating' => [
            'label' => 'Tables & seats',
            // Fanned out per session by the sync service — see SyncService.
            'endpoint' => '/api/v1/game-sessions/{session_id}/seating',
            'table' => 'mirror_session_tables',
            'unique' => 'session_table_key',
            'depends_on' => 'game_sessions',
        ],
    ],

    /** Local media cache — content-addressed, served under /media/... */
    'media' => [
        'disk_path' => env('NPL_MEDIA_PATH'),
        'max_bytes' => (int) env('NPL_MEDIA_MAX_BYTES', 8 * 1024 * 1024),
        'concurrency' => (int) env('NPL_MEDIA_CONCURRENCY', 6),
    ],

    'outbox' => [
        'max_attempts' => (int) env('NPL_OUTBOX_MAX_ATTEMPTS', 12),
        'chunk' => (int) env('NPL_OUTBOX_CHUNK', 20),
    ],
];
