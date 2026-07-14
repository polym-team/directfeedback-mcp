#!/usr/bin/env node
// DirectFeedback MCP 서버 (stdio) — 미해결 코멘트를 Claude Code 에 노출.
//
// 인증: OAuth 2.1 Authorization Code + PKCE (루프백 리다이렉트).
//   최초 1회  `directfeedback-mcp login`  으로 브라우저 로그인 → 토큰 캐시.
//   서버는 캐시된 access token 사용, 만료 시 refresh token 으로 자동 갱신.
//   클라이언트에 어떤 비밀값도 두지 않는다(마스터키 mint 폐기).
//
// 서브커맨드:
//   login    브라우저 로그인 후 토큰 저장
//   logout   refresh token 폐기 + 로컬 토큰 삭제
//   (없음)   MCP stdio 서버 시작
//
// 환경변수:
//   DIRECTFEEDBACK_API   백엔드 base URL (기본 https://directfeedback.polymorph.co.kr)
//   OAUTH_ISSUER         oauth-server base URL (기본 https://oauth.polymorph.co.kr)
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.DIRECTFEEDBACK_API || 'https://directfeedback.polymorph.co.kr';
const ISSUER = (process.env.OAUTH_ISSUER || 'https://oauth.polymorph.co.kr').replace(/\/$/, '');
const CLIENT_ID = 'direct-feedback';
const LOGIN_HINT = '`npx @polym-team/directfeedback-mcp login` 을 먼저 실행하세요.';

// ── 토큰 저장소 (~/.config/directfeedback-mcp/tokens.json, 0600) ──────────────
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'directfeedback-mcp',
);
const TOKEN_PATH = path.join(CONFIG_DIR, 'tokens.json');

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeTokens(tok) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
}

// ── OAuth 디스커버리 ─────────────────────────────────────────────────────────
let metaCache = null;
async function discover() {
  if (metaCache) return metaCache;
  try {
    const res = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
    if (res.ok) {
      metaCache = await res.json();
      return metaCache;
    }
  } catch {
    /* 폴백으로 진행 */
  }
  metaCache = {
    authorization_endpoint: `${ISSUER}/api/oauth/authorize`,
    token_endpoint: `${ISSUER}/api/oauth/token`,
    revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
  };
  return metaCache;
}

// ── PKCE ────────────────────────────────────────────────────────────────────
const b64url = (buf) => buf.toString('base64url');
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 실패해도 URL 을 출력했으므로 수동으로 열 수 있음 */
  }
}

// ── 토큰 교환 / 갱신 ──────────────────────────────────────────────────────────
async function postToken(body) {
  const meta = await discover();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `token endpoint HTTP ${res.status}`);
  }
  return data;
}

function saveFromTokenResponse(data) {
  const tok = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  writeTokens(tok);
  return tok;
}

async function refreshTokens(refreshToken) {
  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  return saveFromTokenResponse(data);
}

// 유효한 access token 반환 (필요 시 자동 갱신). 없거나 갱신 실패 시 throw.
async function getAccessToken() {
  const tok = readTokens();
  if (!tok) throw new Error(`로그인이 필요합니다. ${LOGIN_HINT}`);
  if (tok.access_token && tok.expires_at && tok.expires_at > Date.now() + 60_000) {
    return tok.access_token;
  }
  if (tok.refresh_token) {
    try {
      return (await refreshTokens(tok.refresh_token)).access_token;
    } catch (e) {
      throw new Error(`토큰 갱신 실패(${e.message}). ${LOGIN_HINT}`);
    }
  }
  throw new Error(`로그인이 필요합니다. ${LOGIN_HINT}`);
}

