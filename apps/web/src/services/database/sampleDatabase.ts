/**
 * Bundled sample database (FINAL_PROJECT_PLAN Week 5). The schema is created by
 * running this script through the normal execution contract, never by reaching
 * around it into the worker. The music dataset deliberately covers every
 * explorer surface: tables, a view, PK/UNIQUE/FK/CHECK constraints, explicit
 * indexes, and enough rows for paging.
 */

export const SAMPLE_DATABASE_NAME = "Sample database";

export interface DemoQuery {
  title: string;
  description: string;
  sql: string;
}

export const SAMPLE_SCHEMA_SQL = `-- Music library sample: artists → albums → tracks, plus playlists.
CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'Unknown',
  formed_year INTEGER CHECK (formed_year IS NULL OR formed_year BETWEEN 1900 AND 2100)
);

CREATE TABLE albums (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  released_year INTEGER NOT NULL CHECK (released_year BETWEEN 1900 AND 2100)
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  track_no INTEGER NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds > 0),
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  UNIQUE (album_id, track_no)
);

CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX idx_albums_artist ON albums(artist_id);
CREATE INDEX idx_tracks_album ON tracks(album_id);
CREATE INDEX idx_tracks_rating ON tracks(rating);

CREATE VIEW album_track_counts AS
SELECT albums.id AS album_id,
       albums.title AS album,
       artists.name AS artist,
       COUNT(tracks.id) AS track_count,
       COALESCE(SUM(tracks.seconds), 0) AS total_seconds
FROM albums
JOIN artists ON artists.id = albums.artist_id
LEFT JOIN tracks ON tracks.album_id = albums.id
GROUP BY albums.id, albums.title, artists.name;

INSERT INTO artists (name, country, formed_year) VALUES
  ('Nova Lane', 'UK', 1998),
  ('Paper Satellites', 'US', 2004),
  ('The Quiet Hours', 'CA', 2011),
  ('Harbor & Pine', 'SE', 2007),
  ('Glass Meridian', 'DE', 2014),
  ('Midnight Cartography', 'US', 2010),
  ('Copper Skyline', 'AU', 2016),
  ('Amber Fields', 'IE', 2001),
  ('Signal Bloom', 'JP', 2013),
  ('Low Tide Radio', 'NZ', 2009),
  ('Northbound Static', 'NO', 2018),
  ('Sunday Echoes', 'BR', 2005);

INSERT INTO albums (artist_id, title, released_year)
SELECT ((i - 1) % 12) + 1,
       'Album ' || printf('%02d', i),
       1995 + (i % 28)
FROM (WITH RECURSIVE seq(i) AS (
        SELECT 1
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 24
      )
      SELECT i FROM seq);

INSERT INTO tracks (album_id, title, track_no, seconds, rating)
SELECT ((i - 1) / 5) + 1,
       'Track ' || printf('%03d', i),
       ((i - 1) % 5) + 1,
       120 + ((i * 37) % 240),
       CASE WHEN i % 17 = 0 THEN NULL ELSE 1 + (i % 5) END
FROM (WITH RECURSIVE seq(i) AS (
        SELECT 1
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 120
      )
      SELECT i FROM seq);

INSERT INTO playlists (name) VALUES
  ('Morning focus'),
  ('Long drive'),
  ('Deep work'),
  ('Weekend slow'),
  ('Late night'),
  ('Rainy afternoon');

INSERT INTO playlist_tracks (playlist_id, track_id, position)
SELECT ((i - 1) / 10) + 1,
       i,
       ((i - 1) % 10) + 1
FROM (WITH RECURSIVE seq(i) AS (
        SELECT 1
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 60
      )
      SELECT i FROM seq);
`;

export const DEMO_QUERIES: DemoQuery[] = [
  {
    title: "Albums per artist",
    description: "LEFT JOIN + GROUP BY, including artists with no albums yet.",
    sql: `SELECT artists.name AS artist,
       artists.country,
       COUNT(albums.id) AS album_count
FROM artists
LEFT JOIN albums ON albums.artist_id = artists.id
GROUP BY artists.id, artists.name, artists.country
ORDER BY album_count DESC, artists.name
LIMIT 20;`,
  },
  {
    title: "Top rated tracks",
    description: "Join tracks to albums and filter on the rating column.",
    sql: `SELECT tracks.title,
       albums.title AS album,
       tracks.seconds,
       tracks.rating
FROM tracks
JOIN albums ON albums.id = tracks.album_id
WHERE tracks.rating >= 4
ORDER BY tracks.rating DESC, tracks.seconds DESC
LIMIT 25;`,
  },
  {
    title: "Album totals (view)",
    description: "The album_track_counts view aggregates tracks per album.",
    sql: `SELECT *
FROM album_track_counts
ORDER BY total_seconds DESC
LIMIT 20;`,
  },
  {
    title: "Playlist contents",
    description: "Many-to-many walk through playlist_tracks.",
    sql: `SELECT playlists.name AS playlist,
       playlist_tracks.position,
       tracks.title,
       albums.title AS album
FROM playlists
JOIN playlist_tracks ON playlist_tracks.playlist_id = playlists.id
JOIN tracks ON tracks.id = playlist_tracks.track_id
JOIN albums ON albums.id = tracks.album_id
ORDER BY playlists.name, playlist_tracks.position
LIMIT 30;`,
  },
  {
    title: "Index check: rating = 5",
    description: "Uses idx_tracks_rating; run Explain to inspect the plan.",
    sql: `SELECT id, title, rating
FROM tracks
WHERE rating = 5
LIMIT 20;`,
  },
];
