/**
 * Tests for the new /api/* dashboard endpoints. We instantiate a
 * DashboardState directly against a tmpdir SessionsPaths and call its
 * serve* methods, then assert on the JSON body. No real HTTP server — the
 * route dispatch lives in node.ts and would just be a thin re-export of the
 * same calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DashboardState, dashboardPath } from '../src/dashboard.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';

function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpipe-dashapi-'));
  return {
    eventsFile: path.join(dir, 'events.jsonl'),
    sidecarDir: path.join(dir, '4xx-bodies'),
  };
}

function ev(p: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-19T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...p,
  };
}

function writeEvents(paths: SessionsPaths, events: TrackEvent[]): void {
  fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
  fs.writeFileSync(
    paths.eventsFile,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

let tmp: SessionsPaths;
let dash: DashboardState;
beforeEach(() => {
  tmp = makeTmp();
  // Inject an empty Claude Code map so tests don't scan the developer's real
  // ~/.claude/projects/ directory (slow + flaky depending on which machine
  // the suite runs on). Tests that need a populated map can re-construct.
  dash = new DashboardState(tmp, async () => new Map());
});
afterEach(() => {
  try {
    fs.rmSync(path.dirname(tmp.eventsFile), { recursive: true, force: true });
  } catch {
    /* leak the tmpdir; OS will reap */
  }
});

// ---- dashboardPath route table -------------------------------------------

describe('dashboardPath()', () => {
  it('matches the main HTML routes', () => {
    expect(dashboardPath('/')?.kind).toBe('html');
    expect(dashboardPath('/dashboard')?.kind).toBe('html');
  });

  it('matches the legacy live-poll routes', () => {
    expect(dashboardPath('/proxy-stats')?.kind).toBe('stats');
    expect(dashboardPath('/proxy-recent')?.kind).toBe('recent');
    expect(dashboardPath('/proxy-latest-png')?.kind).toBe('png');
  });

  it('matches the new /api/* routes', () => {
    expect(dashboardPath('/api/sessions.json')?.kind).toBe('api-sessions');
    expect(dashboardPath('/api/disk.json')?.kind).toBe('api-disk');
    expect(dashboardPath('/api/stats.json')?.kind).toBe('api-stats');
    expect(dashboardPath('/api/sessions/prune')?.kind).toBe('api-prune');
  });

  it('extracts session IDs from dynamic paths', () => {
    const r1 = dashboardPath('/api/sessions/abc12345.json');
    expect(r1?.kind).toBe('api-session');
    if (r1?.kind === 'api-session') expect(r1.sessionId).toBe('abc12345');

    const r2 = dashboardPath('/sessions/abc12345');
    expect(r2?.kind).toBe('session-html');
    if (r2?.kind === 'session-html') expect(r2.sessionId).toBe('abc12345');
  });

  it('returns null for unknown paths', () => {
    expect(dashboardPath('/v1/messages')).toBeNull();
    expect(dashboardPath('/api/whatever.json')).toBeNull();
    // Path-traversal style requests must not match the session regex.
    expect(dashboardPath('/sessions/../etc/passwd')).toBeNull();
  });
});

// ---- /api/sessions.json --------------------------------------------------

describe('serveSessionsJson', () => {
  it('returns a list of grouped sessions with claudeCode null when no ~/.claude/projects/ match', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:00:00Z' }),
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:01:00Z' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/y', ts: '2026-05-19T00:02:00Z' }),
    ]);
    const res = await dash.serveSessionsJson();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.sessions).toHaveLength(2);
    // Most-recent-first
    expect(body.sessions[0].id).toBe('bbbbbbbb');
    expect(body.sessions[1].id).toBe('aaaaaaaa');
    expect(body.sessions[0].claudeCode).toBeNull();
  });

  it('respects ?project filtering', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/Users/me/code/pixelpipe' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/Users/me/code/other' }),
    ]);
    const res = await dash.serveSessionsJson({ project: 'pixelpipe' });
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.sessions[0].id).toBe('aaaaaaaa');
  });

  it('returns 503 when DashboardState was built without paths', async () => {
    const bare = new DashboardState();
    const res = await bare.serveSessionsJson();
    expect(res.status).toBe(503);
  });
});

// ---- /api/sessions/${id}.json --------------------------------------------