// ── 로그인 (루프백 + PKCE) ────────────────────────────────────────────────────
async function runLogin() {
  const meta = await discover();
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const bad = error || !code || returnedState !== state;
      res.writeHead(bad ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (bad) {
        res.end('<h1>로그인 실패</h1><p>터미널로 돌아가세요.</p>');
        server.close();
        reject(new Error(error ? `authorize 에러: ${error}` : 'code 누락 또는 state 불일치'));
        return;
      }
      res.end('<h1>로그인 완료 ✅</h1><p>이 창을 닫고 터미널로 돌아가세요.</p>');
      server.close();
      resolve({ code, redirectUri });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = new URL(meta.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      process.stderr.write(`\n브라우저에서 로그인하세요:\n${authUrl.toString()}\n\n`);
      openBrowser(authUrl.toString());
    });

    server.on('error', reject);
    setTimeout(() => {
      server.close();
      reject(new Error('로그인 타임아웃(5분).'));
    }, 5 * 60_000).unref?.();
  });

  const data = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
  });
  saveFromTokenResponse(data);
  process.stderr.write(`로그인 완료. 토큰을 ${TOKEN_PATH} 에 저장했습니다.\n`);
}

async function runLogout() {
  const tok = readTokens();
  if (tok?.refresh_token) {
    const meta = await discover();
    await fetch(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tok.refresh_token, client_id: CLIENT_ID }).toString(),
    }).catch(() => {});
  }
  fs.rmSync(TOKEN_PATH, { force: true });
  process.stderr.write('로그아웃 완료.\n');
}

// ── 백엔드 API 호출 ───────────────────────────────────────────────────────────
async function api(pathname, opts = {}) {
  let token = await getAccessToken();
  const call = () =>
    fetch(`${API}${pathname}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      },
    });

  let res = await call();
  if (res.status === 401) {
    // access token 이 만료 직전 갱신을 놓친 경우: 강제 갱신 후 1회 재시도
    const tok = readTokens();
    if (tok?.refresh_token) {
      token = (await refreshTokens(tok.refresh_token)).access_token;
      res = await call();
    }
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({
  content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
  isError: true,
});

// ── MCP 서버 ──────────────────────────────────────────────────────────────────
async function startServer() {
  const server = new McpServer({ name: 'directfeedback', version: '0.2.0' });

  server.registerTool(
    'list_unresolved_comments',
    {
      title: '미해결 코멘트 조회',
      description:
        '내가 속한 그룹의 미해결(OPEN) 코멘트를 URL(urlKey) · selector · 대상 태그/클래스 · 본문과 함께 반환한다. groupId/urlKey 로 좁힐 수 있다. Storybook 은 urlKey 가 story id 라 소스 컴포넌트 grep 에 쓴다.',
      inputSchema: {
        groupId: z.string().optional(),
        urlKey: z.string().optional().describe('예: comment-empty--default'),
      },
    },
    async ({ groupId, urlKey }) => {
      try {
        const groups = groupId
          ? [{ id: groupId, name: groupId }]
          : (await api('/api/groups')).groups || [];
        const out = [];
        for (const g of groups) {
          const qs = new URLSearchParams({ groupId: g.id, status: 'open' });
          if (urlKey) qs.set('urlKey', urlKey);
          const { comments = [] } = await api(`/api/comments?${qs.toString()}`);
          for (const c of comments) {
            out.push({
              id: c.id,
              group: g.name,
              urlKey: c.urlKey,
              pageUrl: c.pageUrl,
              selector: c.cssPath,
              tag: c.tagName,
              classes: c.classList,
              body: c.body,
              author: c.authorName,
              createdAt: c.createdAt,
            });
          }
        }
        return ok({ count: out.length, comments: out });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: '코멘트 해결 처리',
      description: '코멘트를 RESOLVED 로 표시한다 (수정 완료 후).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const r = await api(`/api/comments/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'RESOLVED' }),
        });
        return ok({ resolved: r.comment?.id, status: r.comment?.status });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'add_reply',
    {
      title: '코멘트에 답글',
      description: '코멘트에 답글을 남긴다 (진행 상황/질문 회신).',
      inputSchema: { id: z.string(), body: z.string() },
    },
    async ({ id, body }) => {
      try {
        const r = await api(`/api/comments/${id}/replies`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        return ok({ replyId: r.reply?.id });
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

// ── 엔트리 ────────────────────────────────────────────────────────────────────
const sub = process.argv[2];
try {
  if (sub === 'login') {
    await runLogin();
  } else if (sub === 'logout') {
    await runLogout();
  } else {
    await startServer();
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
