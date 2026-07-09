#!/usr/bin/env node
// DirectFeedback MCP 서버 (stdio) — 미해결 코멘트를 Claude Code 에 노출.
//
// 환경변수:
//   DIRECTFEEDBACK_API     백엔드 base URL (기본 http://localhost:3008)
//   OAUTH_JWT_SECRET       HS256 시크릿 (백엔드/oauth 와 동일) — 토큰 mint 용
//   DIRECTFEEDBACK_EMAIL   그룹 멤버 이메일 (이 신원으로 조회; 멤버십은 email 로 매칭)
//   DIRECTFEEDBACK_SUB     (선택) sub, 기본 "mcp:<email>"
//   DIRECTFEEDBACK_TOKEN   (선택) mint 대신 직접 지정할 JWT (있으면 우선)
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.DIRECTFEEDBACK_API || 'http://localhost:3008';

function mintToken() {
  if (process.env.DIRECTFEEDBACK_TOKEN) return process.env.DIRECTFEEDBACK_TOKEN;
  const secret = process.env.OAUTH_JWT_SECRET;
  const email = process.env.DIRECTFEEDBACK_EMAIL;
  if (!secret || !email) {
    throw new Error(
      'DIRECTFEEDBACK_TOKEN, 또는 OAUTH_JWT_SECRET + DIRECTFEEDBACK_EMAIL 이 필요합니다',
    );
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data =
    b64({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    b64({
      sub: process.env.DIRECTFEEDBACK_SUB || `mcp:${email}`,
      email,
      name: 'DirectFeedback MCP',
      provider: 'mcp',
      clientId: 'direct-feedback',
      iss: 'oauth.polymorph.co.kr',
      iat: now,
      exp: now + 3600,
    });
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${mintToken()}`,
      ...(opts.headers || {}),
    },
  });
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

const ok = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
  isError: true,
});

const server = new McpServer({ name: 'directfeedback', version: '0.1.0' });

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
