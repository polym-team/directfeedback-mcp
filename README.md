# DirectFeedback MCP

DirectFeedback 백엔드의 **미해결 코멘트**를 Claude Code(및 MCP 지원 에이전트)에 노출하는
stdio MCP 서버. 에이전트가 "어느 화면(story)의 어느 엘리먼트에 무슨 피드백이 있는지"를
조회 → 소스 컴포넌트를 찾아 고치고 → 해결 처리하는 루프를 만든다.

> DirectFeedback = Chrome 확장(캡처) + 백엔드(polymorph `apps/direct-feedback`) + 이 MCP.
> 설계: `polymorph-app/docs/directfeedback-design.md`.

## 도구(tools)

| tool | 설명 |
|---|---|
| `list_unresolved_comments({ groupId?, urlKey? })` | 내 그룹의 OPEN 코멘트를 URL(urlKey)·selector·태그/클래스·본문과 함께 반환. Storybook 은 urlKey 가 story id 라 소스 grep 에 사용. |
| `resolve_comment({ id })` | 코멘트를 RESOLVED 로 표시(수정 완료 후). |
| `add_reply({ id, body })` | 코멘트에 답글(진행상황/질문). |

## 환경변수

| 변수 | 설명 |
|---|---|
| `DIRECTFEEDBACK_API` | 백엔드 base URL (기본 `http://localhost:3008`) |
| `OAUTH_JWT_SECRET` | 백엔드/oauth 와 동일한 HS256 시크릿 (토큰 mint 용) |
| `DIRECTFEEDBACK_EMAIL` | 그룹 멤버 이메일 — 이 신원으로 조회(멤버십은 email 로 매칭) |
| `DIRECTFEEDBACK_SUB` | (선택) sub, 기본 `mcp:<email>` |
| `DIRECTFEEDBACK_TOKEN` | (선택) mint 대신 직접 지정할 JWT (있으면 우선) |

토큰은 호출마다 새로 mint(1h) 되어 만료 걱정이 없다. 시크릿을 두기 싫으면 확장에서 얻은
JWT 를 `DIRECTFEEDBACK_TOKEN` 으로 넣어도 된다(만료 시 교체).

## Claude Code 연결

**user 스코프(권장, 커밋 안 됨):**
```bash
claude mcp add directfeedback \
  -e DIRECTFEEDBACK_API=http://localhost:3008 \
  -e OAUTH_JWT_SECRET=<백엔드 .env 의 값> \
  -e DIRECTFEEDBACK_EMAIL=<그룹 멤버 이메일> \
  -- node /Users/rootbeer.axz-pc/Documents/project/directfeedback-mcp/index.mjs
```

**또는 프로젝트 `.mcp.json`** (시크릿 포함되므로 gitignore 권장):
```json
{
  "mcpServers": {
    "directfeedback": {
      "command": "node",
      "args": ["/Users/rootbeer.axz-pc/Documents/project/directfeedback-mcp/index.mjs"],
      "env": {
        "DIRECTFEEDBACK_API": "http://localhost:3008",
        "OAUTH_JWT_SECRET": "…",
        "DIRECTFEEDBACK_EMAIL": "you@example.com"
      }
    }
  }
}
```

## 사용 흐름 (에이전트)

1. `list_unresolved_comments` → 미해결 목록 확보 (각 항목에 urlKey=story id + selector + body).
2. urlKey(story id)로 저장소에서 스토리/컴포넌트 소스를 grep → 해당 엘리먼트 수정.
3. `resolve_comment({ id })` 로 완료 표시 (또는 `add_reply` 로 회신).

> 백엔드가 로컬(3008)이면 그 서버가 떠 있어야 한다. 배포 시 `DIRECTFEEDBACK_API` 를
> `https://directfeedback.polymorph.co.kr` 로.
