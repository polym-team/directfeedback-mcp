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

  server.registerTool(
    'create_comment',
    {
      title: '스토리에 코멘트 생성',
      description:
        'Storybook 스토리에 새 피드백 코멘트를 남긴다. 용도: 디자이너/리뷰어에게 "이 스토리의 이 점을 ' +
        '확인·수정해달라"는 역방향 요청이나 확인 노트. ⚠️ 이 도구는 코드를 고치지 않는다 — 수정은 소스를 ' +
        '직접 편집하는 것이고, 이건 사람에게 남기는 메모다. 기본은 스토리 레벨 코멘트이며, 특정 엘리먼트를 ' +
        '가리키려면 cssPath를 함께 준다. urlKey·body·pageUrl은 필수(pageUrl은 버전/빌드 추적용 정확한 주소). ' +
        '한 코멘트에 이슈 하나만 담고, 명확하고 실행 가능하게 작성하며 ' +
        '같은 내용을 중복 생성하지 말 것. 생성 전 본문을 사용자에게 확인받는 것을 권장한다.',
      inputSchema: {
        urlKey: z
          .string()
          .describe(
            '대상 Storybook 스토리 id. 형식 "<kebab-경로>--<variant>" 예 "pages-mediacontents-mobile--default". ' +
              '스토리 소스(제목/파일 경로)에서 도출하거나 list_unresolved_comments 결과의 urlKey를 참고.',
          ),
        body: z
          .string()
          .describe('리뷰어가 읽을 피드백 본문. 무엇을·왜를 명확하고 실행 가능하게, 프로젝트 언어(한국어)로.'),
        groupId: z
          .string()
          .optional()
          .describe(
            '대상 그룹 id. 그룹이 하나뿐이면 생략 시 자동 선택되고, 둘 이상이면 반드시 지정(임의 선택 금지).',
          ),
        cssPath: z
          .string()
          .optional()
          .describe(
            '(선택) 특정 엘리먼트 CSS 선택자. 컴포넌트 소스에서 확인되는 data-testid나 안정 클래스 기반의 ' +
              '확실한 선택자만 사용. 렌더된 DOM을 확신할 수 없으면 생략(스토리 레벨). 추측 selector 금지 — ' +
              '틀린 앵커보다 앵커 없음이 낫다.',
          ),
        tagName: z
          .string()
          .optional()
          .describe('(선택) cssPath 대상 태그명(소문자). cssPath를 줄 때 함께.'),
        pageUrl: z
          .string()
          .describe(
            '필수. 코멘트 대상 스토리의 정확한 Storybook URL — 버전/브랜치/빌드번호가 담긴 실제 주소를 그대로 기록한다. ' +
              '이래야 나중에 "그 빌드에서 이미 고쳐졌는지" 추적이 된다. 보통 "<스토리북 base>?path=/story/<urlKey>" 형태. ' +
              '예 "https://host/.../2.2.2-<branch>/16/index.html?path=/story/components-foo--default". ' +
              '사용자가 준 스토리북 주소나 현재 보고 있는 스토리북 URL을 사용하고, 모르면 사용자에게 물어볼 것.',
          ),
      },
    },
    async ({ urlKey, body, groupId, cssPath, tagName, pageUrl }) => {
      try {
        let gid = groupId;
        if (!gid) {
          const groups = (await api('/api/groups')).groups || [];
          if (groups.length === 0) throw new Error('속한 그룹이 없습니다.');
          if (groups.length > 1) {
            throw new Error(
              '그룹이 여러 개입니다. groupId를 지정하세요: ' +
                groups.map((g) => `${g.name}(${g.id})`).join(', '),
            );
          }
          gid = groups[0].id;
        }
        const payload = { groupId: gid, urlKey, body, pageUrl };
        if (cssPath) payload.cssPath = cssPath;
        if (tagName) payload.tagName = tagName;
        const r = await api('/api/comments', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        return ok({ created: r.comment?.id, urlKey, anchored: !!cssPath });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_tobe',
    {
      title: '스토리의 To-Be 변경 조회',
      description:
        '디자이너가 특정 Storybook 스토리에 그린 To-Be(원본 대비 변경)를 구조화해 반환한다. ' +
        '각 변경은 {selector, kind(style|text|class), property?, from, to} 형태 — 이걸 읽어 해당 컴포넌트 소스에 반영하면 된다. ' +
        'version 은 캡처된 스토리북 빌드(버전/브랜치/빌드번호)라 "그 빌드 기준" 변경임을 알 수 있다. ' +
        '변경이 없으면 changeCount 0. (참고: kind=style 은 인라인 오버라이드이니 소스에선 해당 selector에 그 속성을 반영)',
      inputSchema: {
        urlKey: z
          .string()
          .describe(
            '대상 Storybook 스토리 id (예: "components-channelview-channelsubscribecard--default"). ' +
              'list_unresolved_comments 결과의 urlKey 참고.',
          ),
        groupId: z
          .string()
          .optional()
          .describe('그룹이 하나뿐이면 생략, 둘 이상이면 지정(임의 선택 금지).'),
      },
    },
    async ({ urlKey, groupId }) => {
      try {
        let gid = groupId;
        if (!gid) {
          const groups = (await api('/api/groups')).groups || [];
          if (groups.length === 0) throw new Error('속한 그룹이 없습니다.');
          if (groups.length > 1) {
            throw new Error(
              '그룹이 여러 개입니다. groupId를 지정하세요: ' +
                groups.map((g) => `${g.name}(${g.id})`).join(', '),
            );
          }
          gid = groups[0].id;
        }
        const qs = new URLSearchParams({ groupId: gid, urlKey });
        return ok(await api(`/api/snapshots/diff?${qs.toString()}`));
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
