# DirectFeedback MCP

DirectFeedback 백엔드의 **미해결 코멘트**를 Claude Code(및 MCP 지원 에이전트)에 노출하는
stdio MCP 서버. 에이전트가 "어느 화면(story)의 어느 엘리먼트에 무슨 피드백이 있는지"를
조회 → 소스 컴포넌트를 찾아 고치고 → 해결 처리하는 루프를 만든다.

> DirectFeedback = Chrome 확장(캡처) + 백엔드(polymorph `apps/direct-feedback`) + 이 MCP.
> 설계: `polymorph-app/docs/directfeedback-design.md`.

## 인증 (OAuth 2.1 + PKCE)

이 MCP 는 **어떤 비밀값도 보관하지 않는다.** oauth-server(`oauth.polymorph.co.kr`)에
Authorization Code + PKCE(루프백 리다이렉트)로 로그인해 **본인 계정의 스코프 제한 토큰**을 받는다.

```bash
# 최초 1회: 브라우저 로그인 → 토큰을 ~/.config/directfeedback-mcp/tokens.json 에 저장
npx @polym-team/directfeedback-mcp login

# 로그아웃 (refresh token 폐기 + 로컬 토큰 삭제)
npx @polym-team/directfeedback-mcp logout
```

이후 MCP 서버는 저장된 access token 을 쓰고, 만료되면 refresh token 으로 **자동 갱신**한다.
refresh token 은 회전(rotation)되며, 탈취로 재사용이 감지되면 세션 전체가 폐기된다.

## 도구(tools)

| tool | 설명 |
|---|---|
| `list_unresolved_comments({ groupId?, urlKey? })` | 내 그룹의 OPEN 코멘트를 URL(urlKey)·selector·태그/클래스·본문과 함께 반환. Storybook 은 urlKey 가 story id 라 소스 grep 에 사용. |
| `resolve_comment({ id })` | 코멘트를 RESOLVED 로 표시(수정 완료 후). |
| `add_reply({ id, body })` | 코멘트에 답글(진행상황/질문). |

## 환경변수

| 변수 | 설명 |
|---|---|
| `DIRECTFEEDBACK_API` | 백엔드 base URL (기본 `https://directfeedback.polymorph.co.kr`) |
| `OAUTH_ISSUER` | oauth-server base URL (기본 `https://oauth.polymorph.co.kr`) |

> 로컬 백엔드로 붙일 땐 `DIRECTFEEDBACK_API=http://localhost:3008`,
> `OAUTH_ISSUER=http://localhost:3007` 로 지정.

## Claude Code 연결

먼저 `npx @polym-team/directfeedback-mcp login` 으로 로그인한 뒤:

```bash
claude mcp add directfeedback -- npx -y @polym-team/directfeedback-mcp
```

또는 프로젝트 `.mcp.json`:

```json
{
  "mcpServers": {
    "directfeedback": {
      "command": "npx",
      "args": ["-y", "@polym-team/directfeedback-mcp"]
    }
  }
}
```

> 비밀값이 없으므로 `.mcp.json` 을 커밋해도 안전하다.

## 사용 흐름 (에이전트)

1. `list_unresolved_comments` → 미해결 목록 확보 (각 항목에 urlKey=story id + selector + body).
2. urlKey(story id)로 저장소에서 스토리/컴포넌트 소스를 grep → 해당 엘리먼트 수정.
3. `resolve_comment({ id })` 로 완료 표시 (또는 `add_reply` 로 회신).

> "로그인이 필요합니다" 오류가 나면 `npx @polym-team/directfeedback-mcp login` 을 다시 실행.