describe('serveSessionJson', () => {
  it('returns events for the matching id', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'abc12345', ts: '2026-05-19T00:00:00Z' }),
      ev({ first_user_sha8: 'abc12345', ts: '2026-05-19T00:01:00Z' }),
      ev({ first_user_sha8: 'def67890', ts: '2026-05-19T00:02:00Z' }),
    ]);
    const res = await dash.serveSessionJson('abc12345', false);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('abc12345');
    expect(body.events).toHaveLength(2);
    expect(body.includeBodies).toBe(false);
  });

  it('redacts body fields by default', async () => {
    writeEvents(tmp, [
      ev({
        first_user_sha8: 'abc12345',
        error_body: '{"x":1}',
        req_body_sample_path: '/tmp/secret.gz',
      }),
    ]);
    const res = await dash.serveSessionJson('abc12345', false);
    const body = await res.json();
    expect(body.events[0].error_body).toBeUndefined();
    expect(body.events[0].req_body_sample_path).toBeUndefined();
  });

  it('keeps body fields when includeBodies=true', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'abc12345', error_body: '{"x":1}' }),
    ]);
    const res = await dash.serveSessionJson('abc12345', true);
    const body = await res.json();
    expect(body.events[0].error_body).toBe('{"x":1}');
    expect(body.includeBodies).toBe(true);
  });

  it('returns 404 for an unknown session', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'abc12345' })]);
    const res = await dash.serveSessionJson('nothere', false);
    expect(res.status).toBe(404);
  });
});

// ---- /api/disk.json + /api/stats.json ------------------------------------

describe('serveDiskJson', () => {
  it('returns events.jsonl + sidecar totals', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: 'a' })]);
    fs.mkdirSync(tmp.sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(tmp.sidecarDir, 's1.json.gz'), Buffer.alloc(123));
    const res = dash.serveDiskJson();
    const body = await res.json();
    expect(body.eventsJsonlBytes).toBeGreaterThan(0);
    expect(body.sidecarsBytes).toBe(123);
    expect(body.sidecarCount).toBe(1);
    expect(body.paths.eventsFile).toBe(tmp.eventsFile);
  });
});

describe('serveApiStats', () => {
  it('aggregates the events file into a Summary-shaped JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, compressed: true, orig_chars: 1000, image_bytes: 200 }),
      ev({ status: 200, compressed: true, orig_chars: 2000, image_bytes: 300 }),
      ev({ status: 400, compressed: false }),
    ]);
    const res = await dash.serveApiStats();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed).toBe(3);
    expect(body.summary.total).toBe(3);
    expect(body.summary.ok2xx).toBe(2);
    expect(body.summary.err4xx).toBe(1);
    expect(body.summary.compressed).toBe(2);
    expect(body.summary.passthrough).toBe(1);
    expect(body.summary.origCharsTotal).toBe(3000);
    expect(body.summary.imageBytesTotal).toBe(500);
  });

  it('404s when no events file exists', async () => {
    const res = await dash.serveApiStats();
    expect(res.status).toBe(404);
  });
});

// ---- POST /api/sessions/prune --------------------------------------------

describe('handlePrune', () => {
  it('dry-runs by default (force=false reports but does not delete)', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'old', ts: '2026-01-01T00:00:00Z' }),
      ev({ first_user_sha8: 'new', ts: '2026-05-19T00:00:00Z' }),
    ]);
    const before = fs.readFileSync(tmp.eventsFile, 'utf8');
    const res = await dash.handlePrune({ force: false, olderThanDays: 30 });
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.sessionsRemoved).toContain('old');
    expect(fs.readFileSync(tmp.eventsFile, 'utf8')).toBe(before);
  });

  it('actually rewrites events.jsonl when force=true', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'old', ts: '2026-01-01T00:00:00Z' }),
      ev({ first_user_sha8: 'new', ts: '2026-05-19T00:00:00Z' }),
    ]);
    const res = await dash.handlePrune({ force: true, sessionId: 'old' });
    const body = await res.json();
    expect(body.applied).toBe(true);
    const remaining = fs
      .readFileSync(tmp.eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TrackEvent);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.first_user_sha8).toBe('new');
  });
});

// ---- session-html template ------------------------------------------------

describe('serveSessionHtml', () => {
  it('interpolates the session id into the template', () => {
    const res = dash.serveSessionHtml('abc12345', 47821);
    expect(res.headers.get('content-type')).toContain('text/html');
    // Server-side template substitution happened (id appears in title + h1).
    return res.text().then((html) => {
      expect(html).toContain('abc12345');
      expect(html).toContain('/api/sessions/');
    });
  });
});
